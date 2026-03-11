export const userRoles = ["ADMIN", "PLAYER"] as const;
export const roundWinners = ["PLAYER", "BANKER", "TIE"] as const;
export const betTypes = ["PLAYER", "BANKER", "TIE", "PLAYER_PAIR", "BANKER_PAIR"] as const;
export const roundStatuses = ["OPEN", "LOCKED", "SETTLED"] as const;

export type UserRole = (typeof userRoles)[number];
export type RoundWinner = (typeof roundWinners)[number];
export type BetType = (typeof betTypes)[number];
export type RoundStatus = (typeof roundStatuses)[number];

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

export type GameRoundRecord = {
  id: string;
  tableId: string;
  shoeId: string;
  playerCards: { rank: string; suit: string }[];
  bankerCards: { rank: string; suit: string }[];
  playerTotal: number;
  bankerTotal: number;
  winner: RoundWinner;
  playerPair: boolean;
  bankerPair: boolean;
  status: RoundStatus;
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
  minBet: number;
  maxBet: number;
  createdAt: string;
};
