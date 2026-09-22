import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { onMounted, ref } from "vue";
import MockAdapter from "axios-mock-adapter";
import type { HiloMutationResponse, HiloRound } from "@baccarat/contracts";
import { api } from "../lib/api";
import { useLiveChannel } from "../composables/useLiveChannel";
import { useAuthStore } from "../stores/auth";
import { useHiloStore } from "../stores/hilo";
import HiloView from "./HiloView.vue";

vi.mock("../composables/useLiveChannel", () => ({ useLiveChannel: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const id = "11111111-1111-4111-8111-111111111111";
const user = {
  id: "player",
  username: "player",
  role: "PLAYER" as const,
  isActive: true,
  balance: 10000,
  walletVersion: 1,
};
function activeRound(multiplier: number): HiloRound {
  return {
    id,
    amount: 100,
    initialCard: 0,
    card: 0,
    status: "ACTIVE",
    successCount: 1,
    skipCount: 0,
    multiplier,
    cashoutAmount: multiplier * 100,
    payout: 0,
    options: [
      {
        choice: "higher",
        winningRanks: 12,
        totalRanks: 13,
        multiplier: (multiplier * 13) / 12,
        payout: Math.round(((multiplier * 1300) / 12) * 100) / 100,
        enabled: true,
        reason: null,
      },
      {
        choice: "same",
        winningRanks: 1,
        totalRanks: 13,
        multiplier: multiplier * 13,
        payout: multiplier * 1300,
        enabled: true,
        reason: null,
      },
    ],
    steps: [
      { sequence: 1, kind: "guess", fromCard: 0, card: 0, choice: "same", won: true, multiplier },
    ],
    version: 2,
    ruleVersion: 1,
    createdAt: "2026-09-16T00:00:00.000Z",
    settledAt: null,
  };
}
function settled(round: HiloRound): HiloMutationResponse {
  return {
    preview: null,
    round: {
      ...round,
      status: "CASHED_OUT",
      payout: round.cashoutAmount,
      cashoutAmount: 0,
      version: round.version + 1,
      settledAt: "2026-09-16T00:00:01.000Z",
    },
    balance: 10000 + round.cashoutAmount,
    walletVersion: 2,
  };
}

describe("Hi-Lo win celebration", () => {
  let http: MockAdapter;
  let wrapper: VueWrapper | undefined;
  let reconnect: () => void | Promise<void>;
  const request = vi.fn();
  beforeEach(() => {
    setActivePinia(createPinia());
    sessionStorage.clear();
    useAuthStore().setUser({ ...user });
    http = new MockAdapter(api);
    http.onGet("/auth/me").reply(200, user);
    http.onGet("/hilo/config").reply(200, {
      minBet: 100,
      maxBet: 5000,
      betStep: 100,
      rtp: 0.94,
      maxMultiplier: 10000,
      maxSkips: 52,
      ruleVersion: 1,
      enabled: true,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.mocked(useLiveChannel).mockImplementation((options) => {
      reconnect = () => options.onConnected?.();
      onMounted(reconnect);
      return {
        connected: ref(true),
        reconnect: vi.fn(),
        disconnect: vi.fn(),
        requestHilo: request,
        requestBlackjack: vi.fn(),
        requestMines: vi.fn(),
        requestPlinko: vi.fn(),
      };
    });
    request.mockReset();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    http.restore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function open(multiplier = 12.22) {
    const round = activeRound(multiplier);
    http.onGet("/hilo/state").reply(200, { round, preview: null });
    request.mockResolvedValue(settled(round));
    wrapper = mount(HiloView);
    await flushPromises();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return wrapper;
  }
  async function cashout() {
    await wrapper!
      .findAll("button")
      .find((button) => button.text().startsWith("收款 "))!
      .trigger("click");
    await flushPromises();
  }
  it.each([
    [7.99, null, 0],
    [8, "BIG WIN", 3600],
    [15.99, "BIG WIN", 3600],
    [16, "MEGA WIN", 4400],
    [100.99, "MEGA WIN", 4400],
    [101, "SUPER WIN", 5200],
    [10000, "SUPER WIN", 5200],
  ])(
    "celebrates %s× only after cashout, with the correct duration",
    async (multiplier, title, duration) => {
      const view = await open(multiplier);
      expect(view.find(".hilo-win").exists()).toBe(false);
      await cashout();
      if (title) {
        expect(view.get(".win-title").text()).toBe(title);
        expect(view.get(".hilo-win [role=status]").text()).toContain(multiplier.toFixed(2) + "×");
        expect(view.get(".win-payout").text()).toBe(
          `$${(multiplier * 100).toLocaleString("en-US")}`,
        );
        expect(view.get(".hilo-win").classes()).toContain("motion-reduced");
        await vi.advanceTimersByTimeAsync(duration - 1);
        expect(view.find(".hilo-win").exists()).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(view.find(".hilo-win").exists()).toBe(false);
    },
  );
  it("waits for the server response and lets the player start the next round immediately", async () => {
    const view = await open();
    let resolve!: (value: HiloMutationResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await cashout();
    expect(view.find(".hilo-win").exists()).toBe(false);
    resolve(settled(activeRound(12.22)));
    await flushPromises();
    expect(view.get(".win-title").text()).toBe("BIG WIN");
    request.mockResolvedValue({
      round: null,
      preview: { id, version: 1, card: 0 },
      balance: 11222,
      walletVersion: 2,
    });
    await view.get(".next-round").trigger("click");
    await flushPromises();
    expect(view.find(".hilo-win").exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not celebrate a high multiplier lost round", async () => {
    const view = await open(101);
    const result = settled(activeRound(101));
    result.round!.status = "LOST";
    result.round!.payout = 0;
    request.mockResolvedValue(result);
    await view.get('[aria-label="相同"]').trigger("click");
    await flushPromises();
    expect(view.find(".next-round").exists()).toBe(true);
    expect(view.find(".hilo-win").exists()).toBe(false);
  });
  it("waits for the final card reveal before celebrating an automatic cashout", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const view = await open(101);
    const result = settled(activeRound(101));
    result.round!.steps.push({
      sequence: 2,
      kind: "guess",
      fromCard: 0,
      card: 1,
      choice: "same",
      won: true,
      multiplier: 101,
    });
    result.round!.card = 1;
    request.mockResolvedValue(result);
    await view.get('[aria-label="相同"]').trigger("click");
    await flushPromises();
    expect(view.find(".hilo-win").exists()).toBe(false);
    expect(view.get(".card-flipper").classes()).toContain("is-revealing");
    await vi.advanceTimersByTimeAsync(419);
    expect(view.find(".hilo-win").exists()).toBe(false);
    expect(view.get(".card-flipper").classes()).toContain("is-revealing");
    expect(view.get(".next-round").attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(81);
    expect(view.get(".win-title").text()).toBe("SUPER WIN");
  });
  it("does not celebrate settlement restored after a lost response or replay it on reconnect", async () => {
    const view = await open();
    request.mockRejectedValueOnce(new Error("lost response"));
    await cashout();
    const result = settled(activeRound(12.22));
    http.onGet("/hilo/state").reply(200, { round: null, preview: null });
    http.onGet(`/hilo/rounds/${id}`).reply(200, { round: result.round });
    request.mockResolvedValue(result);
    await reconnect();
    await flushPromises();
    expect(view.find(".next-round").exists()).toBe(true);
    expect(view.find(".hilo-win").exists()).toBe(false);
    await reconnect();
    await flushPromises();
    expect(view.find(".hilo-win").exists()).toBe(false);
  });
  it.each(["account", "unmount"])("cleans the celebration on %s change", async (change) => {
    const view = await open();
    await cashout();
    expect(view.find(".hilo-win").exists()).toBe(true);
    if (change === "account") {
      useAuthStore().setUser({ ...user, id: "other" });
      await flushPromises();
      expect(view.find(".hilo-win").exists()).toBe(false);
      expect(useHiloStore().round).toBeNull();
    } else {
      view.unmount();
      wrapper = undefined;
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
