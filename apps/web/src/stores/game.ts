import { defineStore } from "pinia";
import { lobbyResponseSchema, tableStateResponseSchema } from "@baccarat/contracts";
import { api } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type {
  ActiveRound,
  BetType,
  CurrentBet,
  GameTable,
  LobbySnapshot,
  LobbyTable,
  PlaceBetResponse,
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

      try {
        const { data } = await api.get<RoundHistoryItem[]>("/game/history");
        this.history = data;
      } finally {
        this.loading = false;
      }
    },
    async placeBet(tableId: string, payload: { betType: BetType; amount: number }[]) {
      const { data } = await api.post<PlaceBetResponse>(`/game/tables/${tableId}/bet`, { bets: payload });
      if (this.currentRound?.id === data.round.id) {
        this.currentBets = [...this.currentBets, ...data.bets];
      }
      return data;
    },
  },
});
