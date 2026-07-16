import jwt from "jsonwebtoken";
import { z } from "zod";
import type { Response, NextFunction } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/authenticate.js";
import { userRoles, type UserRole } from "../types/domain.js";

export type JwtPayload = {
  userId: string;
  role: UserRole;
  authVersion: number;
};

const jwtPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(userRoles),
    authVersion: z.number().int().nonnegative().refine(Number.isSafeInteger),
  })
  .passthrough();

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
}

export function verifyToken(token: string) {
  return jwtPayloadSchema.parse(jwt.verify(token, env.jwtSecret)) as JwtPayload;
}

export function requireRole(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  role: UserRole,
) {
  if (!req.currentUser || req.currentUser.role !== role) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
}
