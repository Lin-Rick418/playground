import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireRole } from "../../lib/auth.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import {
  createBalanceAdjustment,
  createPlayer,
  findRoundById,
  findUserById,
  findUserByUsername,
  listAdjustments,
  listRoundBetsDetailed,
  listUsers,
  setUserActive,
  updateUserBalance,
} from "../../lib/db.js";
import { publishUserUpdate } from "../../lib/live-updates.js";

const adjustBalanceSchema = z.object({
  userId: z.string().min(1),
  amount: z.number().int(),
  note: z.string().max(200).optional(),
});

const createPlayerSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(50),
  balance: z.number().int().min(0).default(0),
});

const setUserActiveSchema = z.object({
  userId: z.string().min(1),
  isActive: z.boolean(),
});

export const adminRouter = Router();

adminRouter.use(authenticate);
adminRouter.use((req, res, next) => requireRole(req as AuthenticatedRequest, res, next, "ADMIN"));

adminRouter.get("/users", async (_req, res) => {
  return res.json(listUsers());
});

adminRouter.get("/adjustments", async (_req, res) => {
  return res.json(listAdjustments());
});

adminRouter.get("/rounds/:roundId/bets", async (req, res) => {
  const round = findRoundById(req.params.roundId);

  if (!round) {
    return res.status(404).json({ message: "Round not found" });
  }

  return res.json({
    round,
    bets: listRoundBetsDetailed(round.id),
  });
});

adminRouter.post("/players", async (req, res) => {
  const parsed = createPlayerSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  if (findUserByUsername(parsed.data.username)) {
    return res.status(400).json({ message: "Username already exists" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = createPlayer({
    username: parsed.data.username,
    passwordHash,
    balance: parsed.data.balance,
  });

  return res.status(201).json(user);
});

adminRouter.post("/users/set-active", async (req, res) => {
  const parsed = setUserActiveSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const targetUser = findUserById(parsed.data.userId);

  if (!targetUser) {
    return res.status(404).json({ message: "Target user not found" });
  }

  if (targetUser.role === "ADMIN") {
    return res.status(400).json({ message: "Admin account cannot be disabled here" });
  }

  const user = setUserActive(targetUser.id, parsed.data.isActive);
  publishUserUpdate(targetUser.id, "user_active_changed");
  return res.json(user);
});

adminRouter.post("/adjust-balance", async (req: AuthenticatedRequest, res) => {
  const parsed = adjustBalanceSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const targetUser = findUserById(parsed.data.userId);

  if (!targetUser) {
    return res.status(404).json({ message: "Target user not found" });
  }

  if (targetUser.balance + parsed.data.amount < 0) {
    return res.status(400).json({ message: "Balance cannot be negative" });
  }

  const user = updateUserBalance(targetUser.id, targetUser.balance + parsed.data.amount);
  const adjustment = createBalanceAdjustment({
    adminId: req.currentUser!.id,
    userId: targetUser.id,
    amount: parsed.data.amount,
    note: parsed.data.note,
  });

  publishUserUpdate(targetUser.id, "balance_adjusted");

  return res.json({ user, adjustment });
});
