import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signToken } from "../../lib/auth.js";
import { sendApiError } from "../../lib/api-errors.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { findUserById, findUserByUsername } from "../../lib/db.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_ATTEMPTS_PRUNE_THRESHOLD = 10_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

// Equalizes bcrypt timing for unknown usernames so response time does not
// reveal whether an account exists.
const dummyPasswordHash = bcrypt.hashSync("login-timing-placeholder", 10);

function isLoginRateLimited(key: string) {
  const now = Date.now();

  if (loginAttempts.size > LOGIN_ATTEMPTS_PRUNE_THRESHOLD) {
    for (const [attemptKey, entry] of loginAttempts) {
      if (now >= entry.resetAt) {
        loginAttempts.delete(attemptKey);
      }
    }
  }

  const entry = loginAttempts.get(key);

  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  if (isLoginRateLimited(req.ip ?? "unknown")) {
    return sendApiError(req, res, 429, "RATE_LIMITED", "Too many login attempts, try again later");
  }

  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid login payload");
  }

  const user = await findUserByUsername(parsed.data.username);
  const isValid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? dummyPasswordHash);

  if (!user || !isValid) {
    return sendApiError(req, res, 401, "INVALID_CREDENTIALS", "Invalid credentials");
  }

  // Only revealed after the password is verified, so it cannot be used to
  // enumerate accounts.
  if (!user.isActive) {
    return sendApiError(req, res, 403, "ACCOUNT_DISABLED", "Account is disabled");
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
    return sendApiError(req, res, 404, "NOT_FOUND", "User not found");
  }

  if (!user.isActive) {
    return sendApiError(req, res, 403, "ACCOUNT_DISABLED", "Account is disabled");
  }

  return res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    balance: user.balance,
  });
});
