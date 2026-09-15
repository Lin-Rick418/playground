import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocketCallbacks } from "../lib/live";
import { api } from "../lib/api";

const mocks = vi.hoisted(() => ({
  createLiveSocket: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("../lib/live", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live")>()),
  createLiveSocket: mocks.createLiveSocket,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

import { useLiveChannel } from "./useLiveChannel";
import { useAuthStore } from "../stores/auth";

type FakeSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function mountChannel() {
  return mount(
    defineComponent({
      setup() {
        useLiveChannel({
          getSubscribeMessage: () => ({ type: "subscribe_lobby" }),
          onMessage: vi.fn(),
        });
        return () => h("div");
      },
    }),
    { global: { plugins: [createPinia()] } },
  );
}

function fakeSocket(): FakeSocket {
  return { send: vi.fn(), close: vi.fn() };
}

function callbackAt(index: number) {
  return mocks.createLiveSocket.mock.calls[index]![0] as SocketCallbacks;
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  mocks.createLiveSocket.mockImplementation(() => fakeSocket());
  vi.spyOn(api, "post").mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveChannel", () => {
  it("does not reconnect after unmount while token refresh is still pending", async () => {
    const wrapper = mountChannel();
    let finish!: (token: string) => void;
    vi.spyOn(useAuthStore(), "ensureFreshAccessToken").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    callbackAt(0).onClose?.();
    wrapper.unmount();
    finish("token");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
  });

  it("ignores a superseded socket's close and messages after reconnect", async () => {
    const wrapper = mountChannel();
    const auth = useAuthStore();
    vi.spyOn(auth, "ensureFreshAccessToken").mockResolvedValue("token");
    const invalidate = vi.spyOn(auth, "invalidateSession");
    callbackAt(0).onClose?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.createLiveSocket).toHaveBeenCalledTimes(2);
    callbackAt(0).onMessage({ type: "auth_revoked", reason: "signed_in_elsewhere" });
    callbackAt(0).onClose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.createLiveSocket).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("refreshes the session and reconnects with bounded exponential backoff", async () => {
    const wrapper = mountChannel();
    const authStore = useAuthStore();
    const ensureFresh = vi.spyOn(authStore, "ensureFreshAccessToken").mockResolvedValue("token");

    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    callbackAt(0).onClose?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureFresh).toHaveBeenCalledOnce();
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.createLiveSocket).toHaveBeenCalledTimes(2);

    callbackAt(1).onClose?.();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.createLiveSocket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.createLiveSocket).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it("stops reconnecting and returns to login when the server revokes authorization", async () => {
    const wrapper = mountChannel();
    const authStore = useAuthStore();
    const invalidateSession = vi.spyOn(authStore, "invalidateSession");

    callbackAt(0).onMessage({ type: "auth_revoked", reason: "signed_in_elsewhere" });

    expect(invalidateSession).toHaveBeenCalledWith("此帳號已在其他裝置登入，您已被登出。");
    expect(mocks.routerPush).toHaveBeenCalledWith("/login");
    callbackAt(0).onClose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("treats the session-invalid error as terminal instead of reconnecting", async () => {
    const wrapper = mountChannel();
    const authStore = useAuthStore();
    const invalidateSession = vi.spyOn(authStore, "invalidateSession");

    callbackAt(0).onMessage({ type: "error", message: "Session is no longer valid" });

    expect(invalidateSession).toHaveBeenCalledWith("登入狀態已失效，請重新登入。");
    expect(mocks.routerPush).toHaveBeenCalledWith("/login");
    callbackAt(0).onClose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("keeps the wallet version from user snapshots so stale balances are rejected", () => {
    const wrapper = mountChannel();
    const authStore = useAuthStore();
    authStore.setUser({
      id: "player",
      username: "player",
      role: "PLAYER",
      isActive: true,
      balance: 500,
      walletVersion: 4,
    });

    callbackAt(0).onMessage({
      type: "user_snapshot",
      data: {
        id: "player",
        username: "player",
        role: "PLAYER",
        isActive: true,
        balance: 750,
        walletVersion: 5,
        serverTime: "2026-09-14T10:00:00.000Z",
      },
    });
    expect(authStore.user).toMatchObject({ balance: 750, walletVersion: 5 });
    callbackAt(0).onMessage({
      type: "user_snapshot",
      data: {
        id: "player",
        username: "player",
        role: "PLAYER",
        isActive: true,
        balance: 600,
        walletVersion: 4,
        serverTime: "2026-09-14T10:00:01.000Z",
      },
    });
    expect(authStore.user).toMatchObject({ balance: 750, walletVersion: 5 });
    wrapper.unmount();
  });
});
