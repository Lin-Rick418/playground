import jwt from "jsonwebtoken";
import type { Response, NextFunction } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/authenticate.js";
import { hasRequiredRole } from "./authorization-state.js";
import type { UserRole } from "../types/domain.js";

export type JwtPayload = {
  userId: string;
  role: UserRole;
};

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.jwtSecret) as JwtPayload;
}

export function requireRole(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  role: UserRole,
) {
  if (!hasRequiredRole(req.currentUser, role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  return next();
}
