export type UserRole = "PLAYER";
export type RoundWinner = "PLAYER" | "BANKER" | "TIE";
export type RoundStatus = "OPEN" | "LOCKED" | "SETTLED";
export type BetType = "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR";
export type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";

export type CardRank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
export type CardSuit = "S" | "H" | "D" | "C";

export type Card = {
  rank: CardRank;
  suit: CardSuit;
};

export type User = {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  balance: number;
};

export type ActiveRound = {
  id: string;
  tableId: string;
  shoeId: string;
  status: RoundStatus;
  bettingOpensAt: string;
  bettingClosesAt: string;
  settledAt: string | null;
  playerCards: Card[];
  bankerCards: Card[];
  playerTotal: number;
  bankerTotal: number;
  winner: RoundWinner;
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
  roundPhaseOffsetMs: number;
  roundScheduleVersion: number;
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
  betType: BetType;
  amount: number;
  payout: number;
  createdAt: string;
};

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

export type RoundConfig = {
  revealWindowMs: number;
  dealAnimationBufferMs: number;
  cutCardMinRemaining: number;
  cutCardMaxRemaining: number;
  reshuffleRule: string;
};

export type LoginResponse = {
  token: string;
  accessTokenExpiresAt: string;
  user: User;
};

export type LobbySnapshot = {
  tables: LobbyTable[];
  serverTime: string;
};

export type TableSnapshot = {
  table: GameTable;
  round: ActiveRound;
  previousRound: ActiveRound | null;
  presentation: PresentationWindow | null;
  shoeStatus: ShoeStatus;
  recentRounds: ActiveRound[];
  roadRounds: ActiveRound[];
  serverTime: string;
};

export type TableStateResponse = TableSnapshot & {
  myBets: CurrentBet[];
  balance: number;
  config: RoundConfig;
};

export type PlaceBetResponse = {
  table: GameTable;
  round: ActiveRound;
  bets: CurrentBet[];
  balance: number;
};
