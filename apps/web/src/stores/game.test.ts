import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { ActiveRound, CurrentBet, GameTable } from "../types/domain";
import { useGameStore } from "./game";

const now = "2026-07-21T06:00:00.000Z";
const table: GameTable = {
  id: "table-1",
  code: "A01",
  name: "極速廳 A01",
  displayOrder: 1,
  roundDurationMs: 15_000,
  roundPhaseOffsetMs: 0,
  roundScheduleVersion: 1,
  minBet: 100,
  maxBet: 10_000,
  createdAt: now,
};
const round: ActiveRound = {
  id: "round-1",
  tableId: table.id,
  shoeId: "shoe-1",
  status: "OPEN",
  cancellationReason: null,
  bettingOpensAt: now,
  bettingClosesAt: "2026-07-21T06:00:15.000Z",
  settledAt: null,
  playerCards: [],
  bankerCards: [],
  playerTotal: 0,
  bankerTotal: 0,
  winner: "TIE",
  playerPair: false,
  bankerPair: false,
  createdAt: now,
};
const previousBet: CurrentBet = {
  id: "bet-previous",
  betType: "PLAYER",
  amount: 500,
  payout: 1_000,
  createdAt: now,
};
const placedBet: CurrentBet = {
  id: "bet-placed",
  betType: "BANKER",
  amount: 10_000,
  payout: 19_500,
  createdAt: now,
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

describe("game store", () => {
  it("does not duplicate a bet when the live snapshot arrives before the bet response", async () => {
    const store = useGameStore();
    store.currentRound = round;

    let resolveRequest!: (response: { data: unknown }) => void;
    vi.spyOn(api, "post").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const request = store.placeBet(table.id, [
      { betType: placedBet.betType, amount: placedBet.amount },
    ]);

    store.applyTableUserSnapshot({
      currentRoundId: round.id,
      myBets: [previousBet, placedBet],
    });
    resolveRequest({
      data: {
        table,
        round,
        bets: [placedBet],
        balance: 89_500,
      },
    });

    await expect(request).resolves.toMatchObject({ bets: [placedBet] });
    expect(store.currentBets).toEqual([previousBet, placedBet]);
  });
});
