import { z } from "zod";

const idSchema = z.string().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const userRoleSchema = z.enum(["ADMIN", "PLAYER"]);
export const roundWinnerSchema = z.enum(["PLAYER", "BANKER", "TIE"]);
export const roundStatusSchema = z.enum(["OPEN", "LOCKED", "SETTLED"]);
export const betTypeSchema = z.enum(["PLAYER", "BANKER", "TIE", "PLAYER_PAIR", "BANKER_PAIR"]);
export const cardRankSchema = z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]);
export const cardSuitSchema = z.enum(["S", "H", "D", "C"]);

export const cardSchema = z
  .object({
    rank: cardRankSchema,
    suit: cardSuitSchema,
  })
  .strict();

export const userSchema = z
  .object({
    id: idSchema,
    username: z.string().min(1),
    role: userRoleSchema,
    isActive: z.boolean(),
    balance: z.number().int(),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

export const loginResponseSchema = z
  .object({
    token: z.string().min(1),
    user: userSchema,
  })
  .strict();

export const adminUserSchema = userSchema.extend({
  createdAt: isoDateTimeSchema,
});

export const adminUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const paginationSchema = z
  .object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict();

export const adminUsersResponseSchema = z
  .object({
    items: z.array(adminUserSchema),
    pagination: paginationSchema,
  })
  .strict();

export const gameTableSchema = z
  .object({
    id: idSchema,
    code: z.string().min(1),
    name: z.string().min(1),
    displayOrder: z.number().int(),
    roundDurationMs: z.number().int().positive(),
    roundPhaseOffsetMs: z.number().int().nonnegative(),
    roundScheduleVersion: z.number().int().nonnegative(),
    minBet: z.number().int().nonnegative(),
    maxBet: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const activeRoundSchema = z
  .object({
    id: idSchema,
    tableId: idSchema,
    shoeId: z.string(),
    status: roundStatusSchema,
    bettingOpensAt: isoDateTimeSchema,
    bettingClosesAt: isoDateTimeSchema,
    settledAt: isoDateTimeSchema.nullable(),
    playerCards: z.array(cardSchema),
    bankerCards: z.array(cardSchema),
    playerTotal: z.number().int().min(0).max(9),
    bankerTotal: z.number().int().min(0).max(9),
    winner: roundWinnerSchema,
    playerPair: z.boolean(),
    bankerPair: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const currentBetSchema = z
  .object({
    id: idSchema,
    betType: betTypeSchema,
    amount: z.number().int().positive(),
    payout: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const lobbyTableSchema = z
  .object({
    table: gameTableSchema,
    activeRound: activeRoundSchema.nullable(),
    previousRound: activeRoundSchema.nullable(),
    recentRounds: z.array(activeRoundSchema),
    roadRounds: z.array(activeRoundSchema),
  })
  .strict();

export const roundConfigSchema = z
  .object({
    revealWindowMs: z.number().int().nonnegative(),
    dealAnimationBufferMs: z.number().int().nonnegative(),
    cutCardMinRemaining: z.number().int().nonnegative(),
    cutCardMaxRemaining: z.number().int().nonnegative(),
    reshuffleRule: z.string().min(1),
  })
  .strict();

export const lobbyResponseSchema = z
  .object({
    tables: z.array(lobbyTableSchema),
    config: roundConfigSchema,
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const presentationWindowSchema = z
  .object({
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
  })
  .strict();

export const shoeStatusSchema = z
  .object({
    isLastHand: z.boolean(),
    cutCardReached: z.boolean(),
  })
  .strict();

export const tableSnapshotSchema = z
  .object({
    table: gameTableSchema,
    round: activeRoundSchema,
    previousRound: activeRoundSchema.nullable(),
    presentation: presentationWindowSchema.nullable(),
    shoeStatus: shoeStatusSchema,
    recentRounds: z.array(activeRoundSchema),
    roadRounds: z.array(activeRoundSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const tableStateResponseSchema = tableSnapshotSchema.extend({
  myBets: z.array(currentBetSchema),
  balance: z.number().int(),
  config: roundConfigSchema,
});

export const tableUserSnapshotSchema = z
  .object({
    tableId: idSchema,
    currentRoundId: z.string(),
    myBets: z.array(currentBetSchema),
    balance: z.number().int(),
    isActive: z.boolean(),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const userSnapshotSchema = userSchema.extend({
  serverTime: isoDateTimeSchema,
});

export const liveClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe_lobby") }).strict(),
  z.object({ type: z.literal("subscribe_table"), tableId: idSchema }).strict(),
]);

export const liveServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected"), serverTime: isoDateTimeSchema }).strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1) }).strict(),
  z.object({ type: z.literal("lobby_snapshot"), data: lobbyResponseSchema }).strict(),
  z
    .object({
      type: z.literal("table_snapshot"),
      data: tableSnapshotSchema.extend({ config: roundConfigSchema }),
    })
    .strict(),
  z.object({ type: z.literal("table_user_snapshot"), data: tableUserSnapshotSchema }).strict(),
  z.object({ type: z.literal("user_snapshot"), data: userSnapshotSchema }).strict(),
]);

export type UserRole = z.infer<typeof userRoleSchema>;
export type RoundWinner = z.infer<typeof roundWinnerSchema>;
export type RoundStatus = z.infer<typeof roundStatusSchema>;
export type BetType = z.infer<typeof betTypeSchema>;
export type Card = z.infer<typeof cardSchema>;
export type User = z.infer<typeof userSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;
export type GameTable = z.infer<typeof gameTableSchema>;
export type ActiveRound = z.infer<typeof activeRoundSchema>;
export type CurrentBet = z.infer<typeof currentBetSchema>;
export type LobbyTable = z.infer<typeof lobbyTableSchema>;
export type RoundConfig = z.infer<typeof roundConfigSchema>;
export type LobbyResponse = z.infer<typeof lobbyResponseSchema>;
export type PresentationWindow = z.infer<typeof presentationWindowSchema>;
export type ShoeStatus = z.infer<typeof shoeStatusSchema>;
export type TableSnapshot = z.infer<typeof tableSnapshotSchema>;
export type TableStateResponse = z.infer<typeof tableStateResponseSchema>;
export type TableUserSnapshot = z.infer<typeof tableUserSnapshotSchema>;
export type UserSnapshot = z.infer<typeof userSnapshotSchema>;
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
