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
} from "@baccarat/contracts";
export type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";

export type RoadVisibilitySettings = {
  beadRoad: boolean;
  bigRoad: boolean;
  bigEyeRoad: boolean;
  smallRoad: boolean;
  cockroachRoad: boolean;
};
