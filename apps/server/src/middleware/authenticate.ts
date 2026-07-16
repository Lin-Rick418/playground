import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/auth.js";
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
    const user = await findUserById(payload.userId);
    if (!user || !user.isActive || user.authVersion !== payload.authVersion) {
      return res.status(401).json({ message: "Session is no longer valid" });
    }
    req.user = payload;
    req.currentUser = user;
    next();
  } catch (error) {
    next(error);
  }
}
