import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import MockAdapter from "axios-mock-adapter";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";
import { useStormStore } from "./storm";
import {
  stormUser,
  stormConfig,
  stormSnapshot,
  stormResult as fixtureResult,
} from "../tests/storm-fixtures";
// Retain legacy 20-coin requests to cover retry compatibility after the menu changes.
const stormResult = (version = 1, payout = 24, freeLeft = 0) =>
  fixtureResult(version, payout, freeLeft, 20);

describe("Storm wallet and retry isolation", () => {
  let mock: MockAdapter;
  beforeEach(() => {
    setActivePinia(createPinia());
    sessionStorage.clear();
    useAuthStore().setUser({ ...stormUser });
    mock = new MockAdapter(api);
    mock.onGet("/storm/config").reply(200, stormConfig);
    mock.onGet("/storm/state").reply(200, stormSnapshot());
  });
  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function ready() {
    const store = useStormStore();
    store.bind(stormUser.id);
    await store.refresh();
    return store;
  }
  it("sends the pinned profile and keeps it through an uncertain retry after settings change", async () => {
    const store = await ready();
    const profile = {
      id: "10000000-0000-4000-8000-000000000099",
      modelRevision: "balanced-2.0" as const,
      targetRtp: 96,
      maxWinFactor: 1000,
      payoutScale: 206672,
    };
    store.session = { ...store.session!, ruleVersion: 2, mathProfile: profile };
    store.transport = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(store.spin(20)).rejects.toThrow();
    const first = store.pending!;
    expect(first.action.ruleVersion).toBe(2);
    expect(first.action.mathProfileId).toBe(profile.id);
    store.session = {
      ...store.session!,
      mathProfile: { ...profile, id: "10000000-0000-4000-8000-000000000098" },
    };
    await expect(store.spin(50)).rejects.toThrow();
    expect(store.transport).toHaveBeenLastCalledWith({
      action: first.action,
      idempotencyKey: first.key,
    });
  });
  it("restores uncertain actions across reloads with the original amount, version and key", async () => {
    const store = await ready();
    store.transport = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(store.spin(20)).rejects.toThrow();
    const pending = { ...store.pending! };
    store.bind("");
    store.bind(stormUser.id);
    await store.refresh();
    store.transport = vi.fn().mockResolvedValue(stormResult());
    await store.spin(100);
    expect(store.transport).toHaveBeenCalledWith({
      action: pending.action,
      idempotencyKey: pending.key,
    });
    expect(store.pending).toBeNull();
    expect(useAuthStore().user?.balance).toBe(10004);
  });
  it("never replaces a newer session or wallet with an old replay", async () => {
    const store = await ready();
    store.transport = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(store.spin(20)).rejects.toThrow();
    const newer = stormResult(4, 100);
    mock.onGet("/storm/state").reply(200, {
      ...stormSnapshot(),
      session: newer.session,
      lastRound: newer.round,
      balance: newer.balance,
      walletVersion: 5,
    });
    await store.refresh();
    store.transport = vi.fn().mockResolvedValue(stormResult());
    expect(await store.spin(20)).toBeNull();
    expect(store.session?.version).toBe(4);
    expect(useAuthStore().user?.balance).toBe(10080);
    expect(store.pending).toBeNull();
  });
  it("does not send a wager if saving the pending key fails", async () => {
    const store = await ready();
    store.transport = vi.fn();
    vi.stubGlobal("sessionStorage", {
      setItem: () => {
        throw new Error("quota");
      },
    });
    await expect(store.spin(20)).rejects.toThrow("儲存空間");
    expect(store.transport).not.toHaveBeenCalled();
  });
  it("ignores late replies after switching accounts while preserving the first account retry", async () => {
    const store = await ready();
    let release!: (value: ReturnType<typeof stormResult>) => void;
    store.transport = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const promise = store.spin(20);
    const firstKey = store.pending!.key;
    useAuthStore().setUser({ ...stormUser, id: "second", balance: 77 });
    store.bind("second");
    release(stormResult());
    expect(await promise).toBeNull();
    expect(useAuthStore().user?.balance).toBe(77);
    expect(store.session).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(`storm.pending.${stormUser.id}`)!).key).toBe(firstKey);
  });
});
