import { Router } from "express";
import { z } from "zod";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { requireRole } from "../../lib/auth.js";
import {
  buildLobbyTables,
  buildTablePublicState,
  buildTableUserState,
  claimIdempotencyKey,
  completeIdempotencyKey,
  createBet,
  findTableById,
  findUserById,
  getActiveRound,
  listUserHistory,
  listUserRoundBets,
  updateUserBalance,
  withTransaction,
} from "../../lib/db.js";
import { fingerprintIdempotencyRequest, parseIdempotencyKey } from "../../lib/idempotency.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { getRoundConfig } from "../../lib/round-manager.js";
import { betTypes } from "../../types/domain.js";

const placeBetSchema = z.object({
  bets: z
    .array(
      z.object({
        betType: z.enum(betTypes),
        amount: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(20),
});
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
  const tableId = String(req.params.tableId);
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
  const parsed = placeBetSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid bet payload" });
  }

  const requestedIdempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key"));
  if (!requestedIdempotencyKey) {
    return res.status(400).json({ message: "A valid Idempotency-Key header is required" });
  }
  const idempotencyKey: string = requestedIdempotencyKey;

  const tableId = String(req.params.tableId);
  const scope = `game.bet:${tableId}`;
  const requestHash = fingerprintIdempotencyRequest({ tableId, bets: parsed.data.bets });
  const actorId = req.currentUser!.id;

  const result = await withTransaction(async (client) => {
    const totalBet = parsed.data.bets.reduce((sum, bet) => sum + bet.amount, 0);
    const claim = await claimIdempotencyKey<Record<string, unknown>>(
      { actorId, scope, key: idempotencyKey, requestHash },
      client,
    );

    if (claim.kind === "replay") {
      return { statusCode: claim.statusCode, body: claim.response } as const;
    }

    if (claim.kind === "conflict") {
      return {
        statusCode: 409,
        body: { message: "Idempotency-Key was already used for a different request" },
      } as const;
    }

    async function fail(statusCode: number, message: string) {
      const body = { message };
      await completeIdempotencyKey(
        { actorId, scope, key: idempotencyKey, requestHash, statusCode, response: body },
        client,
      );
      return { statusCode, body } as const;
    }

    const table = await findTableById(tableId, client);

    if (!table) {
      return fail(404, "Table not found");
    }

    const activeRound = await getActiveRound(table.id, client, { forUpdate: true });

    if (!activeRound || activeRound.status !== "OPEN") {
      return fail(400, "Betting is closed");
    }

    const now = Date.now();
    if (now < new Date(activeRound.bettingOpensAt).getTime() - BETTING_OPEN_GRACE_MS) {
      return fail(400, "Betting is closed");
    }

    if (now >= new Date(activeRound.bettingClosesAt).getTime()) {
      return fail(400, "Betting is closed");
    }

    if (parsed.data.bets.some((bet) => bet.amount < table.minBet)) {
      return fail(400, `Minimum bet is ${table.minBet}`);
    }

    const user = await findUserById(req.currentUser!.id, client, { forUpdate: true });
    if (!user) {
      return fail(404, "User not found");
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
        return fail(400, `單一玩法最高下注 ${table.maxBet}`);
      }
    }

    if (user.balance < totalBet) {
      return fail(400, "Insufficient balance");
    }

    const updatedUser = await updateUserBalance(user.id, user.balance - totalBet, client);
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

    const body = {
      table,
      round: activeRound,
      bets,
      balance: updatedUser.balance,
    };
    await publishLiveEvent(
      {
        type: "user_changed",
        userId: user.id,
        reason: "bet_placed",
        at: new Date().toISOString(),
      },
      client,
    );
    await completeIdempotencyKey(
      { actorId, scope, key: idempotencyKey, requestHash, statusCode: 200, response: body },
      client,
    );

    return { statusCode: 200, body } as const;
  });

  return res.status(result.statusCode).json(result.body);
});
