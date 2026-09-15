import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import MockAdapter from "axios-mock-adapter";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/auth";
import { usePlinkoStore } from "../stores/plinko";
import PlinkoView from "./PlinkoView.vue";

vi.mock("../composables/useLiveChannel", () => ({ useLiveChannel: () => ({}) }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const multipliers = [
  106.1236, 39.5552, 9.6476, 4.8238, 2.8943, 1.4471, 0.9648, 0.4824, 0.2894, 0.4824, 0.9648, 1.4471,
  2.8943, 4.8238, 9.6476, 39.5552, 106.1236,
];
const config = {
  minRows: 8,
  maxRows: 16,
  risks: ["low", "medium", "high"],
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  ruleVersion: 1,
  enabled: true,
  tables: [
    { rows: 16, risk: "medium", multipliers, rtp: 0.9550069885253906 },
    { rows: 8, risk: "low", multipliers: Array(9).fill(0.955), rtp: 0.955 },
  ],
};
const user = {
  id: "user-1",
  username: "player",
  role: "PLAYER" as const,
  isActive: true,
  balance: 1000,
  walletVersion: 1,
};
const now = "2026-09-14T10:00:00.000Z";
function result(sequence = 1) {
  return {
    round: {
      id: `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`,
      amount: 100,
      rows: 16,
      risk: "medium",
      path: Array(16).fill(1),
      slotIndex: 16,
      multiplier: 106.1236,
      payout: 10612.36,
      ruleVersion: 1,
      createdAt: now,
      settledAt: now,
    },
    balance: 11512.36,
    walletVersion: sequence + 1,
  };
}

describe("PlinkoView", () => {
  let mock: MockAdapter;
  let pinia: ReturnType<typeof createPinia>;
  let wrapper: VueWrapper | undefined;
  let callbacks: Map<number, FrameRequestCallback>;
  let clock: number;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    sessionStorage.clear();
    mock = new MockAdapter(api);
    useAuthStore().setUser(user);
    mock.onGet("/plinko/config").reply(200, config);
    mock.onGet("/plinko/history").reply(200, { items: [], nextCursor: null });
    mock.onGet("/auth/me").reply(200, user);
    clock = 1000;
    callbacks = new Map();
    let frame = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++frame, callback);
      return frame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    mock.restore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function open() {
    wrapper = mount(PlinkoView, { global: { plugins: [pinia] } });
    await flushPromises();
    return wrapper;
  }
  async function frameAt(time: number) {
    clock = time;
    const frameCallbacks = [...callbacks.values()];
    callbacks.clear();
    frameCallbacks.forEach((callback) => callback(time));
    await flushPromises();
  }
  it.each([
    [9.99, null],
    [10, "NICE WIN"],
    [29.99, "NICE WIN"],
    [30, "BIG WIN"],
    [99.99, "BIG WIN"],
    [100, "MEGA WIN"],
  ])("celebrates %s× only after landing", async (multiplier, title) => {
    const response = result();
    response.round.multiplier = Number(multiplier);
    response.round.payout = Number(multiplier) * 100;
    mock.onPost("/plinko/rounds").reply(200, response);
    const view = await open();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(view.find(".plinko-win").exists()).toBe(false);
    await frameAt(3499);
    expect(view.find(".plinko-win").exists()).toBe(false);
    await frameAt(3500);
    if (title) {
      expect(view.get(".plinko-win").text()).toContain(title);
      expect(view.get(".plinko-win").text()).not.toMatch(/含本金|派彩|最高倍率/);
      await vi.advanceTimersByTimeAsync(3600);
    }
    expect(view.find(".plinko-win").exists()).toBe(false);
  });
  it("merges consecutive wins while auto play can still be stopped", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    let sequence = 0;
    mock.onPost("/plinko/rounds").reply(() => [200, result(++sequence)]);
    const view = await open();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await view.get('select[aria-label="自動投球"]').setValue("30");
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    expect(view.findAll(".plinko-win")).toHaveLength(1);
    expect(view.get(".win-payout").text()).toBe("$21,224");
    await view.get(".plinko-play").trigger("click");
    await vi.advanceTimersByTimeAsync(3600);
    expect(sequence).toBe(2);
    expect(view.find(".plinko-win").exists()).toBe(false);
  });
  it("does not celebrate a recovered wager again", async () => {
    sessionStorage.setItem(
      "plinko.pending.user-1",
      JSON.stringify({
        key: "replay-win-123",
        payload: { amount: 100, rows: 16, risk: "medium", ruleVersion: 1 },
      }),
    );
    mock.onPost("/plinko/rounds").reply(200, result());
    const view = await open();
    await view
      .findAll("button")
      .find((button) => button.text() === "確認上一筆投注")!
      .trigger("click");
    await flushPromises();
    expect(view.find(".plinko-ball.settled").exists()).toBe(true);
    expect(view.find(".plinko-win").exists()).toBe(false);
  });
  it("automatically sends exactly the selected count with unique keys and then stops", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    let sequence = 0;
    mock.onPost("/plinko/rounds").reply(() => [200, result(++sequence)]);
    const view = await open();
    vi.useFakeTimers();
    const auto = view.get('select[aria-label="自動投球"]');
    expect(auto.findAll("option").map((option) => option.attributes("value"))).toEqual([
      "0",
      "30",
      "50",
      "100",
      "300",
      "500",
      "1000",
    ]);
    await auto.setValue("30");
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(view.get(".plinko-play").text()).toBe("停止投球（29）");
    expect(auto.attributes("disabled")).toBeDefined();
    expect(view.get('select[aria-label="投注額"]').attributes("disabled")).toBeDefined();
    expect(view.get('select[aria-label="排數"]').attributes("disabled")).toBeDefined();
    expect(view.get('[aria-label="增加投注 100"]').attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(350 * 29);
    expect(mock.history.post).toHaveLength(30);
    expect(
      new Set(mock.history.post.map((request) => request.headers?.["Idempotency-Key"])).size,
    ).toBe(30);
    expect(view.get(".plinko-play").text()).toBe("投球");
    expect(auto.attributes("disabled")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.history.post).toHaveLength(30);
  });

  it("can stop during an in-flight request without losing its result or sending the next ball", async () => {
    let resolve!: (value: [number, ReturnType<typeof result>]) => void;
    mock.onPost("/plinko/rounds").reply(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = await open();
    vi.useFakeTimers();
    await view.get('select[aria-label="自動投球"]').setValue("50");
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(view.get(".plinko-play").attributes("disabled")).toBeUndefined();
    await view.get(".plinko-play").trigger("click");
    resolve([200, result()]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.history.post).toHaveLength(1);
    expect(view.findAll(".plinko-ball")).toHaveLength(1);
    expect(usePlinkoStore().history).toHaveLength(1);
    expect(view.get(".plinko-play").text()).toBe("投球");
  });

  it("cancels the queued next ball on stop and on leaving the page", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    let sequence = 0;
    mock.onPost("/plinko/rounds").reply(() => [200, result(++sequence)]);
    const view = await open();
    vi.useFakeTimers();
    await view.get('select[aria-label="自動投球"]').setValue("1000");
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    await view.get(".plinko-play").trigger("click");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.history.post).toHaveLength(1);
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(mock.history.post).toHaveLength(2);
    view.unmount();
    wrapper = undefined;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.history.post).toHaveLength(2);
  });

  it.each(["balance", "server", "network"])("stops auto play on %s failure", async (failure) => {
    const view = await open();
    vi.useFakeTimers();
    if (failure === "balance") useAuthStore().user!.balance = 67;
    else if (failure === "server")
      mock
        .onPost("/plinko/rounds")
        .reply(400, { code: "INSUFFICIENT_BALANCE", message: "餘額不足" });
    else mock.onPost("/plinko/rounds").networkError();
    await view.get('select[aria-label="自動投球"]').setValue("30");
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(view.get(".plinko-play").text()).toBe("投球");
    if (failure === "network") {
      expect(usePlinkoStore().pending).not.toBeNull();
      expect(view.get(".plinko-play").attributes("disabled")).toBeDefined();
    } else expect(view.get(".plinko-wallet").classes()).toContain("insufficient");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.history.post).toHaveLength(failure === "balance" ? 0 : 1);
  });
  it("caps 12 accepted requests, keeps amount editable, animates to server slot and unlocks settings", async () => {
    let sequence = 0;
    mock.onPost("/plinko/rounds").reply(() => [200, result(++sequence)]);
    const view = await open();
    for (let index = 0; index < 13; index++) {
      await view.get(".plinko-play").trigger("click");
      await flushPromises();
    }
    expect(mock.history.post).toHaveLength(12);
    expect(view.findAll(".plinko-ball")).toHaveLength(12);
    expect(view.get(".plinko-play").attributes("disabled")).toBeDefined();
    expect(view.get('select[aria-label="投注額"]').attributes("disabled")).toBeUndefined();
    expect(view.get('select[aria-label="排數"]').attributes("disabled")).toBeDefined();
    expect(view.get("fieldset").attributes("disabled")).toBeDefined();
    expect(view.find(".plinko-bet-action .result-summary").exists()).toBe(false);
    const initial = view.get(".plinko-ball").attributes("transform");
    expect(view.findAll(".recent-results li")).toHaveLength(0);
    await frameAt(1220);
    expect(view.get(".plinko-ball").attributes("transform")).not.toBe(initial);
    expect(view.findAll(".pins .hit").length).toBeGreaterThan(0);
    expect(view.get(".pins .hit").attributes("r")).toBe("1.05");
    expect(view.findAll(".pin-ripples circle").length).toBeGreaterThan(0);
    expect(view.findAll(".plinko-ball.colliding")).toHaveLength(12);
    await frameAt(3500);
    expect(view.findAll(".plinko-ball.settled")).toHaveLength(4); // bounded landed display, all 12 results remain recorded
    expect(view.get(".plinko-ball").attributes("transform")).toContain("translate(91 89.5)");
    expect(view.get(".plinko-play").attributes("disabled")).toBeUndefined();
    expect(view.get('select[aria-label="排數"]').attributes("disabled")).toBeUndefined();
    expect(view.get(".slot-legend").text()).toContain("106.12×");
    expect(view.find(".plinko-bet-action .result-summary").exists()).toBe(false);
    await frameAt(4300);
    expect(view.get(".plinko-wallet strong").text()).toBe("$11,512");
    expect(usePlinkoStore().history).toHaveLength(12);
    expect(view.findAll(".recent-results li")).toHaveLength(10);
    expect(view.findAll(".recent-results li").every((item) => item.text() === "106.12×")).toBe(
      true,
    );
    expect(callbacks.size).toBe(0);
  });
  it("bounces the hit slot again when a second ball lands in the same slot", async () => {
    let sequence = 0;
    mock.onPost("/plinko/rounds").reply(() => [200, result(++sequence)]);
    const view = await open();
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    await frameAt(1100);
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    const slot = () => view.findAll(".plinko-slot")[16]!;
    await frameAt(3500);
    expect(slot().classes()).toContain("impacting");
    expect(view.findAll(".plinko-slot.impacting")).toHaveLength(1);
    await frameAt(3550);
    expect(slot().attributes("transform")).not.toBe("translate(91 86)");
    await frameAt(3600); // second impact restarts even while the first bounce is active
    expect(slot().attributes("transform")).toBe("translate(91 86)");
    await frameAt(3705);
    expect(slot().attributes("transform")).not.toBe("translate(91 86)");
    await frameAt(4021);
    expect(slot().attributes("transform")).toBe("translate(91 86)");
    expect(slot().classes()).not.toContain("impacting");
    expect(view.findAll(".pin-ripples circle")).toHaveLength(0);
    await frameAt(4400);
    expect(callbacks.size).toBe(0);
  });
  it("holds early WebSocket payouts and releases overlapping balls only after landing", async () => {
    const first = result();
    Object.assign(first.round, { multiplier: 2.5, payout: 250 });
    first.balance = 1150;
    const second = result(2);
    Object.assign(second.round, { multiplier: 2.5, payout: 250 });
    second.balance = 1300;
    let respond!: (value: [number, ReturnType<typeof result>]) => void;
    mock.onPost("/plinko/rounds").reply(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const view = await open();
    const balance = () => Number(view.get(".plinko-wallet strong").text().replace(/[$,]/g, ""));
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(balance()).toBe(900);
    useAuthStore().patchBalance(1150, 2); // notification beats the HTTP response
    await flushPromises();
    expect(balance()).toBe(900);
    respond([200, first]);
    await flushPromises();
    expect(balance()).toBe(900);
    await frameAt(1500);
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    useAuthStore().patchBalance(1300, 3);
    respond([200, second]);
    await flushPromises();
    expect(balance()).toBe(800);
    await frameAt(3499);
    expect(balance()).toBe(800);
    await frameAt(3500);
    expect(balance()).toBe(800);
    expect(view.get(".plinko-wallet strong").classes()).toContain("rolling");
    await frameAt(3750);
    expect(balance()).toBeGreaterThan(800);
    expect(balance()).toBeLessThan(1050); // the second ball has not landed
    useAuthStore().patchBalance(9999, 1); // stale snapshot must remain ignored
    await frameAt(4000);
    expect(balance()).toBeLessThan(1050);
    await frameAt(4800);
    expect(balance()).toBe(1300);
    expect(callbacks.size).toBe(0);
  });
  it("restores the displayed debit when the server rejects a wager", async () => {
    mock.onPost("/plinko/rounds").reply(400, { code: "INSUFFICIENT_BALANCE", message: "餘額不足" });
    const view = await open();
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(view.get(".plinko-wallet strong").text()).toBe("$1,000");
    expect(view.findAll(".plinko-ball")).toHaveLength(0);
    expect(view.get(".plinko-wallet").classes()).toContain("insufficient");
    expect(view.get('[role="alert"]').text()).toBe("餘額不足");
    expect(view.find(".plinko-feedback").exists()).toBe(false);
  });
  it("shows the wallet warning without posting when the known balance cannot cover the stake", async () => {
    const view = await open();
    useAuthStore().patchBalance(67, 2);
    await flushPromises();
    await view.get(".plinko-play").trigger("click");
    expect(mock.history.post).toHaveLength(0);
    expect(view.get(".plinko-wallet strong").text()).toBe("$67");
    expect(view.get(".plinko-wallet").classes()).toContain("insufficient");
    expect(view.find(".plinko-feedback").exists()).toBe(false);
  });
  it("keeps an uncertain debit displayed until its original request is recovered", async () => {
    mock.onPost("/plinko/rounds").networkError();
    const view = await open();
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    useAuthStore().patchBalance(11512.36, 2);
    await flushPromises();
    expect(view.get(".plinko-wallet strong").text()).toBe("$900");
    const originalKey = mock.history.post[0]!.headers!["Idempotency-Key"];
    mock.onPost("/plinko/rounds").reply(200, result());
    await view
      .findAll("button")
      .find((button) => button.text() === "確認上一筆投注")!
      .trigger("click");
    await flushPromises();
    expect(mock.history.post[1]!.headers!["Idempotency-Key"]).toBe(originalKey);
    expect(view.get(".plinko-wallet strong").text()).toBe("$11,512");
    expect(view.findAll(".plinko-ball.settled")).toHaveLength(1);
  });
  it("restores an uncertain bet without auto-posting and confirms its original settings/key once", async () => {
    const payload = { amount: 100, rows: 8, risk: "low", ruleVersion: 1 };
    sessionStorage.setItem(
      "plinko.pending.user-1",
      JSON.stringify({ key: "original-bet-key", payload }),
    );
    const recovered = result();
    Object.assign(recovered.round, {
      rows: 8,
      risk: "low",
      path: Array(8).fill(0),
      slotIndex: 0,
      multiplier: 0.955,
      payout: 95.5,
    });
    mock.onPost("/plinko/rounds").reply(200, recovered);
    const view = await open();
    expect(mock.history.post).toHaveLength(0);
    expect(view.get(".plinko-play").attributes("disabled")).toBeDefined();
    const retry = view.findAll("button").find((button) => button.text() === "確認上一筆投注")!;
    await retry.trigger("click");
    await retry.trigger("click");
    await flushPromises();
    expect(mock.history.post).toHaveLength(1);
    expect(mock.history.post[0]!.headers!["Idempotency-Key"]).toBe("original-bet-key");
    expect(JSON.parse(mock.history.post[0]!.data)).toEqual(payload);
    expect(view.get(".plinko-board").attributes("aria-label")).toContain("8 排 低風險");
    expect(view.get(".plinko-ball.settled").attributes("transform")).toContain("translate(9 89.5)");
    expect(usePlinkoStore().pending).toBeNull();
  });
  it("ignores a late wager response after changing accounts", async () => {
    let resolve!: (value: [number, ReturnType<typeof result>]) => void;
    mock.onPost("/plinko/rounds").reply(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = await open();
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(usePlinkoStore().pending).not.toBeNull();
    expect(view.find(".plinko-feedback").exists()).toBe(false);
    const other = { ...user, id: "user-2", balance: 500, walletVersion: 100 };
    mock.onGet("/auth/me").reply(200, other);
    useAuthStore().setUser(other);
    await flushPromises();
    resolve([200, result()]);
    await flushPromises();
    expect(useAuthStore().user?.id).toBe("user-2");
    expect(useAuthStore().user?.balance).toBe(500);
    expect(view.get(".plinko-wallet strong").text()).toBe("$500");
    expect(view.findAll(".plinko-ball")).toHaveLength(0);
    expect(usePlinkoStore().requestInFlight).toBe(false);
    expect(sessionStorage.getItem("plinko.pending.user-1")).not.toBeNull();
  });
  it("places reduced-motion results directly in the final slot and cleans frames on unmount", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    mock.onPost("/plinko/rounds").reply(200, result());
    const view = await open();
    await view.get(".plinko-play").trigger("click");
    await flushPromises();
    expect(view.get(".plinko-ball.settled").attributes("transform")).toContain(
      "translate(91 89.5)",
    );
    expect(callbacks.size).toBe(0);
    expect(view.findAll(".pin-ripples circle, .plinko-slot.impacting")).toHaveLength(0);
    expect(view.get('select[aria-label="排數"]').attributes("disabled")).toBeUndefined();
  });
  it("blocks another HTTP request across a page remount and ignores unmounted callbacks", async () => {
    let resolve!: (value: [number, ReturnType<typeof result>]) => void;
    mock.onPost("/plinko/rounds").reply(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = await open();
    await first.get(".plinko-play").trigger("click");
    await flushPromises();
    first.unmount();
    const second = await open();
    expect(second.get(".plinko-play").attributes("disabled")).toBeDefined();
    resolve([200, result()]);
    await flushPromises();
    expect(second.findAll(".plinko-ball")).toHaveLength(0);
    expect(mock.history.post).toHaveLength(1);
    expect(callbacks.size).toBe(0);
  });
});
