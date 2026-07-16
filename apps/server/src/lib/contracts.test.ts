import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { loginResponseSchema } from "@baccarat/contracts";
import type { Response } from "express";
import { sendContractResponse } from "./contracts.js";

function createResponse() {
  const state: { status?: number; payload?: unknown } = {};
  const response = {
    status(status: number) {
      state.status = status;
      return response;
    },
    json(payload: unknown) {
      state.payload = payload;
      return response;
    },
  } as Response;

  return { response, state };
}

describe("server contract responses", () => {
  it("returns validated response data", () => {
    const { response, state } = createResponse();
    const payload = {
      token: "jwt",
      user: { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 100 },
    };

    sendContractResponse(response, "auth.login", loginResponseSchema, payload);

    assert.equal(state.status, 200);
    assert.deepEqual(state.payload, payload);
  });

  it("fails closed and logs only schema diagnostics for invalid output", () => {
    const { response, state } = createResponse();
    const secret = "must-not-be-logged-response-value";
    const consoleError = mock.method(console, "error", () => undefined);

    try {
      sendContractResponse(response, "auth.login", loginResponseSchema, {
        token: secret,
        user: { id: "user-1", username: "player", role: secret, isActive: true, balance: 100 },
      });

      assert.equal(state.status, 500);
      assert.deepEqual(state.payload, { message: "Internal server error" });
      assert.equal(consoleError.mock.callCount(), 1);
      assert.ok(!JSON.stringify(consoleError.mock.calls).includes(secret));
      assert.match(JSON.stringify(consoleError.mock.calls), /auth\.login/);
    } finally {
      consoleError.mock.restore();
    }
  });
});
