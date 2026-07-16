import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireRole } from "../../lib/auth.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import {
  createBalanceAdjustment,
  createPlayer,
  findRoundById,
  findUserById,
  getUserUnsettledMaximumPayout,
  listAdjustments,
  listRoundBetsDetailed,
  listUsers,
  lockActiveAdminIds,
  setUserActive,
  updateUserPasswordHash,
  updateUserBalance,
  withTransaction,
} from "../../lib/db.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import {
  adjustBalanceSchema,
  createPlayerSchema,
  getSafeBalanceAfterChange,
  getPasswordPolicyViolation,
  PASSWORD_BCRYPT_ROUNDS,
  MAX_ACCOUNT_BALANCE,
  resetPasswordSchema,
  roundIdParamsSchema,
  setUserActiveSchema,
  toSafeAdminUser,
  wouldRemoveLastActiveAdmin,
} from "../../lib/account-policy.js";

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

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
  const params = roundIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ message: "Invalid round id" });
  }
  const round = await findRoundById(params.data.roundId);

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

  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, PASSWORD_BCRYPT_ROUNDS);
    const user = await createPlayer({
      username: parsed.data.username,
      passwordHash,
      balance: parsed.data.balance,
    });
    return res.status(201).json(toSafeAdminUser(user));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Username already exists" });
    }
    throw error;
  }
});

adminRouter.post("/users/set-active", async (req, res) => {
  const parsed = setUserActiveSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const result = await withTransaction(async (client) => {
    const activeAdminIds = await lockActiveAdminIds(client);
    const targetUser = await findUserById(parsed.data.userId, client, { forUpdate: true });
    if (!targetUser) {
      return { error: { status: 404, message: "Target user not found" } } as const;
    }
    if (wouldRemoveLastActiveAdmin(targetUser, parsed.data.isActive, activeAdminIds.length)) {
      return { error: { status: 409, message: "The last active admin cannot be disabled" } } as const;
    }
    return { user: await setUserActive(targetUser.id, parsed.data.isActive, client) } as const;
  });
  if ("error" in result && result.error) {
    return res.status(result.error.status).json({ message: result.error.message });
  }
  await publishLiveEvent({
    type: "user_changed",
    userId: result.user.id,
    reason: "user_active_changed",
    at: new Date().toISOString(),
  });
  return res.json(toSafeAdminUser(result.user));
});

adminRouter.post("/players/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid password payload", issues: parsed.error.flatten().fieldErrors });
  }

  const result = await withTransaction(async (client) => {
    const targetUser = await findUserById(parsed.data.userId, client, { forUpdate: true });
    if (!targetUser) {
      return { error: { status: 404, message: "Target user not found" } } as const;
    }
    if (targetUser.role !== "PLAYER") {
      return { error: { status: 403, message: "Admins must change their own password" } } as const;
    }
    const violation = getPasswordPolicyViolation(parsed.data.newPassword, targetUser.username);
    if (violation) {
      return { error: { status: 400, message: violation } } as const;
    }
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, PASSWORD_BCRYPT_ROUNDS);
    const updatedUser = await updateUserPasswordHash(targetUser.id, passwordHash, client);
    await publishLiveEvent(
      { type: "user_changed", userId: updatedUser.id, reason: "password_reset", at: new Date().toISOString() },
      client,
    );
    return { user: updatedUser } as const;
  });
  if ("error" in result && result.error) {
    return res.status(result.error.status).json({ message: result.error.message });
  }
  return res.json({ user: toSafeAdminUser(result.user) });
});

adminRouter.post("/adjust-balance", async (req: AuthenticatedRequest, res) => {
  const parsed = adjustBalanceSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const payload = await withTransaction(async (client) => {
    const targetUser = await findUserById(parsed.data.userId, client, { forUpdate: true });

    if (!targetUser) {
      return { error: { status: 404, message: "Target user not found" } } as const;
    }

    const nextBalance = getSafeBalanceAfterChange(targetUser.balance, parsed.data.amount);
    if (nextBalance === null) {
      return { error: { status: 400, message: "Resulting balance is outside the supported range" } } as const;
    }
    const unsettledMaximumPayout = await getUserUnsettledMaximumPayout(targetUser.id, client);
    if (nextBalance + unsettledMaximumPayout > MAX_ACCOUNT_BALANCE) {
      return { error: { status: 400, message: "Adjustment could make settlement exceed the balance limit" } } as const;
    }

    const user = await updateUserBalance(targetUser.id, nextBalance, client);
    const adjustment = await createBalanceAdjustment(
      {
        adminId: req.currentUser!.id,
        userId: targetUser.id,
        amount: parsed.data.amount,
        note: parsed.data.note,
      },
      client,
    );

    return { user, adjustment, userId: targetUser.id } as const;
  });

  if ("error" in payload && payload.error) {
    return res.status(payload.error.status).json({ message: payload.error.message });
  }

  await publishLiveEvent({
    type: "user_changed",
    userId: payload.userId,
    reason: "balance_adjusted",
    at: new Date().toISOString(),
  });

  return res.json({ user: toSafeAdminUser(payload.user), adjustment: payload.adjustment });
});
