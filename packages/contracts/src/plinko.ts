import { z } from "zod";
import { isMoney } from "./money.js";

const money = z.number().nonnegative().refine(isMoney);
const rows = z.number().int().min(8).max(16);
const multiplier = z
  .number()
  .positive()
  .max(1000)
  .refine((value) => Number(value.toFixed(4)) === value);
export const plinkoRiskSchema = z.enum(["low", "medium", "high"]);
export const plinkoStartRequestSchema = z
  .object({
    amount: z
      .number()
      .int()
      .min(100)
      .max(5000)
      .refine((value) => value % 100 === 0),
    rows,
    risk: plinkoRiskSchema,
    ruleVersion: z.number().int().positive().safe(),
  })
  .strict();

export const plinkoTableSchema = z
  .object({
    rows,
    risk: plinkoRiskSchema,
    multipliers: z.array(multiplier).min(9).max(17),
    rtp: z.number().min(0.95).max(0.96),
  })
  .strict()
  .refine((table) => table.multipliers.length === table.rows + 1);

export const plinkoConfigResponseSchema = z
  .object({
    minRows: z.literal(8),
    maxRows: z.literal(16),
    risks: z.array(plinkoRiskSchema),
    minBet: z.literal(100),
    maxBet: z.literal(5000),
    betStep: z.literal(100),
    // Accept v1 during a frontend-first rollout; new bets use the server-provided version.
    ruleVersion: z.union([z.literal(1), z.literal(2)]),
    enabled: z.boolean(),
    tables: z.array(plinkoTableSchema).min(1).max(27),
  })
  .strict();

export const plinkoRoundSchema = z
  .object({
    id: z.string().uuid(),
    amount: plinkoStartRequestSchema.shape.amount,
    rows,
    risk: plinkoRiskSchema,
    path: z
      .array(z.union([z.literal(0), z.literal(1)]))
      .min(8)
      .max(16),
    slotIndex: z.number().int().min(0).max(16),
    multiplier,
    payout: money,
    ruleVersion: z.number().int().positive().safe(),
    createdAt: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (round) =>
      round.path.length === round.rows &&
      round.path.reduce<number>((sum, direction) => sum + direction, 0) === round.slotIndex,
  );

export const plinkoRoundResponseSchema = z.object({ round: plinkoRoundSchema }).strict();
export const plinkoMutationResponseSchema = z
  .object({
    round: plinkoRoundSchema,
    balance: money,
    walletVersion: z.number().int().nonnegative().safe(),
  })
  .strict();
export const plinkoHistoryResponseSchema = z
  .object({
    items: z.array(plinkoRoundSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type PlinkoRisk = z.infer<typeof plinkoRiskSchema>;
export type PlinkoStartRequest = z.infer<typeof plinkoStartRequestSchema>;
export type PlinkoRound = z.infer<typeof plinkoRoundSchema>;
export type PlinkoConfig = z.infer<typeof plinkoConfigResponseSchema>;
export type PlinkoMutationResponse = z.infer<typeof plinkoMutationResponseSchema>;
