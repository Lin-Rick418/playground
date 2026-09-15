import { beforeEach, describe, expect, it } from "vitest";
import MockAdapter from "axios-mock-adapter";
import { createPinia, setActivePinia } from "pinia";
import { api } from "../lib/api";
import { PendingPlinkoMutationError, usePlinkoStore } from "./plinko";

const config = {
  minRows: 8,
  maxRows: 16,
  risks: ["low", "medium", "high"],
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  ruleVersion: 1,
  enabled: true,
  tables: [{ rows: 16, risk: "medium", multipliers: Array(17).fill(1), rtp: 0.955 }],
};
const round = {
  id: "11111111-1111-4111-8111-111111111111",
  amount: 100,
  rows: 16,
  risk: "medium",
  path: Array(16).fill(0),
  slotIndex: 0,
  multiplier: 1,
  payout: 100,
  ruleVersion: 1,
  createdAt: "2026-09-14T10:00:00.000Z",
  settledAt: "2026-09-14T10:00:00.000Z",
};

describe("plinko store", () => {
  let mock: MockAdapter;
  beforeEach(() => {
    setActivePinia(createPinia());
    sessionStorage.clear();
    mock = new MockAdapter(api);
    mock.onGet("/plinko/config").reply(200, config);
  });
  it("persists an uncertain wager and reconciles it with the original idempotency key", async () => {
    const store = usePlinkoStore();
    store.restorePending("user-a");
    mock.onPost("/plinko/rounds").networkErrorOnce();
    await expect(
      store.place("user-a", { amount: 100, rows: 16, risk: "medium", ruleVersion: 1 }),
    ).rejects.toThrow();
    const key = mock.history.post[0]?.headers?.["Idempotency-Key"];
    expect(store.pending?.key).toBe(key);
    mock.onPost("/plinko/rounds").reply(200, { round, balance: 1000, walletVersion: 2 });
    await store.reconcilePending("user-a");
    expect(mock.history.post[1]?.headers?.["Idempotency-Key"]).toBe(key);
    expect(store.pending).toBeNull();
  });
  it("blocks a different wager while a previous result is uncertain", async () => {
    const store = usePlinkoStore();
    store.restorePending("user-a");
    mock.onPost("/plinko/rounds").networkErrorOnce();
    await expect(
      store.place("user-a", { amount: 100, rows: 16, risk: "medium", ruleVersion: 1 }),
    ).rejects.toThrow();
    await expect(
      store.place("user-a", { amount: 200, rows: 16, risk: "medium", ruleVersion: 1 }),
    ).rejects.toBeInstanceOf(PendingPlinkoMutationError);
  });
});

it("keeps a single in-flight request across account changes and preserves the original pending bet", async () => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  const adapter = new MockAdapter(api);
  const store = usePlinkoStore();
  store.restorePending("user-a");
  let resolve!: (value: [number, unknown]) => void;
  adapter.onPost("/plinko/rounds").reply(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const bet = { amount: 100, rows: 16, risk: "medium" as const, ruleVersion: 1 };
  const response = store.place("user-a", bet);
  await Promise.resolve();
  store.restorePending("user-b");
  await expect(store.place("user-b", bet)).rejects.toBeInstanceOf(PendingPlinkoMutationError);
  resolve([200, { round, balance: 1000, walletVersion: 2 }]);
  await response;
  expect(store.requestInFlight).toBe(false);
  expect(store.history).toHaveLength(0);
  expect(sessionStorage.getItem("plinko.pending.user-a")).not.toBeNull();
  adapter.restore();
});

it("rejects malformed persisted wagers without sending a request", async () => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  sessionStorage.setItem("plinko.pending.user-a", '{"key":"missing-payload"}');
  const store = usePlinkoStore();
  store.restorePending("user-a");
  expect(store.storageError).toContain("無法讀取");
  await expect(
    store.place("user-a", { amount: 100, rows: 16, risk: "medium", ruleVersion: 1 }),
  ).rejects.toBeInstanceOf(PendingPlinkoMutationError);
});
