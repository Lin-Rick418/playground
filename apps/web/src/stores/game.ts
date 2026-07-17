import { defineStore } from "pinia";
import {
  dailyProfitResponseSchema,
  historyResponseSchema,
  lobbyResponseSchema,
  placeBetResponseSchema,
  tableStateResponseSchema,
} from "@baccarat/contracts";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type {
  ActiveRound,
  BetType,
  CurrentBet,
  DailyProfitSummary,
  GameTable,
  LobbySnapshot,
  LobbyTable,
  PresentationWindow,
  RoundHistoryItem,
  ShoeStatus,
  TableSnapshot,
} from "../types/domain";

export const useGameStore = defineStore("game", {
  state: () => ({
    tables: [] as LobbyTable[],
    currentTable: null as GameTable | null,
    history: [] as RoundHistoryItem[],
    historyNextCursor: null as string | null,
    historyLoadingMore: false,
    historyLoadMoreError: "",
    dailyProfit: null as DailyProfitSummary | null,
    currentRound: null as ActiveRound | null,
    previousRound: null as ActiveRound | null,
    presentation: null as PresentationWindow | null,
    shoeStatus: null as ShoeStatus | null,
    recentRounds: [] as ActiveRound[],
    roadRounds: [] as ActiveRound[],
    currentBets: [] as CurrentBet[],
    serverTime: "",
    loading: false,
    message: "",
    lastSettledRoundId: "",
    pendingBetIdempotencyKeys: {} as Record<string, string>,
  }),
  actions: {
    applyLobbySnapshot(data: LobbySnapshot) {
      this.tables = data.tables;
      this.serverTime = data.serverTime;
    },
    applyTableSnapshot(data: TableSnapshot) {
      const previousCurrentRoundId = this.currentRound?.id ?? "";

      this.currentTable = data.table;
      this.currentRound = data.round;
      this.previousRound = data.previousRound;
      this.presentation = data.presentation;
      this.shoeStatus = data.shoeStatus;
      this.recentRounds = data.recentRounds;
      this.roadRounds = data.roadRounds;
      this.serverTime = data.serverTime;
      this.tables = this.tables.map((item) =>
        item.table.id === data.table.id
          ? {
              ...item,
              activeRound: data.round,
              previousRound: data.previousRound,
              recentRounds: data.recentRounds,
              roadRounds: data.roadRounds,
            }
          : item,
      );

      const latestSettledRoundId = data.previousRound?.id ?? "";
      if (
        previousCurrentRoundId &&
        previousCurrentRoundId !== data.round.id &&
        latestSettledRoundId &&
        latestSettledRoundId !== this.lastSettledRoundId
      ) {
        this.lastSettledRoundId = latestSettledRoundId;
      }
    },
    applyTableUserSnapshot(data: { currentRoundId: string; myBets: CurrentBet[] }) {
      if (!this.currentRound || this.currentRound.id === data.currentRoundId) {
        this.currentBets = data.myBets;
        return;
      }

      this.currentBets = [];
    },
    async fetchLobby() {
      const response = await api.get("/game/lobby");
      const data = parseRuntimeContract(lobbyResponseSchema, response.data, "GET /game/lobby");
      this.applyLobbySnapshot(data);
      return data;
    },
    async fetchState(tableId: string) {
      const response = await api.get(`/game/tables/${tableId}/state`);
      const data = parseRuntimeContract(
        tableStateResponseSchema,
        response.data,
        "GET /game/tables/:tableId/state",
      );
      this.applyTableSnapshot(data);
      this.applyTableUserSnapshot({
        currentRoundId: data.round.id,
        myBets: data.myBets,
      });

      return data;
    },
    async fetchHistory() {
      this.loading = true;
      this.historyLoadMoreError = "";

      try {
        const [historyResult, dailyProfitResult] = await Promise.allSettled([
          api.get("/game/history"),
          api.get("/game/daily-profit"),
        ]);

        if (historyResult.status === "rejected") {
          throw historyResult.reason;
        }

        const historyPage = parseRuntimeContract(
          historyResponseSchema,
          historyResult.value.data,
          "GET /game/history",
        );
        this.history = historyPage.items;
        this.historyNextCursor = historyPage.nextCursor;
        this.dailyProfit = dailyProfitResult.status === "fulfilled"
          ? parseRuntimeContract(
              dailyProfitResponseSchema,
              dailyProfitResult.value.data,
              "GET /game/daily-profit",
            )
          : null;
      } finally {
        this.loading = false;
      }
    },
    async fetchMoreHistory() {
      if (!this.historyNextCursor || this.historyLoadingMore) {
        return;
      }

      this.historyLoadingMore = true;
      this.historyLoadMoreError = "";
      const cursor = this.historyNextCursor;

      try {
        const response = await api.get("/game/history", { params: { cursor } });
        const page = parseRuntimeContract(
          historyResponseSchema,
          response.data,
          "GET /game/history?cursor",
        );
        const existingIds = new Set(this.history.map((item) => item.id));
        this.history.push(...page.items.filter((item) => !existingIds.has(item.id)));
        this.historyNextCursor = page.nextCursor;
      } catch (error) {
        this.historyLoadMoreError = "載入更早紀錄失敗，請重試。";
        throw error;
      } finally {
        this.historyLoadingMore = false;
      }
    },
    async placeBet(tableId: string, payload: { betType: BetType; amount: number }[]) {
      const requestSignature = JSON.stringify({ tableId, roundId: this.currentRound?.id ?? "", bets: payload });
      const idempotencyKey = this.pendingBetIdempotencyKeys[requestSignature] ?? createIdempotencyKey();
      this.pendingBetIdempotencyKeys[requestSignature] = idempotencyKey;

      try {
        const response = await api.post(
          `/game/tables/${tableId}/bet`,
          { bets: payload },
          { headers: { "Idempotency-Key": idempotencyKey } },
        );
        const data = parseRuntimeContract(
          placeBetResponseSchema,
          response.data,
          "POST /game/tables/:tableId/bet",
        );
        delete this.pendingBetIdempotencyKeys[requestSignature];
        if (this.currentRound?.id === data.round.id) {
          this.currentBets = [...this.currentBets, ...data.bets];
        }
        return data;
      } catch (error) {
        if (!shouldReuseIdempotencyKey(error)) {
          delete this.pendingBetIdempotencyKeys[requestSignature];
        }
        throw error;
      }
    },
  },
});
