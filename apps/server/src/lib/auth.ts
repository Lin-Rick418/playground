import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { Response, NextFunction } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/authenticate.js";
import { hasRequiredRole } from "./authorization-state.js";
import { sendApiError } from "./api-errors.js";
import type { UserRole } from "../types/domain.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "./session-token.js";

export type JwtPayload = {
  userId: string;
  role: UserRole;
  sessionId: string;
};

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, env.jwtSecret, {
    algorithm: "HS256",
    audience: "baccarat-web",
    issuer: "baccarat-api",
    jwtid: randomUUID(),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.jwtSecret, {
    algorithms: ["HS256"],
    audience: "baccarat-web",
    issuer: "baccarat-api",
  }) as JwtPayload;
}

export function requireRole(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  role: UserRole,
) {
  if (!hasRequiredRole(req.currentUser, role)) {
    return sendApiError(req, res, 403, "FORBIDDEN", "Forbidden");
  }

  return next();
}
