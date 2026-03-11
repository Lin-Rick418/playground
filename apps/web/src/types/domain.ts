export type UserRole = "ADMIN" | "PLAYER";
export type RoundWinner = "PLAYER" | "BANKER" | "TIE";
export type RoundStatus = "OPEN" | "LOCKED" | "SETTLED";
export type BetType = "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR";
export type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";

export type Card = {
  rank: string;
  suit: string;
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

export type AdminUser = {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  balance: number;
  createdAt: string;
};

export type Adjustment = {
  id: string;
  amount: number;
  note?: string;
  createdAt: string;
  admin: {
    username: string;
  };
  user: {
    username: string;
  };
};

export type RoundBetDetail = {
  id: string;
  userId: string;
  username: string;
  roundId: string;
  betType: BetType;
  amount: number;
  payout: number;
  createdAt: string;
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
