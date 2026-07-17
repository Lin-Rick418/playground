import { describe, expect, it, vi } from "vitest";
import { loginResponseSchema } from "@baccarat/contracts";
import { ContractValidationError, parseRuntimeContract } from "./contracts.js";
import { parseLiveMessage } from "./live.js";

describe("web response contract validation", () => {
  it("returns typed data only after runtime validation", () => {
    const payload = {
      token: "jwt",
      accessTokenExpiresAt: "2026-07-16T10:15:00.000Z",
      user: { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 100 },
    };

    const parsed = parseRuntimeContract(loginResponseSchema, payload, "POST /auth/login");
    expect(parsed).toEqual(payload);
  });

  it("fails closed with diagnostics and never logs response values", () => {
    const secret = "response-secret-must-stay-redacted";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(() =>
        parseRuntimeContract(
          loginResponseSchema,
          {
            token: secret,
            accessTokenExpiresAt: "2026-07-16T10:15:00.000Z",
            user: { id: "user-1", username: "player", role: secret, isActive: true, balance: 100 },
          },
          "POST /auth/login",
        ),
      ).toThrow(ContractValidationError);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(JSON.stringify(consoleError.mock.calls)).toMatch(/POST \/auth\/login/);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("validates decoded WebSocket messages and redacts malformed payloads", () => {
    const serverTime = "2026-07-16T10:00:00.000Z";
    expect(parseLiveMessage(JSON.stringify({ type: "connected", serverTime }))).toEqual({
      type: "connected",
      serverTime,
    });

    const secret = "live-payload-value-must-not-be-logged";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(() => parseLiveMessage(JSON.stringify({ type: "connected", serverTime: "invalid", secret }))).toThrow(
        ContractValidationError,
      );
      expect(consoleError).toHaveBeenCalledOnce();
      expect(JSON.stringify(consoleError.mock.calls)).toMatch(/server\.live\.message/);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });
});
