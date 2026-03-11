import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/auth.js";
import type { UserRecord } from "../types/domain.js";

export type AuthenticatedRequest = Request & {
  user?: JwtPayload;
  currentUser?: UserRecord;
};

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : queryToken;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}
