import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoundHistoryItem } from "../types/domain";
import { useGameStore } from "../stores/game";
import BetHistoryView from "./BetHistoryView.vue";

const back = vi.hoisted(() => vi.fn());

vi.mock("vue-router", () => ({
  useRouter: () => ({ back }),
}));

const createdAt = "2026-07-28T06:00:00.000Z";
let pinia: ReturnType<typeof createPinia>;

function historyItem(id: string, totalPayout: number, totalAmount: number): RoundHistoryItem {
  return {
    id,
    createdAt,
    totalPayout,
    totalAmount,
    bets: [
      {
        id: `bet-${id}`,
        betType: "BANKER",
        amount: totalAmount,
        payout: totalPayout,
        createdAt,
      },
    ],
    round: {
      id: `round-${id}`,
      tableId: "table-1",
      winner: "BANKER",
      playerCards: [
        { rank: "2", suit: "S" },
        { rank: "8", suit: "H" },
      ],
      bankerCards: [
        { rank: "2", suit: "C" },
        { rank: "4", suit: "C" },
      ],
      playerTotal: 0,
      bankerTotal: 6,
      playerPair: false,
      bankerPair: false,
    },
  };
}

beforeEach(() => {
  back.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T07:00:00.000Z"));
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BetHistoryView round net amount", () => {
  it("shows one balance-style coin and the payout-minus-stake result for wins and losses", async () => {
    const gameStore = useGameStore();
    gameStore.history = [historyItem("win", 97_500, 50_000), historyItem("loss", 0, 50_000)];
    vi.spyOn(gameStore, "fetchLobby").mockResolvedValue({
      tables: [],
      config: {
        revealWindowMs: 1_000,
        dealAnimationBufferMs: 600,
        cutCardMinRemaining: 10,
        cutCardMaxRemaining: 20,
        reshuffleRule: "test",
      },
      serverTime: createdAt,
    });
    vi.spyOn(gameStore, "fetchHistory").mockResolvedValue();

    const wrapper = mount(BetHistoryView, {
      global: { plugins: [pinia] },
    });
    await flushPromises();

    const netRows = wrapper.findAll(".round-net");
    expect(netRows).toHaveLength(2);
    expect(netRows[0]!.text()).toBe("$47,500");
    expect(netRows[0]!.attributes("aria-label")).toBe("本局收益 47,500");
    expect(netRows[1]!.text()).toBe("$-50,000");
    expect(netRows[1]!.attributes("aria-label")).toBe("本局收益 -50,000");
    expect(wrapper.findAll(".coin-symbol")).toHaveLength(2);
    expect(wrapper.findAll(".total-list")).toHaveLength(0);
    expect(wrapper.findAll(".total-row")).toHaveLength(0);
    expect(wrapper.findAll(".total-icon.purple")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("97,500");
    expect(wrapper.findAll(".result-hand.three-card-result")).toHaveLength(0);
    expect(wrapper.findAll(".hand-cards.three-card-hand")).toHaveLength(0);
  });
});

describe("BetHistoryView three-card hands", () => {
  it("marks player and banker hands with a third card for the compact single-row layout", async () => {
    const gameStore = useGameStore();
    const item = historyItem("three-card", 0, 100);
    item.round.playerCards.push({ rank: "5", suit: "D" });
    item.round.bankerCards.push({ rank: "6", suit: "H" });
    gameStore.history = [item];
    vi.spyOn(gameStore, "fetchLobby").mockResolvedValue({
      tables: [],
      config: {
        revealWindowMs: 1_000,
        dealAnimationBufferMs: 600,
        cutCardMinRemaining: 10,
        cutCardMaxRemaining: 20,
        reshuffleRule: "test",
      },
      serverTime: createdAt,
    });
    vi.spyOn(gameStore, "fetchHistory").mockResolvedValue();

    const wrapper = mount(BetHistoryView, {
      global: { plugins: [pinia] },
    });
    await flushPromises();

    const hands = wrapper.findAll(".hand-cards");
    expect(hands).toHaveLength(2);
    expect(wrapper.findAll(".result-hand.three-card-result")).toHaveLength(2);
    expect(wrapper.findAll(".hand-cards.three-card-hand")).toHaveLength(2);

    for (const hand of hands) {
      expect(hand.findAll(".hand-card")).toHaveLength(3);
      expect(hand.findAll(".hand-card.bonus")).toHaveLength(1);
    }
  });
});

describe("baccarat history", () => {
  it("loads history and returns to the previous page", async () => {
    const baccarat = useGameStore();
    const fetchBaccarat = vi.spyOn(baccarat, "fetchHistory").mockResolvedValue();
    vi.spyOn(baccarat, "fetchLobby").mockResolvedValue(undefined as never);
    const wrapper = mount(BetHistoryView, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.text()).toContain("近七日沒有投注紀錄");
    expect(fetchBaccarat).toHaveBeenCalledOnce();
    await wrapper.get('[aria-label="返回"]').trigger("click");
    expect(back).toHaveBeenCalledOnce();
  });
});
