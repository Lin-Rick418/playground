import { Router } from "express";
import { z } from "zod";
import { signToken } from "../../lib/auth.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { findUserById, findUserByUsername, pool } from "../../lib/db.js";
import {
  createLoginRateLimitAttempt,
  LoginRateLimiter,
} from "../../lib/login-rate-limit.js";
import { verifyLoginPassword } from "../../lib/login-password.js";
import { PostgresLoginRateLimitStore } from "../../lib/postgres-login-rate-limit-store.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1),
});

const loginRateLimiter = new LoginRateLimiter(new PostgresLoginRateLimitStore(pool));

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid login payload" });
  }

  const attempt = createLoginRateLimitAttempt(parsed.data.username, req.ip);
  const existingLimit = await loginRateLimiter.inspect(attempt);

  if (existingLimit.hardBlocked) {
    // A hard account/account+IP block still performs bcrypt work, but avoids
    // querying the real password hash so known and unknown users look alike.
    await verifyLoginPassword(parsed.data.password, undefined);
    return res.status(429).json({ message: "Too many login attempts, try again later" });
  }

  const user = await findUserByUsername(parsed.data.username);
  const isValid = await verifyLoginPassword(parsed.data.password, user?.passwordHash);

  if (!user || !isValid) {
    const failureLimit = await loginRateLimiter.recordFailure(attempt);

    if (failureLimit.limitedScopes.length > 0) {
      return res.status(429).json({ message: "Too many login attempts, try again later" });
    }

    return res.status(401).json({ message: "Invalid credentials" });
  }

  await loginRateLimiter.recordSuccess(attempt);

  // Only revealed after the password is verified, so it cannot be used to
  // enumerate accounts.
  if (!user.isActive) {
    return res.status(403).json({ message: "Account is disabled" });
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
  });

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
      balance: user.balance,
    },
  });
});

authRouter.get("/me", authenticate, async (req: AuthenticatedRequest, res) => {
  const user = req.user ? await findUserById(req.user.userId) : null;

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  if (!user.isActive) {
    return res.status(403).json({ message: "Account is disabled" });
  }

  return res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    balance: user.balance,
  });
});
