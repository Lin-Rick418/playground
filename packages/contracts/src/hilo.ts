import { z } from "zod";
import { isMoney } from "./money.js";

const version = z.number().int().positive().safe();
const money = z.number().nonnegative().refine(isMoney);
export const hiloCardSchema = z.number().int().min(0).max(51);
export const hiloChoiceSchema = z.enum([
  "higher_or_equal",
  "lower_or_equal",
  "higher",
  "lower",
  "same",
]);
export const hiloAmountSchema = z
  .number()
  .int()
  .min(100)
  .max(5000)
  .refine((n) => n % 100 === 0);
const previewRef = { previewId: z.string().uuid(), expectedVersion: version };
const roundRef = { roundId: z.string().uuid(), expectedVersion: version };
export const hiloActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare") }).strict(),
  z.object({ kind: z.literal("refresh_preview"), ...previewRef }).strict(),
  z.object({ kind: z.literal("start"), amount: hiloAmountSchema, ...previewRef }).strict(),
  z.object({ kind: z.literal("guess"), ...roundRef, choice: hiloChoiceSchema }).strict(),
  z.object({ kind: z.literal("skip"), ...roundRef }).strict(),
  z.object({ kind: z.literal("cashout"), ...roundRef }).strict(),
]);
export const hiloCommandSchema = z
  .object({
    type: z.literal("hilo_command"),
    requestId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    action: hiloActionSchema,
  })
  .strict();
export const hiloOptionSchema = z
  .object({
    choice: hiloChoiceSchema,
    winningRanks: z.number().int().min(1).max(12),
    totalRanks: z.literal(13),
    multiplier: z.number().positive(),
    payout: money,
    enabled: z.boolean(),
    reason: z.enum(["MULTIPLIER_LIMIT", "ROUND_ENDED"]).nullable(),
  })
  .strict();
export const hiloPreviewSchema = z
  .object({ id: z.string().uuid(), card: hiloCardSchema, version })
  .strict();
export const hiloStepSchema = z
  .object({
    sequence: version,
    kind: z.enum(["guess", "skip"]),
    fromCard: hiloCardSchema,
    card: hiloCardSchema,
    choice: hiloChoiceSchema.nullable(),
    won: z.boolean().nullable(),
    multiplier: z.number().nonnegative().max(10000),
  })
  .strict();
export const hiloRoundSchema = z
  .object({
    id: z.string().uuid(),
    amount: hiloAmountSchema,
    initialCard: hiloCardSchema,
    card: hiloCardSchema,
    status: z.enum(["ACTIVE", "LOST", "CASHED_OUT"]),
    successCount: z.number().int().min(0).max(116),
    skipCount: z.number().int().min(0).max(52),
    multiplier: z.number().nonnegative().max(10000),
    payout: money,
    cashoutAmount: money,
    options: z.array(hiloOptionSchema).length(2),
    steps: z.array(hiloStepSchema).max(169),
    version,
    ruleVersion: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export const hiloConfigResponseSchema = z
  .object({
    minBet: z.literal(100),
    maxBet: z.literal(5000),
    betStep: z.literal(100),
    rtp: z.literal(0.94),
    maxMultiplier: z.literal(10000),
    maxSkips: z.literal(52),
    ruleVersion: z.literal(1),
    enabled: z.boolean(),
  })
  .strict();
export const hiloStateResponseSchema = z
  .object({ preview: hiloPreviewSchema.nullable(), round: hiloRoundSchema.nullable() })
  .strict();
export const hiloMutationResponseSchema = hiloStateResponseSchema
  .extend({ balance: money, walletVersion: z.number().int().nonnegative().safe() })
  .strict();
export const hiloRoundResponseSchema = z.object({ round: hiloRoundSchema }).strict();
export const hiloHistoryResponseSchema = z
  .object({ items: z.array(hiloRoundSchema).max(50), nextCursor: z.string().nullable() })
  .strict();
export type HiloChoice = z.infer<typeof hiloChoiceSchema>;
export type HiloAction = z.infer<typeof hiloActionSchema>;
export type HiloCommand = z.infer<typeof hiloCommandSchema>;
export type HiloRound = z.infer<typeof hiloRoundSchema>;
export type HiloPreview = z.infer<typeof hiloPreviewSchema>;
export type HiloConfig = z.infer<typeof hiloConfigResponseSchema>;
export type HiloMutationResponse = z.infer<typeof hiloMutationResponseSchema>;
