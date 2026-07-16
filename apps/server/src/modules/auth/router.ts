import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { signToken } from "../../lib/auth.js";
import { env } from "../../config/env.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import {
  createAuthSession,
  findUserById,
  findUserByUsername,
  pool,
  revokeAuthSessionByRefreshTokenHash,
  rotateAuthSession,
} from "../../lib/db.js";
import {
  createLoginRateLimitAttempt,
  LoginRateLimiter,
} from "../../lib/login-rate-limit.js";
import { verifyLoginPassword } from "../../lib/login-password.js";
import { PostgresLoginRateLimitStore } from "../../lib/postgres-login-rate-limit-store.js";
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
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1),
});

const loginRateLimiter = new LoginRateLimiter(new PostgresLoginRateLimitStore(pool));

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

export const authRouter = Router();

authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

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
