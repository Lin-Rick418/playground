import type {
  ActiveRound,
  Card,
  CurrentBet,
  GameTable,
  RoundWinner,
} from "@baccarat/contracts";

export type {
  ActiveRound,
  BetType,
  Card,
  CurrentBet,
  GameTable,
  LobbyTable,
  LoginResponse,
  LobbyResponse as LobbySnapshot,
  PresentationWindow,
  RoundConfig,
  RoundStatus,
  RoundWinner,
  ShoeStatus,
  TableSnapshot,
  TableStateResponse,
  User,
  UserRole,
} from "@baccarat/contracts";
export type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";

export type RoundHistoryItem = {
  id: string;
  createdAt: string;
  totalAmount: number;
  totalPayout: number;
  bets: CurrentBet[];
  round: {
    id: string;
    tableId: string;
    winner: RoundWinner;
    playerCards: Card[];
    bankerCards: Card[];
    playerTotal: number;
    bankerTotal: number;
    playerPair: boolean;
    bankerPair: boolean;
  };
};

export type DailyProfitSummary = {
  date: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  formula: "TOTAL_PAYOUT_MINUS_TOTAL_BET";
  recognitionTime: "ROUND_SETTLED_AT";
  totalBet: number;
  totalPayout: number;
  netProfit: number;
  calculatedAt: string;
};

export type RoadVisibilitySettings = {
  beadRoad: boolean;
  bigRoad: boolean;
  bigEyeRoad: boolean;
  smallRoad: boolean;
  cockroachRoad: boolean;
};

export type PlaceBetResponse = {
  table: GameTable;
  round: ActiveRound;
  bets: CurrentBet[];
  balance: number;
};
