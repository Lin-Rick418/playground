import assert from "node:assert/strict";
import test from "node:test";
import {
  validatePersistedSession,
  validatePlayerWebSocketSession,
  type AuthorizationUser,
} from "./authorization-state.js";

const activePlayer: AuthorizationUser = {
  id: "user-1",
  role: "PLAYER",
  isActive: true,
};

test("player HTTP authorization uses the persisted role instead of a stale token claim", () => {
  const staleToken = { userId: activePlayer.id, role: "ADMIN" as const };
  const session = validatePersistedSession(activePlayer);

  assert.equal(session.authorized, true);
  assert.equal(session.authorized && session.user.id, staleToken.userId);
  assert.notEqual(session.authorized && session.user.role, staleToken.role);
});

test("authenticated HTTP sessions consistently reject deactivated and deleted users", () => {
  assert.deepEqual(validatePersistedSession({ ...activePlayer, isActive: false }), {
    authorized: false,
    reason: "account_disabled",
    httpStatus: 403,
    message: "Account is disabled",
  });
  assert.deepEqual(validatePersistedSession(null), {
    authorized: false,
    reason: "user_deleted",
    httpStatus: 401,
    message: "Unauthorized",
  });
});

test("connected WebSocket sessions are revoked after demotion or deactivation", () => {
  assert.deepEqual(validatePlayerWebSocketSession("ADMIN", activePlayer), {
    authorized: false,
    reason: "role_changed",
    httpStatus: 401,
    message: "Authorization changed",
  });
  assert.equal(
    validatePlayerWebSocketSession("PLAYER", { ...activePlayer, isActive: false }).authorized,
    false,
  );
  assert.equal(validatePlayerWebSocketSession("PLAYER", null).authorized, false);
});

test("WebSocket reconnect accepts only an active account whose current role matches the token", () => {
  assert.equal(validatePlayerWebSocketSession("PLAYER", activePlayer).authorized, true);
  assert.equal(validatePlayerWebSocketSession("ADMIN", activePlayer).authorized, false);
  assert.equal(
    validatePlayerWebSocketSession("PLAYER", { ...activePlayer, isActive: false }).authorized,
    false,
  );
  assert.equal(validatePlayerWebSocketSession("PLAYER", null).authorized, false);
  assert.equal(
    validatePlayerWebSocketSession("ADMIN", { ...activePlayer, role: "ADMIN" }).authorized,
    false,
  );
});

test("persisted admin accounts have no player-application authorization", () => {
  assert.deepEqual(validatePersistedSession({ ...activePlayer, role: "ADMIN" }), {
    authorized: false,
    reason: "role_changed",
    httpStatus: 403,
    message: "Account is not available in the player application",
  });
});
