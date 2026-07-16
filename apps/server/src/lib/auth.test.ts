import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { signToken, verifyToken } from "./auth.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "./session-token.js";

test("access tokens bind the user to a short-lived server session", () => {
  const token = signToken({ userId: "user-1", role: "PLAYER", sessionId: "session-1" });
  const payload = verifyToken(token) as ReturnType<typeof verifyToken> & {
    aud: string;
    iss: string;
    iat: number;
    exp: number;
    jti: string;
  };

  assert.equal(payload.userId, "user-1");
  assert.equal(payload.sessionId, "session-1");
  assert.equal(payload.aud, "baccarat-web");
  assert.equal(payload.iss, "baccarat-api");
  assert.equal(payload.exp - payload.iat, ACCESS_TOKEN_TTL_SECONDS);
  assert.ok(payload.jti);
});

test("access token verification rejects a different audience", () => {
  const token = signToken({ userId: "user-1", role: "PLAYER", sessionId: "session-1" });

  assert.throws(() => jwt.verify(token, env.jwtSecret, { audience: "another-app" }));
});
