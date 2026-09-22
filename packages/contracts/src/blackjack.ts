import { z } from "zod";
import { isMoney } from "./money.js";
const money = z.number().nonnegative().refine(isMoney);
const version = z.number().int().positive().safe();
const card = z.number().int().min(0).max(51);
const ref = { roundId: z.string().uuid(), expectedVersion: version };
const handRef = { ...ref, handId: z.string().uuid() };
export const blackjackAmountSchema = z
  .number()
  .int()
  .min(100)
  .max(5000)
  .refine((n) => n % 100 === 0);
export const blackjackActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), amount: blackjackAmountSchema }).strict(),
  z.object({ kind: z.literal("hit"), ...handRef }).strict(),
  z.object({ kind: z.literal("stand"), ...handRef }).strict(),
  z.object({ kind: z.literal("double"), ...handRef }).strict(),
  z.object({ kind: z.literal("split"), ...handRef }).strict(),
  z.object({ kind: z.literal("insurance"), ...ref, accept: z.boolean() }).strict(),
]);
export const blackjackCommandSchema = z
  .object({
    type: z.literal("blackjack_command"),
    requestId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    action: blackjackActionSchema,
  })
  .strict();
export const blackjackHandSchema = z
  .object({
    id: z.string().uuid(),
    cards: z.array(card).min(2).max(22),
    amount: money,
    total: z.number().int().nonnegative(),
    soft: z.boolean(),
    status: z.enum(["PLAYING", "STOOD", "BUST"]),
    split: z.boolean(),
    splitAces: z.boolean(),
    doubled: z.boolean(),
    outcome: z.enum(["PENDING", "WIN", "LOSE", "PUSH", "BLACKJACK"]),
    payout: money,
  })
  .strict();
export const blackjackRoundSchema = z
  .object({
    id: z.string().uuid(),
    amount: blackjackAmountSchema,
    totalBet: money,
    payout: money,
    status: z.enum(["ACTIVE", "SETTLED"]),
    phase: z.enum(["INSURANCE", "PLAYER_TURN", "SETTLED"]),
    dealerCards: z.array(card).min(1).max(22),
    dealerTotal: z.number().int().nonnegative().nullable(),
    dealerSoft: z.boolean().nullable(),
    dealerHidden: z.boolean(),
    hands: z.array(blackjackHandSchema).min(1).max(4),
    activeHandId: z.string().uuid().nullable(),
    insurance: z.object({ amount: money, payout: money, decided: z.boolean() }).strict(),
    allowedActions: z.array(z.enum(["hit", "stand", "double", "split", "insurance"])),
    version,
    ruleVersion: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export const blackjackConfigResponseSchema = z
  .object({
    minBet: z.literal(100),
    maxBet: z.literal(5000),
    betStep: z.literal(100),
    decks: z.literal(6),
    maxHands: z.literal(4),
    ruleVersion: z.literal(1),
    enabled: z.boolean(),
    rtp: z.null(),
  })
  .strict();
export const blackjackStateResponseSchema = z
  .object({ round: blackjackRoundSchema.nullable() })
  .strict();
export const blackjackRoundResponseSchema = z.object({ round: blackjackRoundSchema }).strict();
export const blackjackMutationResponseSchema = blackjackRoundResponseSchema
  .extend({ balance: money, walletVersion: z.number().int().nonnegative().safe() })
  .strict();
export const blackjackHistoryResponseSchema = z
  .object({ items: z.array(blackjackRoundSchema).max(50), nextCursor: z.string().nullable() })
  .strict();
export type BlackjackAction = z.infer<typeof blackjackActionSchema>;
export type BlackjackCommand = z.infer<typeof blackjackCommandSchema>;
export type BlackjackRound = z.infer<typeof blackjackRoundSchema>;
export type BlackjackHand = z.infer<typeof blackjackHandSchema>;
export type BlackjackConfig = z.infer<typeof blackjackConfigResponseSchema>;
export type BlackjackMutationResponse = z.infer<typeof blackjackMutationResponseSchema>;
