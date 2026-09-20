import { z } from "zod";
export * from "./hilo.js";
import { hiloCommandSchema, hiloMutationResponseSchema } from "./hilo.js";
export * from "./plinko.js";
import { plinkoStartRequestSchema, plinkoMutationResponseSchema } from "./plinko.js";
import { isMoney } from "./money.js";
export { toMinorUnits, fromMinorUnits, minorUnitsToDecimal, sumMoney, isMoney, roundHalfUp } from "./money.js";
export const moneySchema = z.number().refine(isMoney, "Money must have at most two decimal places");

const idSchema = z.string().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const userRoleSchema = z.literal("PLAYER");
export const roundWinnerSchema = z.enum(["PLAYER", "BANKER", "TIE"]);
export const roundStatusSchema = z.enum(["OPEN", "LOCKED", "SETTLED", "CANCELLED"]);
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
    balance: moneySchema,
    walletVersion: z.number().int().nonnegative().safe().optional(),
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
    accessTokenExpiresAt: isoDateTimeSchema,
    user: userSchema,
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
    cancellationReason: z.string().min(1).nullable(),
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
    payout: moneySchema.refine((value) => value >= 0),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const shoeCommitmentSchema = z
  .object({
    version: z.number().int().positive(),
    shoeId: idSchema,
    shuffleAlgorithm: z.string().min(1),
    dealAlgorithm: z.string().min(1),
    deckCount: z.number().int().positive(),
    commitment: z.string().regex(/^[0-9a-f]{64}$/),
    committedAt: isoDateTimeSchema,
  })
  .strict();

export const lobbyTableSchema = z
  .object({
    table: gameTableSchema,
    activeRound: activeRoundSchema.nullable(),
    previousRound: activeRoundSchema.nullable(),
    recentRounds: z.array(activeRoundSchema),
    roadRounds: z.array(activeRoundSchema),
    shoeAudit: shoeCommitmentSchema.nullable(),
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
    shoeAudit: shoeCommitmentSchema.nullable(),
    recentRounds: z.array(activeRoundSchema),
    roadRounds: z.array(activeRoundSchema),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const tableStateResponseSchema = tableSnapshotSchema.extend({
  myBets: z.array(currentBetSchema),
  balance: moneySchema,
    walletVersion: z.number().int().nonnegative().safe().optional(),
  config: roundConfigSchema,
});

export const roundHistoryItemSchema = z
  .object({
    id: idSchema,
    createdAt: isoDateTimeSchema,
    totalAmount: moneySchema.refine((value) => value >= 0),
    totalPayout: moneySchema.refine((value) => value >= 0),
    bets: z.array(currentBetSchema),
    round: z
      .object({
        id: idSchema,
        tableId: idSchema,
        winner: roundWinnerSchema,
        playerCards: z.array(cardSchema),
        bankerCards: z.array(cardSchema),
        playerTotal: z.number().int().min(0).max(9),
        bankerTotal: z.number().int().min(0).max(9),
        playerPair: z.boolean(),
        bankerPair: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const historyResponseSchema = z
  .object({
    items: z.array(roundHistoryItemSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const dailyProfitResponseSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeZone: z.string().min(1),
    windowStart: isoDateTimeSchema,
    windowEnd: isoDateTimeSchema,
    formula: z.literal("TOTAL_PAYOUT_MINUS_TOTAL_BET"),
    recognitionTime: z.literal("ROUND_SETTLED_AT"),
    totalBet: moneySchema.refine((value) => value >= 0),
    totalPayout: moneySchema.refine((value) => value >= 0),
    netProfit: moneySchema,
    calculatedAt: isoDateTimeSchema,
  })
  .strict();

const auditedRoundResultSchema = z
  .object({
    playerCards: z.array(cardSchema),
    bankerCards: z.array(cardSchema),
    playerTotal: z.number().int().min(0).max(9),
    bankerTotal: z.number().int().min(0).max(9),
    winner: roundWinnerSchema,
    playerPair: z.boolean(),
    bankerPair: z.boolean(),
  })
  .strict();

const shoeDealAuditSchema = z
  .object({
    dealIndex: z.number().int().nonnegative(),
    roundId: idSchema,
    dealtCards: z.array(cardSchema),
    result: auditedRoundResultSchema,
    recordedAt: isoDateTimeSchema,
  })
  .strict();

const shoeRevealSchema = z
  .object({
    seed: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().min(1),
    revealedAt: isoDateTimeSchema,
  })
  .strict();

const shoeAuditVerificationSchema = z
  .object({
    valid: z.boolean(),
    status: z.enum(["VALID", "INVALID", "CANCELLED", "UNREVEALED"]),
    commitmentValid: z.boolean(),
    dealSequenceValid: z.boolean(),
    lifecycleValid: z.boolean(),
    verifiedDeals: z.number().int().nonnegative(),
    verifiedCards: z.number().int().nonnegative(),
    remainingCards: z.number().int().nonnegative(),
    errors: z.array(z.string()),
  })
  .strict();

export const shoeAuditResponseSchema = z
  .object({
    version: z.number().int().positive(),
    shoeId: idSchema,
    tableId: idSchema,
    shuffleAlgorithm: z.string().min(1),
    dealAlgorithm: z.string().min(1),
    deckCount: z.number().int().positive(),
    commitment: z.string().regex(/^[0-9a-f]{64}$/),
    committedAt: isoDateTimeSchema,
    cutCardRemaining: z.number().int().nonnegative().nullable(),
    reveal: shoeRevealSchema.nullable(),
    deals: z.array(shoeDealAuditSchema),
    verification: shoeAuditVerificationSchema.nullable(),
  })
  .strict();

export const placeBetResponseSchema = z
  .object({
    table: gameTableSchema,
    round: activeRoundSchema,
    bets: z.array(currentBetSchema),
    balance: moneySchema.refine((value) => value >= 0),
    walletVersion: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

export const apiErrorCodeSchema = z.enum([
  "MALFORMED_JSON",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "VALIDATION_ERROR",
  "AUTHENTICATION_REQUIRED",
  "INVALID_TOKEN",
  "INVALID_CREDENTIALS",
  "FORBIDDEN",
  "ACCOUNT_DISABLED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const apiErrorResponseSchema = z
  .object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

export const tableUserSnapshotSchema = z
  .object({
    tableId: idSchema,
    currentRoundId: z.string(),
    myBets: z.array(currentBetSchema),
    balance: moneySchema,
    walletVersion: z.number().int().nonnegative().safe().optional(),
    isActive: z.boolean(),
    serverTime: isoDateTimeSchema,
  })
  .strict();

export const userSnapshotSchema = userSchema.extend({
  serverTime: isoDateTimeSchema,
});

export const minesStartRequestSchema = z.object({
  amount: z.number().int().min(100).max(5000).refine((value) => value % 100 === 0),
  mineCount: z.number().int().min(3).max(24),
}).strict();
export const minesRevealRequestSchema = z.object({ cellIndex: z.number().int().min(0).max(24) }).strict();
export const minesConfigResponseSchema = z.object({
  boardSize: z.literal(25), minMines: z.literal(3), maxMines: z.literal(24),
  minBet: z.literal(100), maxBet: z.literal(5000), betStep: z.literal(100),
  rtp: z.literal(0.95).nullable(), enabled: z.boolean(),
  ruleVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  maxMultiplier: z.literal(1000).optional(),
}).strict();
export const minesRoundSchema = z.object({
  id: z.string().uuid(), amount: moneySchema, mineCount: z.number().int().min(1).max(24),
  revealedCells: z.array(z.number().int().min(0).max(24)).max(25),
  status: z.enum(["ACTIVE", "LOST", "CASHED_OUT"]), payout: moneySchema,
  cashoutAmount: moneySchema, multiplier: z.number().nonnegative(),
  nextMultiplier: z.number().nonnegative().nullable(),
  mineCells: z.array(z.number().int().min(0).max(24)).nullable(),
  createdAt: isoDateTimeSchema, settledAt: isoDateTimeSchema.nullable(),
  version: z.number().int().positive(), ruleVersion: z.union([z.literal(1), z.literal(2)]),
  settlementReason: z.enum(["MULTIPLIER_LIMIT", "ACCOUNT_LIMIT"]).nullable().optional(),
}).strict();
export const minesActiveResponseSchema = z.object({ round: minesRoundSchema.nullable() }).strict();
export const minesRoundResponseSchema = z.object({ round: minesRoundSchema }).strict();
export const minesMutationResponseSchema = z.object({ round: minesRoundSchema, balance: moneySchema, walletVersion: z.number().int().nonnegative().safe().optional() }).strict();
export const minesHistoryResponseSchema = z.object({ items: z.array(minesRoundSchema), nextCursor: z.string().nullable() }).strict();
export type MinesRound = z.infer<typeof minesRoundSchema>;

// Request IDs correlate a single attempt; idempotency keys survive reconnects.
const gameIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export const minesCommandSchema = z.object({
  type: z.literal("mines_command"),
  requestId: z.string().uuid(),
  idempotencyKey: gameIdempotencyKeySchema,
  action: z.discriminatedUnion("kind", [
    minesStartRequestSchema.extend({ kind: z.literal("start") }).strict(),
    minesRevealRequestSchema.extend({ kind: z.literal("reveal"), roundId: z.string().uuid() }).strict(),
    z.object({ kind: z.literal("cashout"), roundId: z.string().uuid() }).strict(),
  ]),
}).strict();
export const minesCommandResultSchema = z.object({
  type: z.literal("mines_result"),
  requestId: z.string().uuid(),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: minesMutationResponseSchema }).strict(),
    z.object({ ok: z.literal(false), status: z.number().int().min(400).max(599), error: apiErrorResponseSchema }).strict(),
  ]),
}).strict();
export type MinesCommand = z.infer<typeof minesCommandSchema>;
export type MinesCommandResult = z.infer<typeof minesCommandResultSchema>;
export type MinesMutationResponse = z.infer<typeof minesMutationResponseSchema>;

export const plinkoCommandSchema = z
  .object({
    type: z.literal("plinko_command"),
    requestId: z.string().uuid(),
    idempotencyKey: gameIdempotencyKeySchema,
    payload: plinkoStartRequestSchema,
  })
  .strict();
export const plinkoCommandResultSchema = z
  .object({
    type: z.literal("plinko_result"),
    requestId: z.string().uuid(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: plinkoMutationResponseSchema }).strict(),
      z
        .object({
          ok: z.literal(false),
          status: z.number().int().min(400).max(599),
          error: apiErrorResponseSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type PlinkoCommand = z.infer<typeof plinkoCommandSchema>;
export type PlinkoCommandResult = z.infer<typeof plinkoCommandResultSchema>;

export const hiloCommandResultSchema = z.object({
  type: z.literal("hilo_result"), requestId: z.string().uuid(),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: hiloMutationResponseSchema }).strict(),
    z.object({ ok: z.literal(false), status: z.number().int().min(400).max(599), error: apiErrorResponseSchema }).strict(),
  ]),
}).strict();
export type HiloCommandResult = z.infer<typeof hiloCommandResultSchema>;

export const liveClientMessageSchema = z.discriminatedUnion("type", [
  minesCommandSchema,
  plinkoCommandSchema,
  hiloCommandSchema,
  z.object({ type: z.literal("subscribe_user") }).strict(),
  z.object({ type: z.literal("subscribe_lobby") }).strict(),
  z.object({ type: z.literal("subscribe_table"), tableId: idSchema }).strict(),
]);

export const liveServerMessageSchema = z.discriminatedUnion("type", [
  minesCommandResultSchema,
  plinkoCommandResultSchema,
  hiloCommandResultSchema,
  z.object({ type: z.literal("connected"), serverTime: isoDateTimeSchema }).strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("auth_revoked"),
      reason: z.enum(["user_deleted", "account_disabled", "role_changed", "signed_in_elsewhere"]),
    })
    .strict(),
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
export type GameTable = z.infer<typeof gameTableSchema>;
export type ActiveRound = z.infer<typeof activeRoundSchema>;
export type CurrentBet = z.infer<typeof currentBetSchema>;
export type ShoeCommitment = z.infer<typeof shoeCommitmentSchema>;
export type LobbyTable = z.infer<typeof lobbyTableSchema>;
export type RoundConfig = z.infer<typeof roundConfigSchema>;
export type LobbyResponse = z.infer<typeof lobbyResponseSchema>;
export type PresentationWindow = z.infer<typeof presentationWindowSchema>;
export type ShoeStatus = z.infer<typeof shoeStatusSchema>;
export type TableSnapshot = z.infer<typeof tableSnapshotSchema>;
export type TableStateResponse = z.infer<typeof tableStateResponseSchema>;
export type RoundHistoryItem = z.infer<typeof roundHistoryItemSchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
export type DailyProfitResponse = z.infer<typeof dailyProfitResponseSchema>;
export type ShoeAuditResponse = z.infer<typeof shoeAuditResponseSchema>;
export type PlaceBetResponse = z.infer<typeof placeBetResponseSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type TableUserSnapshot = z.infer<typeof tableUserSnapshotSchema>;
export type UserSnapshot = z.infer<typeof userSnapshotSchema>;
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
