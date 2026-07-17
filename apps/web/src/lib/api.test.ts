import MockAdapter from "axios-mock-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { api, sessionApi } from "./api";
import { clearStoredToken, getStoredToken, setStoredToken } from "./settings";

const unauthorized = { code: "AUTHENTICATION_REQUIRED", message: "Authentication required", requestId: "request-1" };
const user = { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 100 } as const;

afterEach(() => {
  clearStoredToken();
});

describe("API session refresh", () => {
  it("consolidates concurrent 401 responses into one refresh and retries both requests", async () => {
    const apiMock = new MockAdapter(api);
    const sessionMock = new MockAdapter(sessionApi, { delayResponse: 10 });
    let protectedCalls = 0;
    setStoredToken("expired-token");

    apiMock.onGet("/protected").reply((config) => {
      protectedCalls++;
      return config.headers?.Authorization === "Bearer refreshed-token"
        ? [200, { ok: true }]
        : [401, unauthorized];
    });
    sessionMock.onPost("/auth/refresh").reply(200, {
      token: "refreshed-token",
      accessTokenExpiresAt: "2026-07-17T12:00:00.000Z",
      user,
    });

    try {
      const [first, second] = await Promise.all([api.get("/protected"), api.get("/protected")]);
      expect(first.data).toEqual({ ok: true });
      expect(second.data).toEqual({ ok: true });
      expect(sessionMock.history.post).toHaveLength(1);
      expect(protectedCalls).toBe(4);
      expect(getStoredToken()).toBe("refreshed-token");
    } finally {
      apiMock.restore();
      sessionMock.restore();
    }
  });

  it("retries a request only once when the refreshed token is still rejected", async () => {
    const apiMock = new MockAdapter(api);
    const sessionMock = new MockAdapter(sessionApi);
    apiMock.onGet("/protected").reply(401, unauthorized);
    sessionMock.onPost("/auth/refresh").reply(200, {
      token: "still-invalid",
      accessTokenExpiresAt: "2026-07-17T12:00:00.000Z",
      user,
    });

    try {
      await expect(api.get("/protected")).rejects.toMatchObject({ response: { status: 401 } });
      expect(sessionMock.history.post).toHaveLength(1);
      expect(apiMock.history.get).toHaveLength(2);
    } finally {
      apiMock.restore();
      sessionMock.restore();
    }
  });
});
