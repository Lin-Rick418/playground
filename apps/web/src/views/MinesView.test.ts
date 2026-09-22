import MockAdapter from "axios-mock-adapter";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useLiveChannel } from "../composables/useLiveChannel";
import { api } from "../lib/api";

vi.mock("../composables/useLiveChannel", () => ({ useLiveChannel: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import MinesView from "./MinesView.vue";
import { useAuthStore } from "../stores/auth";

const now = "2026-09-14T10:00:00.000Z";
enableAutoUnmount(afterEach);
const config = {
  boardSize: 25,
  minMines: 3,
  maxMines: 24,
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  rtp: 0.95,
  enabled: true,
};
const activeRound = {
  id: "11111111-1111-4111-8111-111111111111",
  amount: 100,
  mineCount: 3,
  revealedCells: [],
  status: "ACTIVE",
  payout: 0,
  cashoutAmount: 0,
  multiplier: 0,
  nextMultiplier: 1.079545,
  mineCells: null,
  createdAt: now,
  settledAt: null,
  version: 1,
  ruleVersion: 1,
};

describe("MinesView", () => {
  let mock: MockAdapter;
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    sessionStorage.clear();
    mock = new MockAdapter(api);
    vi.mocked(useLiveChannel).mockReturnValue({
      requestHilo: vi.fn(),
      requestBlackjack: vi.fn(),
      requestPlinko: vi.fn(),
      connected: ref(true),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      requestMines: async ({ action, idempotencyKey }) => {
        const { kind, ...rest } = action;
        const { roundId, ...payload } = rest as typeof rest & { roundId?: string };
        return (
          await api.post(
            kind === "start" ? "/mines/rounds" : `/mines/rounds/${roundId}/${kind}`,
            payload,
            { headers: { "Idempotency-Key": idempotencyKey } },
          )
        ).data;
      },
    });
    const auth = useAuthStore();
    auth.user = { id: "user-1", username: "player", role: "PLAYER", isActive: true, balance: 1000 };
    mock.onGet("/auth/me").reply(200, auth.user);
    mock.onGet("/mines/config").reply(200, config);
    mock.onGet("/mines/active").reply(200, { round: null });
  });
  afterEach(() => {
    mock.restore();
    vi.useRealTimers();
  });

  it("warns locally without posting, restarts the warning and clears it after 1.2 seconds", async () => {
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    useAuthStore().user!.balance = 67;
    vi.useFakeTimers();
    await wrapper.get(".button-primary").trigger("click");
    expect(mock.history.post).toHaveLength(0);
    expect(wrapper.get(".mines-wallet").classes()).toContain("insufficient");
    expect(wrapper.get('.mines-wallet [role="alert"]').text()).toBe("餘額不足");
    expect(wrapper.get(".mines-wallet strong").text()).toBe("$67");
    expect(wrapper.find(".mines-feedback").exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    await wrapper.get(".button-primary").trigger("click");
    await vi.advanceTimersByTimeAsync(800);
    expect(wrapper.get(".mines-wallet").classes()).toContain("insufficient");
    await vi.advanceTimersByTimeAsync(400);
    expect(wrapper.get(".mines-wallet").classes()).not.toContain("insufficient");
    expect(mock.history.post).toHaveLength(0);
  });

  it.each([
    { code: "INSUFFICIENT_BALANCE", message: "餘額不足" },
    { code: "VALIDATION_ERROR", message: "餘額不足。" },
  ])(
    "uses the wallet warning for server rejection $code and allows a later valid start",
    async (failure) => {
      mock.onPost("/mines/rounds").replyOnce(400, failure);
      mock.onPost("/mines/rounds").reply(200, { round: activeRound, balance: 900 });
      const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
      await flushPromises();
      await wrapper.get(".button-primary").trigger("click");
      await flushPromises();
      expect(wrapper.get(".mines-wallet").classes()).toContain("insufficient");
      expect(wrapper.find(".mines-feedback").exists()).toBe(false);
      expect(wrapper.get(".button-primary").attributes("disabled")).toBeUndefined();
      await wrapper.get(".button-primary").trigger("click");
      await flushPromises();
      expect(wrapper.get(".mines-wallet").classes()).not.toContain("insufficient");
      expect(wrapper.findAll(".mine-cell:not([disabled])")).toHaveLength(25);
    },
  );

  it("offers exactly 100..5000 stakes and uses the mutation wallet version without another /auth/me request", async () => {
    mock
      .onPost("/mines/rounds")
      .reply(200, { round: activeRound, balance: 899.75, walletVersion: 2 });
    mock.onGet("/auth/me").reply(200, {
      id: "user-1",
      username: "player",
      role: "PLAYER",
      isActive: true,
      balance: 899.75,
    });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    const stakeOptions = wrapper.findAll("select").at(0)!.findAll("option");
    expect(stakeOptions).toHaveLength(50);
    const mineOptions = wrapper.get("#mine-count").findAll("option");
    expect(mineOptions.map((option) => Number(option.attributes("value")))).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 3),
    );
    expect(stakeOptions[0]!.attributes("value")).toBe("100");
    expect(stakeOptions.at(-1)!.attributes("value")).toBe("5000");
    const readsBefore = mock.history.get.length;
    await wrapper.get(".button-primary").trigger("click");
    await flushPromises();
    expect(mock.history.get.length).toBe(readsBefore);
    expect(wrapper.text()).toContain("$899");
  });

  it("renders a terminal mine as a mine even when it is among revealed cells, and shows final payout", async () => {
    mock.onGet("/mines/active").reply(200, {
      round: {
        ...activeRound,
        revealedCells: [0],
        status: "LOST",
        payout: 0,
        mineCells: [0, 2, 3],
        nextMultiplier: null,
        settledAt: now,
      },
    });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.get('[aria-label="地雷"]').classes()).toContain("mine");
    expect(wrapper.text()).toContain("本局派彩");
    expect(wrapper.findAll(".game-summary strong").at(-1)?.text()).toBe("0");
  });

  it("uses a plain Mines heading and renders a server-forced mine as a normal loss", async () => {
    mock
      .onGet("/mines/config")
      .reply(200, { ...config, rtp: null, ruleVersion: 2, maxMultiplier: 1000 });
    mock.onGet("/mines/active").reply(200, {
      round: {
        ...activeRound,
        ruleVersion: 2,
        revealedCells: [0],
        multiplier: 900,
        cashoutAmount: 90000,
        nextMultiplier: 1100,
      },
    });
    mock.onPost(`/mines/rounds/${activeRound.id}/reveal`).reply(200, {
      round: {
        ...activeRound,
        ruleVersion: 2,
        version: 2,
        revealedCells: [0, 1],
        multiplier: 900,
        status: "LOST",
        payout: 0,
        nextMultiplier: null,
        settledAt: now,
        mineCells: [1, 2, 3],
        settlementReason: "MULTIPLIER_LIMIT",
      },
      balance: 900,
    });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.get("h1").text()).toBe("Mines");
    expect(wrapper.find(".brand-spark").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("倍率上限");
    await wrapper.get('[aria-label="翻開第 2 格"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".mine-cell")[1]!.classes()).toContain("mine");
    expect(wrapper.get(".mines-board").attributes("aria-label")).toBe("Mines 棋盤，踩到地雷");
    expect(wrapper.text()).not.toContain("必定踩雷");
    expect(wrapper.findAll(".game-summary strong").at(-1)?.text()).toBe("0");
    expect(wrapper.findAll(".mine-cell:not([disabled])")).toHaveLength(0);
  });

  it.each([
    { revealedCells: [], payout: 100, message: "帳戶額度不足，已退回本金" },
    { revealedCells: [0], payout: 107.95, message: "已達帳戶額度限制，已按目前倍率收款" },
  ])("explains account-limit settlement: $message", async ({ revealedCells, payout, message }) => {
    mock.onGet("/mines/active").reply(200, {
      round: {
        ...activeRound,
        ruleVersion: 2,
        revealedCells,
        payout,
        status: "CASHED_OUT",
        nextMultiplier: null,
        settledAt: now,
        mineCells: [1, 2, 3],
        settlementReason: "ACCOUNT_LIMIT",
      },
    });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain(message);
    expect(wrapper.findAll(".mine-cell:not([disabled])")).toHaveLength(0);
  });
  it("offers an explicit original-key retry and blocks other controls after an uncertain start", async () => {
    let accepted = false;
    mock.onGet("/mines/active").reply(() => [200, { round: accepted ? activeRound : null }]);
    mock.onPost("/mines/rounds").networkErrorOnce();
    mock.onPost("/mines/rounds").reply(() => {
      accepted = true;
      return [200, { round: activeRound, balance: 900 }];
    });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    await wrapper.get(".button-primary").trigger("click");
    await flushPromises();
    expect(wrapper.get(".button-primary").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".mines-feedback").exists()).toBe(true);
    expect(wrapper.get(".mines-wallet").classes()).not.toContain("insufficient");
    const originalKey = mock.history.post[0]?.headers?.["Idempotency-Key"];
    await wrapper.get(".retry-pending").trigger("click");
    await flushPromises();
    expect(mock.history.post[1]?.headers?.["Idempotency-Key"]).toBe(originalKey);
    expect(wrapper.find(".retry-pending").exists()).toBe(false);
    expect(wrapper.findAll(".mine-cell:not([disabled])")).toHaveLength(25);
  });
  it("keeps shortcut stakes in range and submits the selected mine preset", async () => {
    mock.onPost("/mines/rounds").reply(200, { round: activeRound, balance: 900 });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    const stake = wrapper.findAll("select")[0]!;
    await wrapper.get('[aria-label="最高投注 5000"]').trigger("click");
    expect((stake.element as HTMLSelectElement).value).toBe("5000");
    expect(wrapper.get('[aria-label="增加投注 100"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[aria-label="減少投注 100"]').trigger("click");
    expect((stake.element as HTMLSelectElement).value).toBe("4900");
    await wrapper.get('[aria-label="最低投注 100"]').trigger("click");
    await wrapper.get('[aria-label="增加投注 100"]').trigger("click");
    await wrapper.get('[aria-label="10 顆地雷"]').trigger("click");
    expect((wrapper.get("#mine-count").element as HTMLSelectElement).value).toBe("10");
    await wrapper.get(".button-primary").trigger("click");
    await flushPromises();
    expect(JSON.parse(mock.history.post[0]!.data)).toEqual({ amount: 200, mineCount: 10 });
  });

  it("locks restored round settings and only enables cashout after a safe reveal", async () => {
    mock
      .onGet("/mines/active")
      .reply(200, { round: { ...activeRound, amount: 500, mineCount: 5 } });
    mock.onPost(`/mines/rounds/${activeRound.id}/reveal`).reply(200, {
      round: {
        ...activeRound,
        amount: 500,
        mineCount: 5,
        revealedCells: [0],
        cashoutAmount: 593.75,
        multiplier: 1.1875,
      },
      balance: 500,
    });
    const wrapper = mount(MinesView, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(
      wrapper.findAll("select").every((select) => select.attributes("disabled") !== undefined),
    ).toBe(true);
    expect((wrapper.findAll("select")[0]!.element as HTMLSelectElement).value).toBe("500");
    expect((wrapper.get("#mine-count").element as HTMLSelectElement).value).toBe("5");
    expect(wrapper.get(".button-primary").attributes("disabled")).toBeDefined();
    expect(wrapper.find("details").exists()).toBe(false);
    await wrapper.get('[aria-label="翻開第 1 格"]').trigger("click");
    await flushPromises();
    expect(wrapper.get(".button-primary").attributes("disabled")).toBeUndefined();
    expect(wrapper.get(".button-primary").text()).toBe("收款 593");
  });
});
