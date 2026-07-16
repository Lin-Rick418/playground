import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/auth.js";
import { validatePersistedSession } from "../lib/authorization-state.js";
import { findUserById, isAuthSessionActive } from "../lib/db.js";
import { sendApiError } from "../lib/api-errors.js";
import type { UserRecord } from "../types/domain.js";

export type AuthenticatedRequest = Request & {
  user?: JwtPayload;
  currentUser?: UserRecord;
};

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // Tokens are accepted from the Authorization header only: query-string
  // tokens end up in access logs and browser history.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    return sendApiError(req, res, 401, "AUTHENTICATION_REQUIRED", "Authentication is required");
  }

  let payload: JwtPayload;

  try {
    payload = verifyToken(token);
  } catch {
    return sendApiError(req, res, 401, "INVALID_TOKEN", "Invalid token");
  }

  try {
    const [sessionActive, persistedUser] = await Promise.all([
      isAuthSessionActive(payload.sessionId),
      findUserById(payload.userId),
    ]);

    if (!sessionActive) {
      return sendApiError(req, res, 401, "INVALID_TOKEN", "Session expired");
    }

    const decision = validatePersistedSession(persistedUser);

    if (!decision.authorized) {
      const code =
        decision.reason === "account_disabled"
          ? "ACCOUNT_DISABLED"
          : decision.reason === "role_changed"
            ? "FORBIDDEN"
            : "INVALID_TOKEN";
      return sendApiError(
        req,
        res,
        decision.httpStatus,
        code,
        decision.message,
      );
    }

    // Canonicalize both request identities from the database. The JWT role is
    // a login-time claim and must never authorize the current request.
    req.user = { userId: decision.user.id, role: decision.user.role, sessionId: payload.sessionId };
    req.currentUser = decision.user;
    return next();
  } catch (error) {
    return next(error);
  }
}
