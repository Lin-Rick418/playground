import { Router } from "express";
import { z } from "zod";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { requireRole } from "../../lib/auth.js";
import {
  createBet,
  findTableById,
  getActiveRound,
  getTableShoe,
  listRecentSettledRounds,
  listRecentSettledRoundsByShoe,
  listTables,
  listUserHistory,
  listUserRoundBets,
  updateUserBalance,
} from "../../lib/db.js";
import { openLobbyStream, openTableStream } from "../../lib/live-updates.js";
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
    .min(1),
});
const BETTING_OPEN_GRACE_MS = 400;

export const gameRouter = Router();

gameRouter.use(authenticate);
gameRouter.use((req, res, next) => requireRole(req as AuthenticatedRequest, res, next, "PLAYER"));

gameRouter.get("/stream/lobby", async (req: AuthenticatedRequest, res) => {
  openLobbyStream(req.currentUser!.id, res);
});

gameRouter.get("/stream/tables/:tableId", async (req: AuthenticatedRequest, res) => {
  const tableId = String(req.params.tableId);
  const table = findTableById(tableId);

  if (!table) {
    return res.status(404).json({ message: "Table not found" });
  }

  openTableStream(req.currentUser!.id, table.id, res);
});

gameRouter.get("/lobby", async (_req, res) => {
  const tables = listTables().map((table) => {
    const recentRounds = listRecentSettledRounds(table.id, 30);
    const activeRound = getActiveRound(table.id);
    const previousRound = recentRounds[0] ?? null;
    const roadRounds = activeRound ? listRecentSettledRoundsByShoe(table.id, activeRound.shoeId, 200) : [];

    return {
      table,
      activeRound,
      previousRound,
      recentRounds: recentRounds.slice(0, 6),
      roadRounds,
    };
  });

  return res.json({
    tables,
    config: getRoundConfig(),
    serverTime: new Date().toISOString(),
  });
});

gameRouter.get("/tables/:tableId/state", async (req: AuthenticatedRequest, res) => {
  const tableId = String(req.params.tableId);
  const table = findTableById(tableId);

  if (!table) {
    return res.status(404).json({ message: "Table not found" });
  }

  const activeRound = getActiveRound(table.id);
  const recentRounds = listRecentSettledRounds(table.id, 24);
  const previousRound = recentRounds[0] ?? null;
  const roadRounds = activeRound ? listRecentSettledRoundsByShoe(table.id, activeRound.shoeId, 200) : [];
  const shoe = getTableShoe(table.id);

  if (!activeRound) {
    return res.status(503).json({ message: "No active round for table" });
  }

  return res.json({
    table,
    round: activeRound,
    previousRound,
    presentation: previousRound?.settledAt
      ? {
          startsAt: previousRound.settledAt,
          endsAt: activeRound.bettingOpensAt,
        }
      : null,
    recentRounds,
    roadRounds,
    myBets: listUserRoundBets(req.currentUser!.id, activeRound.id),
    balance: req.currentUser!.balance,
    shoeStatus: {
      isLastHand: Boolean(shoe?.lastHandPending),
      cutCardReached: Boolean(shoe?.cutCardReached),
    },
    config: getRoundConfig(),
    serverTime: new Date().toISOString(),
  });
});

gameRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  return res.json(listUserHistory(req.currentUser!.id));
});

gameRouter.post("/tables/:tableId/bet", async (req: AuthenticatedRequest, res) => {
  const parsed = placeBetSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid bet payload" });
  }

  const totalBet = parsed.data.bets.reduce((sum, bet) => sum + bet.amount, 0);
  const tableId = String(req.params.tableId);
  const table = findTableById(tableId);

  if (!table) {
    return res.status(404).json({ message: "Table not found" });
  }

  const activeRound = getActiveRound(table.id);

  if (!activeRound || activeRound.status !== "OPEN") {
    return res.status(400).json({ message: "Betting is closed" });
  }

  if (Date.now() < new Date(activeRound.bettingOpensAt).getTime() - BETTING_OPEN_GRACE_MS) {
    return res.status(400).json({ message: "Betting is closed" });
  }

  if (Date.now() >= new Date(activeRound.bettingClosesAt).getTime()) {
    return res.status(400).json({ message: "Betting is closed" });
  }

  if (parsed.data.bets.some((bet) => bet.amount < table.minBet)) {
    return res.status(400).json({ message: `Minimum bet is ${table.minBet}` });
  }

  const existingRoundBets = listUserRoundBets(req.currentUser!.id, activeRound.id);
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
      return res.status(400).json({ message: `單一玩法最高下注 ${table.maxBet}` });
    }
  }

  if (req.currentUser!.balance < totalBet) {
    return res.status(400).json({ message: "Insufficient balance" });
  }

  const updatedUser = updateUserBalance(req.currentUser!.id, req.currentUser!.balance - totalBet);

  const bets = parsed.data.bets.map((bet) => {
    return createBet({
      userId: req.currentUser!.id,
      roundId: activeRound.id,
      betType: bet.betType,
      amount: bet.amount,
    });
  });

  return res.json({
    table,
    round: activeRound,
    bets,
    balance: updatedUser?.balance ?? req.currentUser!.balance - totalBet,
  });
});
