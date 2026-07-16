import assert from "node:assert/strict";
import test from "node:test";
import type { UserRecord } from "../types/domain.js";
import { toPublicUser } from "./public-user.js";

test("public user DTO never serializes the password hash", () => {
  const user: UserRecord = {
    id: "user-1",
    username: "player1",
    passwordHash: "$2b$10$sensitive-hash",
    role: "PLAYER",
    isActive: true,
    balance: 500,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };

  const publicUser = toPublicUser(user);

  assert.deepEqual(publicUser, {
    id: "user-1",
    username: "player1",
    role: "PLAYER",
    isActive: true,
    balance: 500,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal("passwordHash" in publicUser, false);
  assert.equal(JSON.stringify(publicUser).includes("sensitive-hash"), false);
});
