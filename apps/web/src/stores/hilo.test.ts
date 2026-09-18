import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import MockAdapter from "axios-mock-adapter";
import { api } from "../lib/api";
import { useHiloStore } from "./hilo";
import { useAuthStore } from "./auth";
import type { HiloRound } from "@baccarat/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const preview = { id, card: 0, version: 1 };
const options = [
  {
    choice: "higher",
    winningRanks: 12,
    totalRanks: 13,
    multiplier: 1.018333,
    payout: 101.83,
    enabled: true,
    reason: null,
  },
  {
    choice: "same",
    winningRanks: 1,
    totalRanks: 13,
    multiplier: 12.22,
    payout: 1222,
    enabled: true,
    reason: null,
  },
] as HiloRound["options"];
const round: HiloRound = {
  id,
  amount: 100,
  initialCard: 0,
  card: 0,
  status: "ACTIVE",
  successCount: 0,
  skipCount: 0,
  multiplier: 0,
  cashoutAmount: 0,
  payout: 0,
  options,
  steps: [],
  version: 1,
  ruleVersion: 1,
  createdAt: "2026-09-16T00:00:00.000Z",
  settledAt: null,
};
let http: MockAdapter;
beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  http = new MockAdapter(api);
});
afterEach(() => http.restore());
it("persists and replays the same command but uses fresh state after replay", async () => {
  const store = useHiloStore();
  store.setUser("a");
  const action = {
    kind: "guess" as const,
    roundId: id,
    expectedVersion: 1,
    choice: "higher" as const,
  };
  store.transport = vi.fn().mockRejectedValue(new Error("lost reply"));
  await expect(store.mutate(action)).rejects.toThrow("lost reply");
  const saved = JSON.parse(sessionStorage.getItem("hilo.pending.a")!);
  expect(saved.action).toEqual(action);
  store.transport = vi
    .fn()
    .mockResolvedValue({
      preview: null,
      round: { ...round, version: 2 },
      balance: 900,
      walletVersion: 2,
    });
  http
    .onGet("/hilo/state")
    .reply(200, { preview: null, round: { ...round, card: 48, version: 3 } });
  await store.reconcile();
  expect(store.transport).toHaveBeenCalledWith({ action, idempotencyKey: saved.key });
  expect(store.round?.version).toBe(3);
  expect(store.round?.card).toBe(48);
  expect(store.pending).toBeNull();
});
it("blocks another operation while its predecessor is uncertain", async () => {
  const store = useHiloStore();
  store.setUser("a");
  store.transport = vi.fn().mockRejectedValue(new Error("timeout"));
  await expect(store.mutate({ kind: "prepare" })).rejects.toThrow();
  await expect(
    store.mutate({ kind: "refresh_preview", previewId: id, expectedVersion: 1 }),
  ).rejects.toThrow("上一個操作");
  expect(store.transport).toHaveBeenCalledTimes(1);
});
it("ignores a previous account's late response and preserves its saved recovery command", async () => {
  const store = useHiloStore();
  store.setUser("a");
  let finish!: (value: unknown) => void;
  store.transport = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const operation = store.mutate({ kind: "prepare" });
  store.setUser("b");
  finish({ preview, round: null, balance: 1, walletVersion: 1 });
  await operation;
  expect(store.preview).toBeNull();
  expect(store.userId).toBe("b");
  expect(sessionStorage.getItem("hilo.pending.a")).not.toBeNull();
});
it("ignores stale versions and a delayed GET started before a mutation", async () => {
  const store = useHiloStore();
  store.setUser("a");
  store.apply({ ...round, version: 3 }, null);
  store.apply(round, null);
  expect(store.round?.version).toBe(3);
  let resolveRead!: (response: [number, unknown]) => void;
  http.onGet("/hilo/state").reply(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  const read = store.sync();
  await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
  store.transport = vi
    .fn()
    .mockResolvedValue({
      preview: null,
      round: { ...round, version: 4 },
      balance: 900,
      walletVersion: 2,
    });
  await store.mutate({ kind: "skip", roundId: id, expectedVersion: 3 });
  resolveRead([200, { preview: null, round }]);
  await read;
  expect(store.round?.version).toBe(4);
});
it("does not regress a newer wallet snapshot with a replay balance", async () => {
  const auth = useAuthStore();
  auth.setUser({
    id: "a",
    username: "player",
    role: "PLAYER",
    isActive: true,
    balance: 1000,
    walletVersion: 10,
  });
  const store = useHiloStore();
  store.setUser("a");
  store.transport = vi
    .fn()
    .mockResolvedValue({ preview, round: null, balance: 900, walletVersion: 9 });
  await store.mutate({ kind: "prepare" });
  expect(auth.user?.balance).toBe(1000);
});
