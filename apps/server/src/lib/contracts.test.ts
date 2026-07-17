import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    getHeader(name: string) {
      return name.toLowerCase() === "x-request-id" ? "contract-test-request" : undefined;
    },
  } as Response;

  return { response, state };
}

describe("server contract responses", () => {
  it("returns validated response data", () => {
    const { response, state } = createResponse();
    const payload = {
      token: "jwt",
      accessTokenExpiresAt: "2026-07-16T10:15:00.000Z",
      user: { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 100 },
    };

    sendContractResponse(response, "auth.login", loginResponseSchema, payload);

    assert.equal(state.status, 200);
    assert.deepEqual(state.payload, payload);
  });

  it("fails closed and logs only schema diagnostics for invalid output", () => {
    const { response, state } = createResponse();
    const secret = "must-not-be-logged-response-value";
    const logs: unknown[][] = [];
    const contractLogger = {
      error: (...args: unknown[]) => logs.push(args),
    };

    sendContractResponse(response, "auth.login", loginResponseSchema, {
      token: secret,
      accessTokenExpiresAt: "2026-07-16T10:15:00.000Z",
      user: { id: "user-1", username: "player", role: secret, isActive: true, balance: 100 },
    }, 200, contractLogger);

    assert.equal(state.status, 500);
    assert.deepEqual(state.payload, {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId: "contract-test-request",
    });
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.match(JSON.stringify(logs), /auth\.login/);
  });
});
