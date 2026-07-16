import { Router } from "express";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { requireRole } from "../../lib/auth.js";
import {
  buildLobbyTables,
  buildTablePublicState,
  buildTableUserState,
  createBet,
  findTableById,
  findUserById,
  getActiveRound,
  listUserHistory,
  listUserRoundBets,
  updateUserBalance,
  withTransaction,
} from "../../lib/db.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { getRoundConfig } from "../../lib/round-manager.js";
import {
  getMaximumPayout,
  getSafeBalanceAfterChange,
  isValidBetForTable,
  isValidTableMoneyPolicy,
  MAX_ACCOUNT_BALANCE,
  placeBetSchema,
  tableIdParamsSchema,
} from "../../lib/account-policy.js";
const BETTING_OPEN_GRACE_MS = 400;

export const gameRouter = Router();

gameRouter.use(authenticate);
gameRouter.use((req, res, next) => requireRole(req as AuthenticatedRequest, res, next, "PLAYER"));

gameRouter.get("/lobby", async (_req, res) => {
  const tables = await buildLobbyTables();

  return res.json({
    tables,
    config: getRoundConfig(),
    serverTime: new Date().toISOString(),
  });
});

gameRouter.get("/tables/:tableId/state", async (req: AuthenticatedRequest, res) => {
  const params = tableIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ message: "Invalid table id" });
  }
  const tableId = params.data.tableId;
  const publicState = await buildTablePublicState(tableId);

  if (!publicState) {
    return res.status(404).json({ message: "Table not found" });
  }

  if (!publicState.round) {
    return res.status(503).json({ message: "No active round for table" });
  }

  const userState = await buildTableUserState(req.currentUser!.id, tableId);

  return res.json({
    ...publicState,
    myBets: userState.myBets,
    balance: userState.balance,
    config: getRoundConfig(),
  });
});

gameRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  return res.json(await listUserHistory(req.currentUser!.id));
});

gameRouter.post("/tables/:tableId/bet", async (req: AuthenticatedRequest, res) => {
  const params = tableIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ message: "Invalid table id" });
  }
  const parsed = placeBetSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid bet payload" });
  }

  const result = await withTransaction(async (client) => {
    const totalBet = parsed.data.bets.reduce((sum, bet) => sum + bet.amount, 0);
    const tableId = params.data.tableId;
    const table = await findTableById(tableId, client);

    if (!table) {
      return { error: { status: 404, message: "Table not found" } } as const;
    }

    const activeRound = await getActiveRound(table.id, client, { forUpdate: true });

    if (!activeRound || activeRound.status !== "OPEN") {
      return { error: { status: 400, message: "Betting is closed" } } as const;
    }

    const now = Date.now();
    if (now < new Date(activeRound.bettingOpensAt).getTime() - BETTING_OPEN_GRACE_MS) {
      return { error: { status: 400, message: "Betting is closed" } } as const;
    }

    if (now >= new Date(activeRound.bettingClosesAt).getTime()) {
      return { error: { status: 400, message: "Betting is closed" } } as const;
    }

    if (!isValidTableMoneyPolicy(table.minBet, table.maxBet)) {
      return { error: { status: 503, message: "Table betting policy is invalid" } } as const;
    }

    if (parsed.data.bets.some((bet) => !isValidBetForTable(bet.amount, table.minBet, table.maxBet))) {
      return {
        error: {
          status: 400,
          message: `Each bet must be between ${table.minBet} and ${table.maxBet} in supported denominations`,
        },
      } as const;
    }

    const user = await findUserById(req.currentUser!.id, client, { forUpdate: true });
    if (!user) {
      return { error: { status: 404, message: "User not found" } } as const;
    }
    if (!user.isActive || user.role !== "PLAYER") {
      return { error: { status: 403, message: "Account is not allowed to bet" } } as const;
    }

    const existingRoundBets = await listUserRoundBets(user.id, activeRound.id, client);
    const existingBetTotals = new Map<string, number>();
    const incomingBetTotals = new Map<string, number>();

    for (const bet of existingRoundBets) {
      existingBetTotals.set(bet.betType, (existingBetTotals.get(bet.betType) ?? 0) + bet.amount);
    }

    for (const bet of parsed.data.bets) {
      incomingBetTotals.set(bet.betType, (incomingBetTotals.get(bet.betType) ?? 0) + bet.amount);
    }

    for (const [betType, incomingAmount] of incomingBetTotals.entries()) {
      if ((existingBetTotals.get(betType) ?? 0) + incomingAmount > table.maxBet) {
        return { error: { status: 400, message: `單一玩法最高下注 ${table.maxBet}` } } as const;
      }
    }

    if (user.balance < totalBet) {
      return { error: { status: 400, message: "Insufficient balance" } } as const;
    }

    const balanceAfterStake = getSafeBalanceAfterChange(user.balance, -totalBet);
    if (balanceAfterStake === null) {
      return { error: { status: 400, message: "Bet would make balance invalid" } } as const;
    }
    const maximumPayout = [...existingRoundBets, ...parsed.data.bets].reduce(
      (sum, bet) => sum + getMaximumPayout(bet.betType, bet.amount),
      0,
    );
    if (!Number.isSafeInteger(maximumPayout) || balanceAfterStake + maximumPayout > MAX_ACCOUNT_BALANCE) {
      return { error: { status: 400, message: "Bet could exceed the supported account balance" } } as const;
    }

    const updatedUser = await updateUserBalance(user.id, balanceAfterStake, client);
    const bets = [];

    for (const bet of parsed.data.bets) {
      bets.push(
        await createBet(
          {
            userId: user.id,
            roundId: activeRound.id,
            betType: bet.betType,
            amount: bet.amount,
          },
          client,
        ),
      );
    }

    return {
      table,
      round: activeRound,
      bets,
      balance: updatedUser.balance,
      userId: user.id,
    } as const;
  });

  if ("error" in result && result.error) {
    return res.status(result.error.status).json({ message: result.error.message });
  }

  await publishLiveEvent({
    type: "user_changed",
    userId: result.userId,
    reason: "bet_placed",
    at: new Date().toISOString(),
  });

  return res.json({
    table: result.table,
    round: result.round,
    bets: result.bets,
    balance: result.balance,
  });
});
