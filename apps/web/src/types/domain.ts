import type { PlinkoRisk } from "@baccarat/contracts";

export type {
  ActiveRound,
  BetType,
  Card,
  CurrentBet,
  DailyProfitResponse as DailyProfitSummary,
  GameTable,
  HistoryResponse,
  LobbyTable,
  LoginResponse,
  LobbyResponse as LobbySnapshot,
  PlaceBetResponse,
  PresentationWindow,
  RoundConfig,
  RoundHistoryItem,
  RoundStatus,
  RoundWinner,
  ShoeAuditResponse,
  ShoeStatus,
  TableSnapshot,
  TableStateResponse,
  User,
  UserRole,
  MinesRound,
  PlinkoRound,
} from "@baccarat/contracts";
export type { PlinkoRisk } from "@baccarat/contracts";
export type MinesConfig = {
  boardSize: 25; minMines: 3; maxMines: 24; minBet: 100; maxBet: 5000;
  betStep: 100; rtp: 0.95; enabled: boolean;
};
export type PlinkoConfig = {
  minRows: 8; maxRows: 16; risks: PlinkoRisk[]; minBet: 100; maxBet: 5000; betStep: 100;
  ruleVersion: 1; enabled: boolean;
  tables: Array<{ rows: number; risk: PlinkoRisk; multipliers: number[]; rtp: number }>;
};
export type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";

export type RoadVisibilitySettings = {
  beadRoad: boolean;
  bigRoad: boolean;
  bigEyeRoad: boolean;
  smallRoad: boolean;
  cockroachRoad: boolean;
};
