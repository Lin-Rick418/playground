import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { loginResponseSchema } from "@baccarat/contracts";
import { ContractValidationError, parseRuntimeContract } from "./contracts.js";
import { parseLiveMessage } from "./live.js";

describe("web response contract validation", () => {
  it("returns typed data only after runtime validation", () => {
    const payload = {
      token: "jwt",
      user: { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 100 },
    };

    const parsed = parseRuntimeContract(loginResponseSchema, payload, "POST /auth/login");
    assert.deepEqual(parsed, payload);
  });

  it("fails closed with diagnostics and never logs response values", () => {
    const secret = "response-secret-must-stay-redacted";
    const consoleError = mock.method(console, "error", () => undefined);

    try {
      assert.throws(
        () =>
          parseRuntimeContract(
            loginResponseSchema,
            {
              token: secret,
              user: { id: "user-1", username: "player", role: secret, isActive: true, balance: 100 },
            },
            "POST /auth/login",
          ),
        ContractValidationError,
      );
      assert.equal(consoleError.mock.callCount(), 1);
      assert.match(JSON.stringify(consoleError.mock.calls), /POST \/auth\/login/);
      assert.ok(!JSON.stringify(consoleError.mock.calls).includes(secret));
    } finally {
      consoleError.mock.restore();
    }
  });

  it("validates decoded WebSocket messages and redacts malformed payloads", () => {
    const serverTime = "2026-07-16T10:00:00.000Z";
    assert.deepEqual(parseLiveMessage(JSON.stringify({ type: "connected", serverTime })), {
      type: "connected",
      serverTime,
    });

    const secret = "live-payload-value-must-not-be-logged";
    const consoleError = mock.method(console, "error", () => undefined);

    try {
      assert.throws(
        () => parseLiveMessage(JSON.stringify({ type: "connected", serverTime: "invalid", secret })),
        ContractValidationError,
      );
      assert.equal(consoleError.mock.callCount(), 1);
      assert.match(JSON.stringify(consoleError.mock.calls), /server\.live\.message/);
      assert.ok(!JSON.stringify(consoleError.mock.calls).includes(secret));
    } finally {
      consoleError.mock.restore();
    }
  });
});
