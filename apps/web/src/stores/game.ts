import { defineStore } from "pinia";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import type {
  ActiveRound,
  BetType,
  CurrentBet,
  GameTable,
  LobbySnapshot,
  LobbyTable,
  PlaceBetResponse,
  PresentationWindow,
  RoundConfig,
  RoundHistoryItem,
  ShoeStatus,
  TableSnapshot,
  TableStateResponse,
} from "../types/domain";

export const useGameStore = defineStore("game", {
  state: () => ({
    tables: [] as LobbyTable[],
    currentTable: null as GameTable | null,
    history: [] as RoundHistoryItem[],
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
      const { data } = await api.get<LobbySnapshot & { config: RoundConfig }>("/game/lobby");
      this.applyLobbySnapshot(data);
      return data;
    },
    async fetchState(tableId: string) {
      const { data } = await api.get<TableStateResponse>(`/game/tables/${tableId}/state`);
      this.applyTableSnapshot(data);
      this.applyTableUserSnapshot({
        currentRoundId: data.round.id,
        myBets: data.myBets,
      });

      return data;
    },
    async fetchHistory() {
      this.loading = true;

      try {
        const { data } = await api.get<RoundHistoryItem[]>("/game/history");
        this.history = data;
      } finally {
        this.loading = false;
      }
    },
    async placeBet(tableId: string, payload: { betType: BetType; amount: number }[]) {
      const requestSignature = JSON.stringify({ tableId, roundId: this.currentRound?.id ?? "", bets: payload });
      const idempotencyKey = this.pendingBetIdempotencyKeys[requestSignature] ?? createIdempotencyKey();
      this.pendingBetIdempotencyKeys[requestSignature] = idempotencyKey;

      try {
        const { data } = await api.post<PlaceBetResponse>(
          `/game/tables/${tableId}/bet`,
          { bets: payload },
          { headers: { "Idempotency-Key": idempotencyKey } },
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
