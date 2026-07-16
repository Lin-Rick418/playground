import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "./session-token.js";

export type JwtPayload = {
  userId: string;
  role: "PLAYER";
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
  const payload = jwt.verify(token, env.jwtSecret, {
    algorithms: ["HS256"],
    audience: "baccarat-web",
    issuer: "baccarat-api",
  }) as Partial<JwtPayload>;

  if (
    typeof payload.userId !== "string" ||
    typeof payload.sessionId !== "string" ||
    payload.role !== "PLAYER"
  ) {
    throw new jwt.JsonWebTokenError("Invalid player token payload");
  }

  return payload as JwtPayload;
}
