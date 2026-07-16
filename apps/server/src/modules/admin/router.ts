import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireRole } from "../../lib/auth.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
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
  withTransaction,
} from "../../lib/db.js";
import { fingerprintIdempotencyRequest, parseIdempotencyKey } from "../../lib/idempotency.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { toPublicUser } from "../../lib/public-user.js";

const adjustBalanceSchema = z.object({
  userId: z.string().min(1),
  amount: z.number().int().refine((amount) => amount !== 0),
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
  return res.json(await listUsers());
});

adminRouter.get("/adjustments", async (_req, res) => {
  return res.json(await listAdjustments());
});

adminRouter.get("/rounds/:roundId/bets", async (req, res) => {
  const round = await findRoundById(req.params.roundId);

  if (!round) {
    return res.status(404).json({ message: "Round not found" });
  }

  return res.json({
    round,
    bets: await listRoundBetsDetailed(round.id),
  });
});

adminRouter.post("/players", async (req, res) => {
  const parsed = createPlayerSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  if (await findUserByUsername(parsed.data.username)) {
    return res.status(400).json({ message: "Username already exists" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await createPlayer({
    username: parsed.data.username,
    passwordHash,
    balance: parsed.data.balance,
  });

  return res.status(201).json(toPublicUser(user));
});

adminRouter.post("/users/set-active", async (req, res) => {
  const parsed = setUserActiveSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const targetUser = await findUserById(parsed.data.userId);

  if (!targetUser) {
    return res.status(404).json({ message: "Target user not found" });
  }

  if (targetUser.role === "ADMIN") {
    return res.status(400).json({ message: "Admin account cannot be disabled here" });
  }

  const user = await setUserActive(targetUser.id, parsed.data.isActive);
  await publishLiveEvent({
    type: "user_changed",
    userId: targetUser.id,
    reason: "user_active_changed",
    at: new Date().toISOString(),
  });
  return res.json(toPublicUser(user));
});

adminRouter.post("/adjust-balance", async (req: AuthenticatedRequest, res) => {
  const parsed = adjustBalanceSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const requestedIdempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key"));
  if (!requestedIdempotencyKey) {
    return res.status(400).json({ message: "A valid Idempotency-Key header is required" });
  }
  const idempotencyKey: string = requestedIdempotencyKey;

  const actorId = req.currentUser!.id;
  const scope = "admin.adjust-balance";
  const requestHash = fingerprintIdempotencyRequest(parsed.data);

  const payload = await withTransaction(async (client) => {
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

    const targetUser = await findUserById(parsed.data.userId, client, { forUpdate: true });

    if (!targetUser) {
      return fail(404, "Target user not found");
    }

    if (targetUser.balance + parsed.data.amount < 0) {
      return fail(400, "Balance cannot be negative");
    }

    const user = await updateUserBalance(targetUser.id, targetUser.balance + parsed.data.amount, client);
    const adjustment = await createBalanceAdjustment(
      {
        adminId: req.currentUser!.id,
        userId: targetUser.id,
        amount: parsed.data.amount,
        note: parsed.data.note,
      },
      client,
    );

    const { passwordHash: _passwordHash, ...publicUser } = user;
    const body = { user: publicUser, adjustment };
    await publishLiveEvent(
      {
        type: "user_changed",
        userId: targetUser.id,
        reason: "balance_adjusted",
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

  return res.status(payload.statusCode).json(payload.body);
});
