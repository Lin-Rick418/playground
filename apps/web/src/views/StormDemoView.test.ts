import { STORM_BALANCED_SETTINGS } from "@baccarat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import MockAdapter from "axios-mock-adapter";
import StormDemoView from "./StormDemoView.vue";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/auth";
import { useStormStore } from "../stores/storm";
import { useLiveChannel } from "../composables/useLiveChannel";
import { portraitBlockedKey } from "../composables/usePortraitGuard";
import { stormUser, stormConfig, stormSnapshot, stormResult } from "../tests/storm-fixtures";
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../composables/useLiveChannel", () => ({ useLiveChannel: vi.fn() }));

describe("Temple server presentation lifecycle", () => {
  const portraitBlocked = ref(false);
  let wrapper: VueWrapper | undefined;
  let mock: MockAdapter;
  const transport = vi.fn();
  beforeEach(() => {
    portraitBlocked.value = false;
    setActivePinia(createPinia());
    sessionStorage.clear();
    useAuthStore().setUser({ ...stormUser });
    mock = new MockAdapter(api);
    mock.onGet("/storm/config").reply(200, stormConfig);
    mock.onGet("/storm/state").reply(200, stormSnapshot());
    transport.mockReset().mockResolvedValue(stormResult());
    vi.mocked(useLiveChannel).mockReturnValue({
      connected: ref(true),
      requestStorm: transport,
      requestHilo: vi.fn(),
      requestBlackjack: vi.fn(),
      requestMines: vi.fn(),
      requestPlinko: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
    });
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    mock.restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function ready() {
    wrapper = mount(StormDemoView, {
      global: { provide: { [portraitBlockedKey as symbol]: portraitBlocked } },
    });
    await flushPromises();
    return wrapper;
  }
  it("steps through eight ordered stakes and locks all amount controls while pending", async () => {
    let release!: (value: ReturnType<typeof stormResult>) => void;
    transport.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const snapshot = stormSnapshot();
    snapshot.session.amount = 20;
    mock.onGet("/storm/state").reply(200, snapshot);
    const w = await ready();
    expect(w.findAll("#demo-stake option").map((option) => option.text())).toEqual([
      "10",
      "50",
      "100",
      "200",
      "500",
      "1000",
      "2000",
      "5000",
    ]);
    expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe("10");
    const decrease = w.get('[aria-label="減少投注金額"]');
    const increase = w.get('[aria-label="增加投注金額"]');
    expect(decrease.attributes("disabled")).toBeDefined();
    expect(increase.attributes("disabled")).toBeUndefined();
    for (const amount of [50, 100, 200, 500, 1000, 2000, 5000]) {
      await increase.trigger("click");
      expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe(String(amount));
    }
    expect(increase.attributes("disabled")).toBeDefined();
    for (const amount of [2000, 1000, 500, 200, 100, 50, 10]) {
      await decrease.trigger("click");
      expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe(String(amount));
    }
    expect(decrease.attributes("disabled")).toBeDefined();
    expect(transport).not.toHaveBeenCalled();
    expect(w.find('[aria-label="本回合消除紀錄"]').exists()).toBe(false);
    expect(w.findAll(".spin-controls button")).toHaveLength(5);
    await w.get("#demo-stake").setValue("5000");
    await w.get(".spin-button").trigger("click");
    expect(transport.mock.calls[0]![0].action.amount).toBe(5000);
    expect(w.get("#demo-stake").attributes("disabled")).toBeDefined();
    expect(increase.attributes("disabled")).toBeDefined();
    expect(decrease.attributes("disabled")).toBeDefined();
    release(stormResult(1, 0, 0, 5000));
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("5,000");
    expect(w.get("#demo-stake").attributes("disabled")).toBeUndefined();
    expect(decrease.attributes("disabled")).toBeUndefined();
    expect(increase.attributes("disabled")).toBeDefined();
  });
  it("preserves a legacy 20-coin pending action until it is confirmed", async () => {
    const pending = {
      key: "legacy-storm-stake-20",
      action: { kind: "spin", amount: 20, expectedVersion: 0, ruleVersion: 1 },
    };
    sessionStorage.setItem(`storm.pending.${stormUser.id}`, JSON.stringify(pending));
    transport.mockResolvedValue(stormResult(1, 0, 0, 20));
    const w = await ready();
    expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe("20");
    expect(w.get("#demo-stake").attributes("disabled")).toBeDefined();
    expect(
      w.findAll(".stake-step").every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);
    await w.get(".spin-button").trigger("click");
    await flushPromises();
    expect(transport).toHaveBeenCalledWith({ action: pending.action, idempotencyKey: pending.key });
    await vi.runAllTimersAsync();
    expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe("10");
    expect(w.find('option[value="20"]').exists()).toBe(false);
  });
  it("keeps a legacy free series at 20 until its completion screen closes", async () => {
    const snapshot = stormSnapshot();
    snapshot.session.amount = 20;
    snapshot.session.progress.freeLeft = 1;
    snapshot.session.progress.freeGranted = 15;
    mock.onGet("/storm/state").reply(200, snapshot);
    const result = stormResult(1, 0, 0, 20);
    result.round.result.wasFree = true;
    result.round.result.cost = 0;
    result.balance = result.round.result.state.balance = 10000;
    transport.mockResolvedValue(result);
    const w = await ready();
    expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe("20");
    expect(w.get("#demo-stake").attributes("disabled")).toBeDefined();
    expect(
      w.findAll(".stake-step").every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);
    await w.get(".spin-button").trigger("click");
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(transport.mock.calls[0]![0].action.amount).toBe(20);
    expect((w.get("#demo-stake").element as HTMLSelectElement).value).toBe("10");
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,000");
  });
  it("shows the effective v2 paytable while a pinned v1 free series keeps the original rules", async () => {
    const profile = {
      id: "10000000-0000-4000-8000-000000000099",
      modelRevision: "balanced-2.0" as const,
      targetRtp: 96,
      maxWinFactor: 1000,
      payoutScale: 200000,
    };
    mock
      .onGet("/storm/config")
      .reply(200, { ...stormConfig, ruleVersion: 2, maxWinFactor: 1000, mathProfile: profile });
    const snapshot = stormSnapshot();
    snapshot.session.progress.freeLeft = 1;
    snapshot.session.progress.freeGranted = 15;
    snapshot.session.mathProfile = null;
    mock.onGet("/storm/state").reply(200, snapshot);
    const w = await ready();
    expect(w.get(".rules-dialog").text()).toContain("觸發 15 回合");
    expect(w.get(".rules-dialog").text()).not.toContain("平穩型 v2");
    useStormStore().session = { ...snapshot.session, ruleVersion: 2, mathProfile: profile };
    await flushPromises();
    expect(w.get(".rules-dialog").text()).toContain("目標 RTP 96%");
    expect(w.get(".rules-dialog").text()).toContain("觸發 10 回合");
    expect(w.get(".rules-dialog").text()).toContain("1,000 倍");
    expect(w.get(".rules-dialog").text()).toContain("除以 3");
    expect(w.get(".rules-dialog").text()).not.toContain("25,000");
    useStormStore().session = {
      ...snapshot.session,
      ruleVersion: 3,
      mathProfile: {
        ...profile,
        modelRevision: "configurable-3.0",
        settings: {
          ...STORM_BALANCED_SETTINGS,
          freeInitial: 12,
          normalUpgradeChance: 2500,
          count10Factor: 4,
          paytable: { ...STORM_BALANCED_SETTINGS.paytable, ruby: 240 },
        },
      },
    };
    await flushPromises();
    expect(w.get(".rules-dialog").text()).toContain("自訂配率 v3");
    expect(w.get(".rules-dialog").text()).toContain("觸發 12 回合");
    expect(w.get(".rules-dialog").text()).toContain("25%（強化");
    expect(w.get(".pay-table").text()).toContain("×0.48");
  });
  async function awardedFree(mode = "normal") {
    vi.stubGlobal("matchMedia", () => ({ matches: mode === "reduced" }));
    transport
      .mockImplementation(() => new Promise(() => {}))
      .mockResolvedValueOnce(stormResult(1, 0, 15));
    const w = await ready();
    if (mode === "fast") await w.get('[aria-label="快速動畫"]').trigger("click");
    await w.get(".spin-button").trigger("click");
    await flushPromises();
    for (let i = 0; i < 30 && !w.find('[aria-label="免費回合開始"]').exists(); i++)
      await vi.advanceTimersToNextTimerAsync();
    expect(w.find('[aria-label="免費回合開始"]').exists()).toBe(true);
    return w;
  }
  async function completedFree(mode = "normal") {
    vi.stubGlobal("matchMedia", () => ({ matches: mode === "reduced" }));
    const snapshot = stormSnapshot();
    Object.assign(snapshot.session.progress, {
      freeLeft: 1,
      freeGranted: 15,
      multiplier: 12,
      featureWin: 1000,
    });
    mock.onGet("/storm/state").reply(200, snapshot);
    const result = stormResult();
    Object.assign(result.session.progress, { freeGranted: 15, multiplier: 12, featureWin: 1024 });
    Object.assign(result.round.result.state, result.session.progress, { balance: 10024 });
    result.balance = 10024;
    result.round.result.wasFree = true;
    result.round.result.cost = 0;
    transport.mockResolvedValue(result);
    const w = await ready();
    if (mode === "fast") await w.get('[aria-label="快速動畫"]').trigger("click");
    await w.get('button[aria-label="開始免費回合"]').trigger("click");
    await flushPromises();
    for (let i = 0; i < 30 && !w.find('[aria-label="免費回合完成"]').exists(); i++)
      await vi.advanceTimersToNextTimerAsync();
    expect(w.get('[aria-label="免費回合完成"] .feature-number').text()).toBe("1,024");
    return w;
  }
  async function bigWin(mode = "normal", payout = 200) {
    vi.stubGlobal("matchMedia", () => ({ matches: mode === "reduced" }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    transport.mockResolvedValue(stormResult(1, payout));
    const w = await ready();
    if (mode === "fast") await w.get('[aria-label="快速動畫"]').trigger("click");
    await w.get('button[aria-label="開始探索"]').trigger("click");
    await flushPromises();
    for (let i = 0; i < 30 && !w.find('[aria-label="BIG WIN"]').exists(); i++)
      await vi.advanceTimersToNextTimerAsync();
    return w;
  }
  it.each(["normal", "fast", "reduced"])(
    "shows the settled 20x BIG WIN long enough to read in %s mode",
    async (mode) => {
      const w = await bigWin(mode);
      expect(w.get('[aria-label="BIG WIN"] .win-title').text()).toBe("BIG WIN");
      expect(w.get('[aria-label="BIG WIN"] .win-payout').text()).toBe("200");
      expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,190");
      await vi.advanceTimersByTimeAsync((mode === "fast" ? 1800 : 3000) - 1);
      expect(w.find('[aria-label="BIG WIN"]').exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.find('[aria-label="BIG WIN"]').exists()).toBe(false);
      await vi.runAllTimersAsync();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(w.get('[data-testid="last-win"]').text()).toBe("200");
    },
  );
  it("does not show BIG WIN below the existing 20x threshold", async () => {
    const w = await bigWin("normal", 199);
    expect(w.find('[aria-label="BIG WIN"]').exists()).toBe(false);
    expect(w.get('[data-testid="last-win"]').text()).toBe("199");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["button", "escape"])("skips BIG WIN immediately with %s", async (action) => {
    const w = await bigWin();
    if (action === "button") await w.get('[aria-label="BIG WIN"] button').trigger("click");
    else await w.get('[aria-label="BIG WIN"]').trigger("keydown", { key: "Escape" });
    expect(w.find('[aria-label="BIG WIN"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["account", "unmount"])("cancels BIG WIN on %s", async (action) => {
    const w = await bigWin();
    if (action === "account")
      useAuthStore().setUser({ ...stormUser, id: "other-player", balance: 123 });
    else {
      w.unmount();
      wrapper = undefined;
    }
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
    if (action === "account") {
      expect(w.find('[aria-label="BIG WIN"]').exists()).toBe(false);
      expect(w.get('[data-testid="demo-balance"]').text()).toBe("123");
    }
  });
  it.each(["normal", "fast", "reduced"])(
    "dismisses free completion after three seconds without starting a paid round in %s mode",
    async (mode) => {
      const w = await completedFree(mode);
      await vi.advanceTimersByTimeAsync(2999);
      expect(w.find('[aria-label="免費回合完成"]').exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.find('[aria-label="免費回合完成"]').exists()).toBe(false);
      expect(w.classes()).not.toContain("free-mode");
      expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeUndefined();
      expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,024");
      await vi.advanceTimersByTimeAsync(10000);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["button", "escape", "account", "unmount"])(
    "cancels the completion timer on %s",
    async (action) => {
      const w = await completedFree();
      await vi.advanceTimersByTimeAsync(1500);
      if (action === "button") await w.get('[aria-label="免費回合完成"] button').trigger("click");
      else if (action === "escape")
        await w.get('[aria-label="免費回合完成"]').trigger("keydown", { key: "Escape" });
      else if (action === "account")
        useAuthStore().setUser({ ...stormUser, id: "other-player", balance: 123 });
      else {
        w.unmount();
        wrapper = undefined;
      }
      await flushPromises();
      expect(vi.getTimerCount()).toBe(0);
      if (action !== "unmount") expect(w.find('[aria-label="免費回合完成"]').exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("dismisses completion on schedule even if the connection is lost", async () => {
    const w = await completedFree();
    await vi.advanceTimersByTimeAsync(1500);
    vi.mocked(useLiveChannel).mock.results.at(-1)!.value.connected.value = false;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1499);
    expect(w.find('[aria-label="免費回合完成"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.find('[aria-label="免費回合完成"]').exists()).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["normal", "fast", "reduced"])(
    "automatically starts free rounds after a full three-second reading delay in %s mode",
    async (mode) => {
      const w = await awardedFree(mode);
      await vi.advanceTimersByTimeAsync(2999);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(w.find('[aria-label="免費回合開始"]').exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(w.find('[aria-label="免費回合開始"]').exists()).toBe(false);
      expect(transport.mock.calls[1]![0].action).toMatchObject({ amount: 10, expectedVersion: 1 });
    },
  );
  it("starts immediately on click and cancels the scheduled start without a duplicate request", async () => {
    const w = await awardedFree();
    await vi.advanceTimersByTimeAsync(1500);
    const start = w.get('[aria-label="免費回合開始"] button');
    await start.trigger("click");
    await start.trigger("click");
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(w.find('[aria-label="免費回合開始"]').exists()).toBe(false);
  });
  it("pauses a free-intro countdown on rotation and requires a manual continuation", async () => {
    const w = await awardedFree();
    await vi.advanceTimersByTimeAsync(1500);
    portraitBlocked.value = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(1);
    portraitBlocked.value = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.find('[aria-label="免費回合開始"]').exists()).toBe(true);
    await w.get('[aria-label="免費回合開始"] button').trigger("click");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(["dismiss", "account", "unmount"])(
    "cancels the free-round countdown on %s",
    async (action) => {
      const w = await awardedFree();
      await vi.advanceTimersByTimeAsync(1500);
      if (action === "dismiss")
        await w.get('[aria-label="免費回合開始"]').trigger("keydown", { key: "Escape" });
      else if (action === "account")
        useAuthStore().setUser({ ...stormUser, id: "other-player", balance: 123 });
      else {
        w.unmount();
        wrapper = undefined;
      }
      await flushPromises();
      await vi.advanceTimersByTimeAsync(5000);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("waits while disconnected and restarts the reading delay when the connection returns", async () => {
    const w = await awardedFree();
    const connected = vi.mocked(useLiveChannel).mock.results.at(-1)!.value.connected;
    await vi.advanceTimersByTimeAsync(1500);
    connected.value = false;
    await flushPromises();
    expect(w.get('[aria-label="免費回合開始"] button').attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(1);
    connected.value = true;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2999);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("keeps the old board while awaiting WS, locks repeated clicks, then presents one settlement", async () => {
    let release!: (value: ReturnType<typeof stormResult>) => void;
    transport.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const w = await ready(),
      initial = w.findAll(".symbol-cell").map((cell) => cell.html());
    const play = w.get('button[aria-label="開始探索"]');
    await play.trigger("click");
    await play.trigger("click");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.findAll(".symbol-cell").map((cell) => cell.html())).toEqual(initial);
    expect(w.get("select").attributes("disabled")).toBeDefined();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,000");
    release(stormResult());
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,014");
    expect(w.get(".spin-button").attributes("disabled")).toBeUndefined();
    expect(w.text()).not.toContain("重設點數");
  });
  it("stops auto after its already submitted round and never sends a second wager", async () => {
    const w = await ready();
    await w.get('button[aria-label="設定自動模式"]').trigger("click");
    await w.get('dialog[aria-labelledby="auto-title"] .gold-button').trigger("click");
    await w.get('button[aria-label="停止自動"]').trigger("click");
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.get('[data-testid="last-win"]').text()).toBe("24");
  });
  it("settles the pending response after rotation and does not restart auto on return", async () => {
    let release!: (value: ReturnType<typeof stormResult>) => void;
    transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const w = await ready();
    await startUnlimited(w);
    portraitBlocked.value = true;
    release(stormResult());
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,014");
    portraitBlocked.value = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.get(".spin-button").attributes("aria-label")).toBe("開始探索");
  });
  async function startUnlimited(w: VueWrapper) {
    await w.get('button[aria-label="設定自動模式"]').trigger("click");
    const choices = w.findAll(".auto-counts button");
    expect(choices.map((button) => button.attributes("aria-label") ?? button.text())).toEqual([
      "10",
      "50",
      "100",
      "無限",
    ]);
    await w.get('.auto-counts button[aria-label="無限"]').trigger("click");
    await w.get('dialog[aria-labelledby="auto-title"] .gold-button').trigger("click");
  }
  it("keeps unlimited play running past 100 rounds until manually stopped", async () => {
    let release!: (value: ReturnType<typeof stormResult>) => void;
    transport.mockImplementation(() => {
      const version = transport.mock.calls.length;
      return version === 101
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(stormResult(version, 0));
    });
    const w = await ready();
    await startUnlimited(w);
    for (let i = 0; i < 2500 && transport.mock.calls.length < 101; i++)
      await vi.advanceTimersToNextTimerAsync();
    expect(transport).toHaveBeenCalledTimes(101);
    expect(transport.mock.calls[100]![0].action).toMatchObject({
      amount: 10,
      expectedVersion: 100,
    });
    await w.get('button[aria-label="停止自動"]').trigger("click");
    release(stormResult(101, 0));
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(101);
    expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeUndefined();
  });
  it("still stops a finite run after ten rounds", async () => {
    transport.mockImplementation(() =>
      Promise.resolve(stormResult(transport.mock.calls.length, 0)),
    );
    const w = await ready();
    await w.get('button[aria-label="設定自動模式"]').trigger("click");
    await w.get('dialog[aria-labelledby="auto-title"] .gold-button').trigger("click");
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(10);
    expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeUndefined();
  });
  it.each([
    { name: "single win", input: 0, threshold: 24, payout: 24 },
    { name: "net gain", input: 1, threshold: 4, payout: 24 },
    { name: "net loss", input: 2, threshold: 10, payout: 0 },
  ])("stops unlimited play at the $name threshold", async ({ input, threshold, payout }) => {
    transport.mockResolvedValue(stormResult(1, payout));
    const w = await ready();
    await w.findAll(".threshold input")[input]!.setValue(threshold);
    await startUnlimited(w);
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeUndefined();
  });
  it("does not resume unlimited play automatically after a disconnect", async () => {
    const w = await ready();
    await startUnlimited(w);
    const connected = vi.mocked(useLiveChannel).mock.results.at(-1)!.value.connected;
    connected.value = false;
    await vi.runAllTimersAsync();
    connected.value = true;
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeUndefined();
  });
  it("stops unlimited play when the remaining balance cannot cover the next round", async () => {
    const result = stormResult(1, 0);
    result.balance = result.round.result.state.balance = 0;
    transport.mockResolvedValue(result);
    const snapshot = stormSnapshot();
    snapshot.balance = 10;
    mock.onGet("/storm/state").reply(200, snapshot);
    useAuthStore().setUser({ ...stormUser, balance: 10 });
    const w = await ready();
    await startUnlimited(w);
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(w.get('button[aria-label="開始探索"]').attributes("disabled")).toBeDefined();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("0");
  });
  it("restores free rounds from the server and locks their original stake", async () => {
    const snapshot = stormSnapshot();
    snapshot.session.progress.freeLeft = 7;
    snapshot.session.progress.freeGranted = 15;
    snapshot.session.amount = 50;
    snapshot.session.version = 8;
    mock.onGet("/storm/state").reply(200, snapshot);
    const w = await ready();
    expect(w.get('[data-testid="free-left"]').text()).toContain("7");
    expect((w.get("select").element as HTMLSelectElement).value).toBe("50");
    expect(w.get("select").attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves a pending key on failure and confirms it instead of taking a new wager", async () => {
    transport.mockRejectedValueOnce(new Error("lost reply"));
    const w = await ready();
    await w.get(".spin-button").trigger("click");
    await flushPromises();
    const key = transport.mock.calls[0]![0].idempotencyKey;
    expect(useStormStore().pending?.key).toBe(key);
    expect(w.get('button[aria-label="確認投注結果"]').attributes("disabled")).toBeUndefined();
    await w.get(".spin-button").trigger("click");
    await vi.runAllTimersAsync();
    expect(transport.mock.calls[1]![0].idempotencyKey).toBe(key);
    expect(useStormStore().pending).toBeNull();
  });
  it("ignores a prior account response and cancels its animation timers", async () => {
    let release!: (value: ReturnType<typeof stormResult>) => void;
    transport.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const w = await ready();
    await w.get(".spin-button").trigger("click");
    useAuthStore().setUser({ ...stormUser, id: "other-player", balance: 123 });
    await flushPromises();
    release(stormResult());
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("123");
    expect(useStormStore().session).toBeNull();
    expect(w.get('[data-testid="last-win"]').text()).toBe("0");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not overwrite a newer wallet snapshot when the animation completes", async () => {
    const w = await ready();
    await w.get(".spin-button").trigger("click");
    await flushPromises();
    useAuthStore().patchBalance(20000, 100);
    await flushPromises();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("20,000");
    await vi.runAllTimersAsync();
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("20,000");
  });
  it("renders the newer saved board when a pending replay is older than the server snapshot", async () => {
    let release!: (value: ReturnType<typeof stormResult>) => void;
    transport.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const w = await ready();
    await w.get(".spin-button").trigger("click");
    const newer = stormResult(4, 100);
    newer.round.result.board[0]!.kind = "gold";
    useStormStore().session = newer.session;
    useStormStore().lastRound = newer.round;
    useAuthStore().patchBalance(newer.balance, newer.walletVersion);
    release(stormResult());
    await flushPromises();
    await vi.runAllTimersAsync();
    expect(w.get(".symbol-cell").attributes("aria-label")).toBe("超級神殿");
    expect(w.get('[data-testid="last-win"]').text()).toBe("100");
    expect(w.get('[data-testid="demo-balance"]').text()).toBe("10,090");
    expect(w.get(".spin-button").attributes("disabled")).toBeUndefined();
  });
  it("cleans up presentation on unmount and supports reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const w = await ready();
    await w.get(".spin-button").trigger("click");
    await flushPromises();
    w.unmount();
    wrapper = undefined;
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
