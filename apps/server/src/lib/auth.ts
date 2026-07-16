import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { Response, NextFunction } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/authenticate.js";
import { findUserById } from "./db.js";
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
  if (!req.user || req.user.role !== role) {
    return res.status(403).json({ message: "Forbidden" });
  }

  return findUserById(req.user.userId)
    .then((freshUser) => {
      if (!freshUser) {
        return res.status(401).json({ message: "User not found" });
      }

      if (!freshUser.isActive) {
        return res.status(403).json({ message: "Account is disabled" });
      }

      req.currentUser = freshUser;
      next();
    })
    .catch(next);
}
