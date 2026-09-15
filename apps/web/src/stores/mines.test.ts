import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { api } from "../lib/api";
import { isValidMinesStake, PendingMinesMutationError, useMinesStore } from "./mines";
import type { MinesRound } from "../types/domain";

const now = "2026-09-14T10:00:00.000Z";
const activeRound: MinesRound = {
  id: "11111111-1111-4111-8111-111111111111",
  amount: 100,
  mineCount: 3,
  revealedCells: [1],
  status: "ACTIVE",
  payout: 0,
  cashoutAmount: 107.95,
  multiplier: 1.079545,
  nextMultiplier: 1.233766,
  mineCells: null,
  createdAt: now,
  settledAt: null,
  version: 1,
  ruleVersion: 1,
};
const terminalRound = {
  ...activeRound,
  status: "CASHED_OUT",
  payout: 107.95,
  nextMultiplier: null,
  mineCells: [2, 3, 4],
  settledAt: now,
};
const config = {
  boardSize: 25,
  minMines: 3,
  maxMines: 24,
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  rtp: 0.95,
  enabled: true,
} as const;

let mock: MockAdapter;
beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  mock = new MockAdapter(api);
});

describe("mines store", () => {
  it("validates the complete 100–5000 stake grid client-side", () => {
    expect(isValidMinesStake(100, config)).toBe(true);
    expect(isValidMinesStake(5000, config)).toBe(true);
    for (const amount of [0, 99, 150, 5001, 100.5])
      expect(isValidMinesStake(amount, config)).toBe(false);
  });

  it("restores an active round but keeps terminal layouts only in history", async () => {
    const store = useMinesStore();
    mock
      .onGet("/mines/active")
      .replyOnce(200, { round: activeRound })
      .onGet("/mines/history")
      .replyOnce(200, { items: [terminalRound], nextCursor: null });
    await store.fetchActive();
    expect(store.round).toEqual(activeRound);
    expect(store.round?.mineCells).toBeNull();
    await store.fetchHistory();
    expect(store.history[0]?.mineCells).toEqual([2, 3, 4]);
  });

  it("persists an uncertain mutation and retries with the exact same idempotency key after restoration", async () => {
    const first = useMinesStore();
    mock
      .onPost("/mines/rounds")
      .replyOnce(500, { code: "INTERNAL_ERROR", message: "retry", requestId: "r1" });
    await expect(first.start("user-a", 100, 3)).rejects.toMatchObject({
      response: { status: 500 },
    });
    const saved = JSON.parse(sessionStorage.getItem("mines.pending.user-a") ?? "{}");
    expect(saved).toMatchObject({
      operation: "start",
      payload: JSON.stringify({ amount: 100, mineCount: 3 }),
    });

    setActivePinia(createPinia());
    const restored = useMinesStore();
    restored.restorePending("user-a");
    mock.onGet("/mines/active").replyOnce(200, { round: null });
    mock.onPost("/mines/rounds").replyOnce(200, { round: activeRound, balance: 900 });
    mock.onGet("/mines/active").replyOnce(200, { round: activeRound });
    await restored.reconcilePending("user-a");
    expect(mock.history.post.at(-1)?.headers?.["Idempotency-Key"]).toBe(saved.key);
    expect(restored.round).toEqual(activeRound);
    expect(sessionStorage.getItem("mines.pending.user-a")).toBeNull();
  });

  it("does not reuse a prior user's persisted request", () => {
    const store = useMinesStore();
    sessionStorage.setItem(
      "mines.pending.user-a",
      JSON.stringify({ key: "key-a", payload: "{}", operation: "start" }),
    );
    store.restorePending("user-a");
    store.round = activeRound;
    store.restorePending("user-b");
    expect(store.pending).toBeNull();
    expect(store.round).toBeNull();
  });

  it("blocks a different operation while an uncertain request must be retried", async () => {
    const store = useMinesStore();
    store.restorePending("user-a");
    store.persistPending("user-a", {
      key: "retry-key",
      payload: JSON.stringify({ cellIndex: 1 }),
      operation: "reveal",
      roundId: activeRound.id,
    });
    await expect(store.cashout("user-a", activeRound.id)).rejects.toBeInstanceOf(
      PendingMinesMutationError,
    );
    expect(store.pending?.key).toBe("retry-key");
  });

  it("replays an uncertain reveal with its original key when the authoritative round is still active", async () => {
    const store = useMinesStore();
    store.restorePending("user-a");
    store.persistPending("user-a", {
      key: "retry-key",
      payload: JSON.stringify({ cellIndex: 1 }),
      operation: "reveal",
      roundId: activeRound.id,
    });
    mock.onGet(`/mines/rounds/${activeRound.id}`).replyOnce(200, { round: activeRound });
    mock
      .onPost(`/mines/rounds/${activeRound.id}/reveal`)
      .replyOnce(200, { round: { ...activeRound, revealedCells: [1, 2] }, balance: 900 });
    mock
      .onGet(`/mines/rounds/${activeRound.id}`)
      .replyOnce(200, { round: { ...activeRound, revealedCells: [1, 2] } });
    await store.reconcilePending("user-a");
    expect(mock.history.post.at(-1)?.headers?.["Idempotency-Key"]).toBe("retry-key");
    expect(store.round?.revealedCells).toEqual([1, 2]);
  });

  it("drops a late former-account history response after the active user changes", async () => {
    const store = useMinesStore();
    store.restorePending("user-a");
    let resolveRequest!: (value: { data: unknown }) => void;
    vi.spyOn(api, "get").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }) as never,
    );
    const request = store.fetchHistory();
    await Promise.resolve();
    store.restorePending("user-b");
    resolveRequest({ data: { items: [terminalRound], nextCursor: null } });
    await request;
    expect(store.history).toEqual([]);
  });
  it("clears a definitive paused-game rejection so it cannot trap an old idempotency key", async () => {
    const store = useMinesStore();
    mock.onGet("/mines/config").reply(200, {...config, enabled:false});
    mock.onGet("/mines/active").reply(200, {round:null});
    mock.onPost("/mines/rounds").replyOnce(503, {code:"SERVICE_UNAVAILABLE",message:"paused",requestId:"paused-1"});
    await expect(store.start("user-a",100,3)).rejects.toMatchObject({response:{status:503}});
    expect(store.pending).toBeNull();
    expect(store.config?.enabled).toBe(false);
  });

});
