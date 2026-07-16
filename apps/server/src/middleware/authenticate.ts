import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/auth.js";
import { sendApiError } from "../lib/api-errors.js";
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
    return sendApiError(req, res, 401, "AUTHENTICATION_REQUIRED", "Authentication is required");
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch {
    return sendApiError(req, res, 401, "INVALID_TOKEN", "Invalid token");
  }
}
