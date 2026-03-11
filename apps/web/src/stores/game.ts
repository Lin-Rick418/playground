import { defineStore } from "pinia";
import { api } from "../lib/api";

export type RoundHistoryItem = {
  id: string;
  createdAt: string;
  totalAmount: number;
  totalPayout: number;
  bets: {
    id: string;
    betType: "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR";
    amount: number;
    payout: number;
    createdAt: string;
  }[];
  round: {
    id: string;
    tableId: string;
    winner: "PLAYER" | "BANKER" | "TIE";
    playerCards: { rank: string; suit: string }[];
    bankerCards: { rank: string; suit: string }[];
    playerTotal: number;
    bankerTotal: number;
    playerPair: boolean;
    bankerPair: boolean;
  };
};

export type ActiveRound = {
  id: string;
  tableId: string;
  shoeId: string;
  status: "OPEN" | "LOCKED" | "SETTLED";
  bettingOpensAt: string;
  bettingClosesAt: string;
  settledAt: string | null;
  playerCards: { rank: string; suit: string }[];
  bankerCards: { rank: string; suit: string }[];
  playerTotal: number;
  bankerTotal: number;
  winner: "PLAYER" | "BANKER" | "TIE";
  playerPair: boolean;
  bankerPair: boolean;
  createdAt: string;
};

export type GameTable = {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  roundDurationMs: number;
  minBet: number;
  maxBet: number;
  createdAt: string;
};

export type LobbyTable = {
  table: GameTable;
  activeRound: ActiveRound | null;
  previousRound: ActiveRound | null;
  recentRounds: ActiveRound[];
  roadRounds: ActiveRound[];
};

export type PresentationWindow = {
  startsAt: string;
  endsAt: string;
};

export type ShoeStatus = {
  isLastHand: boolean;
  cutCardReached: boolean;
};

export type CurrentBet = {
  id: string;
  betType: "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR";
  amount: number;
  payout: number;
  createdAt: string;
};

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
    async fetchLobby() {
      const { data } = await api.get("/game/lobby");
      this.tables = data.tables;
      this.serverTime = data.serverTime;
      return data;
    },
    async fetchState(tableId: string) {
      const { data } = await api.get(`/game/tables/${tableId}/state`);
      const previousCurrentRoundId = this.currentRound?.id ?? "";

      this.currentTable = data.table;
      this.currentRound = data.round;
      this.previousRound = data.previousRound;
      this.presentation = data.presentation;
      this.shoeStatus = data.shoeStatus;
      this.recentRounds = data.recentRounds;
      this.roadRounds = data.roadRounds;
      this.currentBets = data.myBets;
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
        this.message = `第 ${latestSettledRoundId.slice(0, 8)} 局已結算`;
      }

      return data;
    },
    async fetchHistory() {
      this.loading = true;

      try {
        const { data } = await api.get("/game/history");
        this.history = data;
      } finally {
        this.loading = false;
      }
    },
    async placeBet(tableId: string, payload: { betType: "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR"; amount: number }[]) {
      const { data } = await api.post(`/game/tables/${tableId}/bet`, { bets: payload });
      this.message = `已下注到局號 ${data.round.id.slice(0, 8)}`;
      if (this.currentRound?.id === data.round.id) {
        this.currentBets = [...this.currentBets, ...data.bets];
      }
      return data;
    },
  },
});
