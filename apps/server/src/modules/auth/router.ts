import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signToken } from "../../lib/auth.js";
import { env } from "../../config/env.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import {
  createAuthSession,
  findUserById,
  findUserByUsername,
  revokeAuthSessionByRefreshTokenHash,
  rotateAuthSession,
} from "../../lib/db.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  createRefreshToken,
  getRefreshCookieOptions,
  hashRefreshToken,
  readCookie,
} from "../../lib/session-token.js";
import type { UserRecord } from "../../types/domain.js";

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

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...getRefreshCookieOptions(env.isProduction),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieOptions(env.isProduction));
}

function buildAuthResponse(user: UserRecord, sessionId: string) {
  return {
    token: signToken({
      userId: user.id,
      role: user.role,
      sessionId,
    }),
    accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
      balance: user.balance,
    },
  };
}

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

authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

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

  const sessionId = randomUUID();
  const refreshToken = createRefreshToken();
  await createAuthSession({
    id: sessionId,
    userId: user.id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
  });
  setRefreshCookie(res, refreshToken);

  return res.json(buildAuthResponse(user, sessionId));
});

authRouter.post("/refresh", async (req, res) => {
  const currentRefreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
  if (!currentRefreshToken) {
    clearRefreshCookie(res);
    return res.status(401).json({ message: "Session expired" });
  }

  const nextRefreshToken = createRefreshToken();
  const session = await rotateAuthSession({
    currentRefreshTokenHash: hashRefreshToken(currentRefreshToken),
    nextRefreshTokenHash: hashRefreshToken(nextRefreshToken),
  });

  if (!session) {
    clearRefreshCookie(res);
    return res.status(401).json({ message: "Session expired" });
  }

  const user = await findUserById(session.userId);
  if (!user || !user.isActive) {
    await revokeAuthSessionByRefreshTokenHash(hashRefreshToken(nextRefreshToken));
    clearRefreshCookie(res);
    return res.status(401).json({ message: "Session expired" });
  }

  setRefreshCookie(res, nextRefreshToken);
  return res.json(buildAuthResponse(user, session.id));
});

authRouter.post("/logout", async (req, res) => {
  const refreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
  const session = refreshToken
    ? await revokeAuthSessionByRefreshTokenHash(hashRefreshToken(refreshToken))
    : null;
  clearRefreshCookie(res);

  if (session) {
    await publishLiveEvent({
      type: "session_revoked",
      sessionId: session.id,
      userId: session.userId,
      reason: "logout",
      at: new Date().toISOString(),
    });
  }

  return res.status(204).send();
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
