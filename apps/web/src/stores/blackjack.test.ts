import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import MockAdapter from "axios-mock-adapter";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";
import { useBlackjackStore } from "./blackjack";
import type { BlackjackRound } from "@baccarat/contracts";

const id = "11111111-1111-4111-8111-111111111111";
const handId = "22222222-2222-4222-8222-222222222222";
const round: BlackjackRound = {
  id,
  amount: 100,
  totalBet: 100,
  payout: 0,
  status: "ACTIVE",
  phase: "PLAYER_TURN",
  dealerCards: [0],
  dealerTotal: null,
  dealerSoft: null,
  dealerHidden: true,
  hands: [
    {
      id: handId,
      cards: [4, 8],
      amount: 100,
      total: 5,
      soft: false,
      status: "PLAYING",
      split: false,
      splitAces: false,
      doubled: false,
      outcome: "PENDING",
      payout: 0,
    },
  ],
  activeHandId: handId,
  insurance: { amount: 50, payout: 0, decided: false },
  allowedActions: ["hit", "stand"],
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

it("retains an uncertain action and reconciles it with its original idempotency key", async () => {
  const store = useBlackjackStore();
  store.setUser("player");
  const action = { kind: "hit" as const, roundId: id, expectedVersion: 1, handId };
  store.transport = vi.fn().mockRejectedValue(new Error("lost reply"));
  await expect(store.mutate(action)).rejects.toThrow("lost reply");
  const saved = JSON.parse(sessionStorage.getItem("blackjack.pending.player")!);
  http.onGet("/blackjack/state").reply(200, { round: { ...round, version: 3 } });
  store.transport = vi
    .fn()
    .mockResolvedValue({ round: { ...round, version: 2 }, balance: 900, walletVersion: 2 });
  await store.reconcile();
  expect(store.transport).toHaveBeenCalledWith({ idempotencyKey: saved.key, action });
  expect(store.round?.version).toBe(3);
  expect(store.pending).toBeNull();
});

it("does not apply an older wallet result", async () => {
  const auth = useAuthStore();
  auth.setUser({
    id: "player",
    username: "player",
    role: "PLAYER",
    isActive: true,
    balance: 1000,
    walletVersion: 10,
  });
  const store = useBlackjackStore();
  store.setUser("player");
  store.transport = vi.fn().mockResolvedValue({ round, balance: 900, walletVersion: 9 });
  await store.mutate({ kind: "start", amount: 100 });
  expect(auth.user?.balance).toBe(1000);
});

it("ignores a late response from a previous account and preserves that account recovery", async () => {
  const store = useBlackjackStore();
  store.setUser("a");
  let complete!: (data: { round: BlackjackRound; balance: number; walletVersion: number }) => void;
  store.transport = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = store.mutate({ kind: "start", amount: 100 });
  store.setUser("b");
  complete({ round, balance: 900, walletVersion: 2 });
  await pending;
  expect(store.userId).toBe("b");
  expect(store.round).toBeNull();
  expect(sessionStorage.getItem("blackjack.pending.a")).not.toBeNull();
});
