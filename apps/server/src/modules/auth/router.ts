import { Router } from "express";
import bcrypt from "bcryptjs";
import { signToken } from "../../lib/auth.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { findUserById, findUserByUsername, updateUserPasswordHash, withTransaction } from "../../lib/db.js";
import {
  changePasswordSchema,
  getPasswordPolicyViolation,
  loginSchema,
  PASSWORD_BCRYPT_ROUNDS,
  toSafeUser,
} from "../../lib/account-policy.js";
import { publishLiveEvent } from "../../lib/live-events.js";

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_ATTEMPTS_PRUNE_THRESHOLD = 10_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

// Equalizes bcrypt timing for unknown usernames so response time does not
// reveal whether an account exists.
const dummyPasswordHash = bcrypt.hashSync("Login!Timing2026", PASSWORD_BCRYPT_ROUNDS);

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
    return res.status(429).json({ message: "Too many login attempts, try again later" });
  }

  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid login payload" });
  }

  const user = await findUserByUsername(parsed.data.username);
  const isValid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? dummyPasswordHash);

  if (!user || !isValid) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  // Only revealed after the password is verified, so it cannot be used to
  // enumerate accounts.
  if (!user.isActive) {
    return res.status(403).json({ message: "Account is disabled" });
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
    authVersion: user.authVersion,
  });

  return res.json({
    token,
    user: toSafeUser(user),
  });
});

authRouter.get("/me", authenticate, (req: AuthenticatedRequest, res) => {
  return res.json(toSafeUser(req.currentUser!));
});

authRouter.post("/change-password", authenticate, async (req: AuthenticatedRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid password payload", issues: parsed.error.flatten().fieldErrors });
  }

  const result = await withTransaction(async (client) => {
    const user = await findUserById(req.currentUser!.id, client, { forUpdate: true });
    if (!user || !user.isActive || user.authVersion !== req.currentUser!.authVersion) {
      return { error: { status: 401, message: "Session is no longer valid" } } as const;
    }
    const violation = getPasswordPolicyViolation(parsed.data.newPassword, user.username);
    if (violation) {
      return { error: { status: 400, message: violation } } as const;
    }
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      return { error: { status: 401, message: "Current password is incorrect" } } as const;
    }
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, PASSWORD_BCRYPT_ROUNDS);
    const updatedUser = await updateUserPasswordHash(user.id, passwordHash, client);
    await publishLiveEvent(
      { type: "user_changed", userId: updatedUser.id, reason: "password_changed", at: new Date().toISOString() },
      client,
    );
    return { user: updatedUser } as const;
  });
  if ("error" in result && result.error) {
    return res.status(result.error.status).json({ message: result.error.message });
  }
  const updatedUser = result.user;
  return res.json({
    token: signToken({ userId: updatedUser.id, role: updatedUser.role, authVersion: updatedUser.authVersion }),
    user: toSafeUser(updatedUser),
  });
});
