import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/auth.js";
import { isAuthSessionActive } from "../lib/db.js";
import type { UserRecord } from "../types/domain.js";

export type AuthenticatedRequest = Request & {
  user?: JwtPayload;
  currentUser?: UserRecord;
};

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // Tokens are accepted from the Authorization header only: query-string
  // tokens end up in access logs and browser history.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const payload = verifyToken(token);
    return isAuthSessionActive(payload.sessionId)
      .then((isActive) => {
        if (!isActive) {
          return res.status(401).json({ message: "Session expired" });
        }

        req.user = payload;
        next();
      })
      .catch(next);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}
