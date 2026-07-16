import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/auth.js";
import { validatePersistedSession } from "../lib/authorization-state.js";
import { findUserById } from "../lib/db.js";
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
    return res.status(401).json({ message: "Unauthorized" });
  }

  let payload: JwtPayload;

  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    const decision = validatePersistedSession(await findUserById(payload.userId));

    if (!decision.authorized) {
      return res.status(decision.httpStatus).json({ message: decision.message });
    }

    // Canonicalize both request identities from the database. The JWT role is
    // a login-time claim and must never authorize the current request.
    req.user = { userId: decision.user.id, role: decision.user.role };
    req.currentUser = decision.user;
    return next();
  } catch (error) {
    return next(error);
  }
}
