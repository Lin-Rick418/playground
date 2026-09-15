import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { clearStoredToken, getStoredToken } from "../lib/settings";
import { useAuthStore } from "./auth";

const user = { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 100 } as const;
const loginResponse = {
  token: "access-token",
  accessTokenExpiresAt: "2026-07-17T12:00:00.000Z",
  user,
};

beforeEach(() => {
  setActivePinia(createPinia());
  clearStoredToken();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  clearStoredToken();
});

describe("auth store", () => {
  it("persists a successful login and exposes failures to the login form", async () => {
    const store = useAuthStore();
    vi.spyOn(api, "post").mockResolvedValueOnce({ data: loginResponse });

    await expect(store.login("player", "secret")).resolves.toEqual(user);
    expect(store.user).toEqual(user);
    expect(store.loading).toBe(false);
    expect(store.initialized).toBe(true);
    expect(getStoredToken()).toBe("access-token");

    vi.spyOn(api, "post").mockRejectedValueOnce(new Error("denied"));
    await expect(store.login("player", "wrong")).rejects.toThrow("denied");
    expect(store.error).toBe("登入失敗，請確認帳號密碼。");
    expect(store.loading).toBe(false);
  });

  it("reuses a sufficiently fresh token and refreshes one near expiry", async () => {
    const store = useAuthStore();
    store.token = "current-token";
    store.accessTokenExpiresAt = "2026-07-17T10:02:00.000Z";
    const post = vi.spyOn(api, "post");

    await expect(store.ensureFreshAccessToken()).resolves.toBe("current-token");
    expect(post).not.toHaveBeenCalled();

    store.accessTokenExpiresAt = "2026-07-17T10:00:10.000Z";
    post.mockResolvedValueOnce({ data: loginResponse });
    await expect(store.ensureFreshAccessToken()).resolves.toBe("access-token");
    expect(store.user).toEqual(user);
  });

  it("clears state when session restoration fails and logout is safe offline", async () => {
    const store = useAuthStore();
    vi.spyOn(api, "post").mockRejectedValue(new Error("offline"));
    store.token = "stale";

    await expect(store.restoreSession()).resolves.toBeNull();
    expect(store.initialized).toBe(true);
    expect(store.token).toBe("");
    expect(store.user).toBeNull();
    expect(getStoredToken()).toBe("");

    store.logout();
    expect(store.initialized).toBe(true);
    expect(store.error).toBe("");
  });

  it("invalidates a replaced session without logging out the new browser session", () => {
    const store = useAuthStore();
    const post = vi.spyOn(api, "post");
    store.token = "replaced-token";
    store.user = user;

    store.invalidateSession("此帳號已在其他裝置登入，您已被登出。");

    expect(post).not.toHaveBeenCalled();
    expect(store.token).toBe("");
    expect(store.user).toBeNull();
    expect(store.initialized).toBe(true);
    expect(store.error).toBe("此帳號已在其他裝置登入，您已被登出。");
    expect(getStoredToken()).toBe("");
  });

  it("does not let a late wallet refresh overwrite a newer live snapshot", async () => {
    const store = useAuthStore();
    let resolveRequest!: (value: { data: unknown }) => void;
    vi.spyOn(api, "get").mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));

    const request = store.fetchMe({ preserveNewerLiveSnapshot: true });
    store.setUser({ ...user, balance: 999.75 });
    resolveRequest({ data: { ...user, balance: 900 } });

    await expect(request).resolves.toMatchObject({ balance: 999.75 });
    expect(store.user?.balance).toBe(999.75);
  });

  it("uses walletVersion to accept a newer HTTP value after a live update and reject older balances", () => {
    const store = useAuthStore();
    store.setUser({ ...user, balance: 800, walletVersion: 4 });
    store.applyUserSnapshot({ ...user, balance: 900, walletVersion: 5 });
    expect(store.user?.balance).toBe(900);
    store.patchBalance(700, 4);
    expect(store.user?.balance).toBe(900);
    store.patchBalance(999, 6);
    expect(store.user).toMatchObject({ balance: 999, walletVersion: 6 });
    expect(store.walletVersion).toBe(6);
  });
});

it("ignores an account snapshot that completes after a different login", async () => {
  const store = useAuthStore();
  store.setUser({ ...user, walletVersion: 1 });
  store.token = "first-token";
  let resolve!: (value: { data: unknown }) => void;
  vi.spyOn(api, "get").mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const pending = store.fetchMe({ preserveNewerLiveSnapshot: true });
  store.setUser({ ...user, id: "other-user", balance: 500, walletVersion: 2 });
  store.token = "second-token";
  resolve({ data: { ...user, balance: 9999, walletVersion: 100 } });
  await pending;
  expect(store.user).toMatchObject({ id: "other-user", balance: 500, walletVersion: 2 });
});
