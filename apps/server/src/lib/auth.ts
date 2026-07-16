import jwt from "jsonwebtoken";
import type { Response, NextFunction } from "express";
import { env } from "../config/env.js";
import type { AuthenticatedRequest } from "../middleware/authenticate.js";
import { findUserById } from "./db.js";
import { sendApiError } from "./api-errors.js";
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
    return sendApiError(req, res, 403, "FORBIDDEN", "Forbidden");
  }

  return findUserById(req.user.userId)
    .then((freshUser) => {
      if (!freshUser) {
        return sendApiError(req, res, 401, "INVALID_TOKEN", "Authenticated user no longer exists");
      }

      if (!freshUser.isActive) {
        return sendApiError(req, res, 403, "ACCOUNT_DISABLED", "Account is disabled");
      }

      req.currentUser = freshUser;
      next();
    })
    .catch(next);
}
