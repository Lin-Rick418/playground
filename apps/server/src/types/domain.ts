export const userRoles = ["ADMIN", "PLAYER"] as const;
export const roundWinners = ["PLAYER", "BANKER", "TIE"] as const;
export const betTypes = ["PLAYER", "BANKER", "TIE", "PLAYER_PAIR", "BANKER_PAIR"] as const;
export const roundStatuses = ["OPEN", "LOCKED", "SETTLED", "CANCELLED"] as const;

export type UserRole = (typeof userRoles)[number];
export type RoundWinner = (typeof roundWinners)[number];
export type BetType = (typeof betTypes)[number];
export type RoundStatus = (typeof roundStatuses)[number];
export type CardRank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
export type CardSuit = "S" | "H" | "D" | "C";

export type Card = {
  rank: CardRank;
  suit: CardSuit;
};

export type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  balance: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicUserRecord = Omit<UserRecord, "passwordHash">;

export type GameRoundRecord = {
  id: string;
  tableId: string;
  shoeId: string;
  playerCards: Card[];
  bankerCards: Card[];
  playerTotal: number;
  bankerTotal: number;
  winner: RoundWinner;
  playerPair: boolean;
  bankerPair: boolean;
  status: RoundStatus;
  cancellationReason: string | null;
  bettingOpensAt: string;
  bettingClosesAt: string;
  settledAt: string | null;
  createdAt: string;
};

export type GameTableRecord = {
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
