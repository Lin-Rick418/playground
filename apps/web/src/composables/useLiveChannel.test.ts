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
    const logout = vi.spyOn(authStore, "logout");

    callbackAt(0).onMessage({ type: "auth_revoked", reason: "account_disabled" });

    expect(logout).toHaveBeenCalledOnce();
    expect(mocks.routerPush).toHaveBeenCalledWith("/login");
    callbackAt(0).onClose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("treats the session-invalid error as terminal instead of reconnecting", async () => {
    const wrapper = mountChannel();
    const authStore = useAuthStore();
    const logout = vi.spyOn(authStore, "logout");

    callbackAt(0).onMessage({ type: "error", message: "Session is no longer valid" });

    expect(logout).toHaveBeenCalledOnce();
    expect(mocks.routerPush).toHaveBeenCalledWith("/login");
    callbackAt(0).onClose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.createLiveSocket).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
