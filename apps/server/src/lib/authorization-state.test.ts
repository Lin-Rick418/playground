import assert from "node:assert/strict";
import test from "node:test";
import {
  hasRequiredRole,
  validatePersistedSession,
  validateWebSocketSession,
  type AuthorizationUser,
} from "./authorization-state.js";

const activePlayer: AuthorizationUser = {
  id: "user-1",
  role: "PLAYER",
  isActive: true,
};

test("privileged HTTP authorization uses the persisted role after demotion", () => {
  const staleToken = { userId: activePlayer.id, role: "ADMIN" as const };
  const session = validatePersistedSession(activePlayer);

  assert.equal(session.authorized, true);
  assert.equal(session.authorized && session.user.id, staleToken.userId);
  assert.notEqual(session.authorized && session.user.role, staleToken.role);
  assert.equal(hasRequiredRole(session.authorized ? session.user : undefined, "ADMIN"), false);
  assert.equal(hasRequiredRole(session.authorized ? session.user : undefined, "PLAYER"), true);
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
  assert.deepEqual(validateWebSocketSession("ADMIN", activePlayer), {
    authorized: false,
    reason: "role_changed",
    httpStatus: 401,
    message: "Authorization changed",
  });
  assert.equal(
    validateWebSocketSession("PLAYER", { ...activePlayer, isActive: false }).authorized,
    false,
  );
  assert.equal(validateWebSocketSession("PLAYER", null).authorized, false);
});

test("WebSocket reconnect accepts only an active account whose current role matches the token", () => {
  assert.equal(validateWebSocketSession("PLAYER", activePlayer).authorized, true);
  assert.equal(validateWebSocketSession("ADMIN", activePlayer).authorized, false);
  assert.equal(
    validateWebSocketSession("PLAYER", { ...activePlayer, isActive: false }).authorized,
    false,
  );
  assert.equal(validateWebSocketSession("PLAYER", null).authorized, false);
});
