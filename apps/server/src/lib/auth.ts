import jwt from "jsonwebtoken";
import type { Response, NextFunction } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/authenticate.js";
import { findUserById } from "./db.js";
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
  if (!req.user || req.user.role !== role) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const freshUser = findUserById(req.user.userId);

  if (!freshUser) {
    return res.status(401).json({ message: "User not found" });
  }

  if (!freshUser.isActive) {
    return res.status(403).json({ message: "Account is disabled" });
  }

  req.currentUser = freshUser;
  next();
}
