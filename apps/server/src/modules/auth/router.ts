import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { loginRequestSchema, loginResponseSchema, userSchema } from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { sendApiError } from "../../lib/api-errors.js";
import {
  changePasswordSchema,
  getPasswordPolicyViolation,
  PASSWORD_BCRYPT_ROUNDS,
} from "../../lib/account-policy.js";
import { signToken } from "../../lib/auth.js";
import { sendContractResponse } from "../../lib/contracts.js";
import {
  createAuthSession,
  findUserById,
  findUserByUsername,
  pool,
  revokeAuthSessionByRefreshTokenHash,
  revokeAuthSessionsByUserId,
  rotateAuthSession,
  updateUserPasswordHash,
  withTransaction,
} from "../../lib/db.js";
import {
  createLoginRateLimitAttempt,
  LoginRateLimiter,
} from "../../lib/login-rate-limit.js";
import { verifyLoginPassword } from "../../lib/login-password.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { PostgresLoginRateLimitStore } from "../../lib/postgres-login-rate-limit-store.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  createRefreshToken,
  getRefreshCookieOptions,
  hashRefreshToken,
  readCookie,
} from "../../lib/session-token.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import type { UserRecord } from "../../types/domain.js";

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
    token: signToken({ userId: user.id, role: user.role, sessionId }),
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
  const parsed = loginRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid login payload");
  }

  const attempt = createLoginRateLimitAttempt(parsed.data.username, req.ip);
  const existingLimit = await loginRateLimiter.inspect(attempt);
  if (existingLimit.hardBlocked) {
    await verifyLoginPassword(parsed.data.password, undefined);
    return sendApiError(req, res, 429, "RATE_LIMITED", "Too many login attempts, try again later");
  }

  const user = await findUserByUsername(parsed.data.username);
  const isValid = await verifyLoginPassword(parsed.data.password, user?.passwordHash);
  if (!user || !isValid) {
    const failureLimit = await loginRateLimiter.recordFailure(attempt);
    if (failureLimit.limitedScopes.length > 0) {
      return sendApiError(req, res, 429, "RATE_LIMITED", "Too many login attempts, try again later");
    }
    return sendApiError(req, res, 401, "INVALID_CREDENTIALS", "Invalid credentials");
  }

  await loginRateLimiter.recordSuccess(attempt);
  if (!user.isActive) {
    return sendApiError(req, res, 403, "ACCOUNT_DISABLED", "Account is disabled");
  }
  if (user.role !== "PLAYER") {
    return sendApiError(req, res, 403, "FORBIDDEN", "Account is not available in the player application");
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
  return sendContractResponse(res, "auth.login", loginResponseSchema, buildAuthResponse(user, sessionId));
});

authRouter.post("/refresh", async (req, res) => {
  const currentRefreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
  if (!currentRefreshToken) {
    return sendApiError(req, res, 401, "INVALID_TOKEN", "Session expired");
  }

  const nextRefreshToken = createRefreshToken();
  const session = await rotateAuthSession({
    currentRefreshTokenHash: hashRefreshToken(currentRefreshToken),
    nextRefreshTokenHash: hashRefreshToken(nextRefreshToken),
  });

  // A losing concurrent refresh must not clear the cookie written by the
  // request that successfully rotated the same token.
  if (!session) {
    return sendApiError(req, res, 401, "INVALID_TOKEN", "Session expired");
  }

  const user = await findUserById(session.userId);
  if (!user || !user.isActive || user.role !== "PLAYER") {
    await revokeAuthSessionByRefreshTokenHash(hashRefreshToken(nextRefreshToken));
    clearRefreshCookie(res);
    return sendApiError(req, res, 401, "INVALID_TOKEN", "Session expired");
  }

  setRefreshCookie(res, nextRefreshToken);
  return sendContractResponse(res, "auth.refresh", loginResponseSchema, buildAuthResponse(user, session.id));
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
  const user = req.currentUser;
  if (!user) {
    return sendApiError(req, res, 401, "INVALID_TOKEN", "Unauthorized");
  }
  if (user.role !== "PLAYER") {
    return sendApiError(req, res, 403, "FORBIDDEN", "Account is not available in the player application");
  }
  return sendContractResponse(res, "auth.me", userSchema, {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    balance: user.balance,
  });
});

authRouter.post("/change-password", authenticate, async (req: AuthenticatedRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid password payload");
  }

  const nextSessionId = randomUUID();
  const nextRefreshToken = createRefreshToken();
  const result = await withTransaction(async (client) => {
    const user = await findUserById(req.currentUser!.id, client, { forUpdate: true });
    if (!user || !user.isActive || user.role !== "PLAYER") {
      return { error: { status: 401, code: "INVALID_TOKEN", message: "Session is no longer valid" } } as const;
    }

    const violation = getPasswordPolicyViolation(parsed.data.newPassword, user.username);
    if (violation) {
      return { error: { status: 400, code: "VALIDATION_ERROR", message: violation } } as const;
    }
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      return { error: { status: 401, code: "INVALID_CREDENTIALS", message: "Current password is incorrect" } } as const;
    }

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, PASSWORD_BCRYPT_ROUNDS);
    const updatedUser = await updateUserPasswordHash(user.id, passwordHash, client);
    const revokedSessions = await revokeAuthSessionsByUserId(user.id, client);
    await createAuthSession(
      {
        id: nextSessionId,
        userId: user.id,
        refreshTokenHash: hashRefreshToken(nextRefreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
      },
      client,
    );

    await publishLiveEvent(
      { type: "user_changed", userId: user.id, reason: "password_changed", at: new Date().toISOString() },
      client,
    );
    for (const session of revokedSessions) {
      await publishLiveEvent(
        {
          type: "session_revoked",
          sessionId: session.id,
          userId: session.userId,
          reason: "password_changed",
          at: new Date().toISOString(),
        },
        client,
      );
    }
    return { user: updatedUser } as const;
  });

  if ("error" in result && result.error) {
    return sendApiError(req, res, result.error.status, result.error.code, result.error.message);
  }

  setRefreshCookie(res, nextRefreshToken);
  return sendContractResponse(res, "auth.change-password", loginResponseSchema, buildAuthResponse(result.user, nextSessionId));
});
