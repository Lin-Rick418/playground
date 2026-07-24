import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SocketCallbacks } from "../lib/live";
import { useAuthStore } from "../stores/auth";

const mocks = vi.hoisted(() => ({
  createLiveSocket: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("../lib/live", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live")>()),
  createLiveSocket: mocks.createLiveSocket,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}));

import { useSessionMonitor } from "./useSessionMonitor";

const user = {
  id: "user-1",
  username: "player",
  role: "PLAYER",
  isActive: true,
  balance: 100,
} as const;

beforeEach(() => {
  const pinia = createPinia();
  setActivePinia(pinia);
  mocks.createLiveSocket.mockReturnValue({
    close: vi.fn(),
    send: vi.fn(),
  });
});

describe("useSessionMonitor", () => {
  it("ends an active session immediately when another login replaces it", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    authStore.token = "old-token";
    authStore.user = user;

    const wrapper = mount(
      defineComponent({
        setup() {
          useSessionMonitor();
          return () => h("div");
        },
      }),
      { global: { plugins: [pinia] } },
    );
    const callbacks = mocks.createLiveSocket.mock.calls[0]![0] as SocketCallbacks;

    callbacks.onMessage({
      type: "auth_revoked",
      reason: "signed_in_elsewhere",
    });

    expect(authStore.user).toBeNull();
    expect(authStore.error).toBe("此帳號已在其他裝置登入，您已被登出。");
    expect(mocks.routerReplace).toHaveBeenCalledWith("/login");
    wrapper.unmount();
  });
});
