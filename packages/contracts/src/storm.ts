import { z } from "zod";
import { isMoney } from "./money.js";
import { stormSettingsSchema } from "./storm-settings.js";
import { stormTargetRtpSchema, STORM_MAX_PAYOUT_SCALE } from "./storm-rtp.js";

export const STORM_STAKES = [10, 50, 100, 200, 500, 1000, 2000, 5000] as const;
// Retain 20 for existing clients, pending actions, history and pinned free series.
const supportedStakes = [...STORM_STAKES, 20] as const;
const stakeSet = new Set<number>(supportedStakes);
export const isStormStake = (amount: number) => stakeSet.has(amount);
export const STORM_RULE_VERSION = 1;
export const STORM_MAX_WIN_FACTOR = 25000;
export const STORM_PAY = {
  ruby: 12,
  emerald: 10,
  sapphire: 5,
  amber: 6,
  lotus: 8,
  scarab: 4,
  sun: 20,
  moon: 15,
} as const;
export const STORM_LABELS = {
  ruby: "紅寶石",
  emerald: "翡翠",
  sapphire: "藍晶",
  amber: "琥珀",
  lotus: "蓮花",
  scarab: "聖甲蟲",
  scatter: "神殿",
  gold: "超級神殿",
  sun: "日之守衛",
  moon: "月之守衛",
  orb: "倍數球",
} as const;
const money = z.number().nonnegative().max(2000000000).refine(isMoney);
const integer = z.number().int().nonnegative().safe();
export const stormAmountSchema = z.literal(supportedStakes);
export const stormSymbolSchema = z.enum([
  "ruby",
  "emerald",
  "sapphire",
  "amber",
  "lotus",
  "scarab",
  "scatter",
  "gold",
  "sun",
  "moon",
  "orb",
]);
export const stormTileSchema = z
  .object({
    id: integer,
    kind: stormSymbolSchema,
    value: z.number().int().min(2).max(1000).optional(),
  })
  .strict()
  .refine((t) => (t.kind === "orb" ? t.value !== undefined : t.value === undefined));
const board = z.array(stormTileSchema).length(30);
export const stormProgressSchema = z
  .object({
    freeLeft: integer.max(100),
    freeGranted: integer.max(100),
    feature: z.enum(["normal", "super"]),
    multiplier: integer.max(3000000),
    featureWin: money,
    cycleWin: money.optional(),
  })
  .strict()
  .refine((s) => s.freeLeft <= s.freeGranted);
export const initialStormProgress = () => ({
  freeLeft: 0,
  freeGranted: 0,
  feature: "normal" as const,
  multiplier: 0,
  featureWin: 0,
});
export const stormMathProfileSchema = z
  .object({
    id: z.string().uuid(),
    modelRevision: z.enum(["balanced-2.0", "configurable-3.0"]),
    targetRtp: stormTargetRtpSchema,
    maxWinFactor: z.number().int().min(100).max(25000),
    payoutScale: z.number().int().min(0).max(STORM_MAX_PAYOUT_SCALE),
    settings: stormSettingsSchema.optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.modelRevision === "configurable-3.0" ? p.settings !== undefined : p.settings === undefined,
    "設定與數學模型不符",
  )
  .refine(
    (p) => (p.targetRtp === 0 ? p.payoutScale === 0 : p.payoutScale > 0),
    "零 RTP 必須使用零派彩係數",
  )
  .refine(
    (p) =>
      p.modelRevision !== "balanced-2.0" ||
      (p.targetRtp >= 80 && p.targetRtp <= 99 && p.payoutScale >= 1 && p.payoutScale <= 10000000),
    "舊模型使用原始參數範圍",
  );
const ruleVersion = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const stormSessionSchema = z
  .object({
    progress: stormProgressSchema,
    amount: stormAmountSchema,
    version: integer,
    ruleVersion,
    mathProfile: stormMathProfileSchema.nullable().optional(),
  })
  .strict();
const group = z
  .object({ kind: stormSymbolSchema, count: integer.min(8).max(30), win: money })
  .strict();
export const stormSpinResultSchema = z
  .object({
    state: stormProgressSchema.safeExtend({ balance: money }),
    frames: z
      .array(
        z
          .object({
            board,
            winners: z.array(integer.max(29)).max(30),
            win: money,
            groups: z.array(group).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(13),
    board,
    payout: money,
    baseWin: money,
    factor: integer.min(1).max(3030000),
    collected: integer.max(30000),
    upgrades: z
      .array(
        z
          .object({ id: integer, from: integer.min(2).max(999), to: integer.min(3).max(1000) })
          .strict(),
      )
      .max(270),
    awarded: integer.max(15),
    wasFree: z.boolean(),
    capped: z.boolean(),
    bonusWin: money,
    bonusCount: integer.max(4),
    cost: money,
    limited: z.boolean(),
  })
  .strict();
export const stormRoundSchema = z
  .object({
    id: z.string().uuid(),
    amount: stormAmountSchema,
    version: integer.min(1),
    ruleVersion,
    mathProfileId: z.string().uuid().nullable().optional(),
    result: stormSpinResultSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
const historyEntry = z
  .object({
    id: z.string().uuid(),
    amount: money,
    stake: stormAmountSchema,
    payout: money,
    wasFree: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const stormStateResponseSchema = z
  .object({
    session: stormSessionSchema,
    lastRound: stormRoundSchema.nullable(),
    recent: z.array(historyEntry).max(5),
    balance: money,
    walletVersion: integer,
  })
  .strict();
export const stormConfigResponseSchema = z
  .object({
    stakes: z.array(stormAmountSchema).min(1).max(supportedStakes.length),
    enabled: z.boolean(),
    ruleVersion,
    maxWinFactor: z.number().int().min(100).max(25000),
    rtp: z.null(),
    mathProfile: stormMathProfileSchema.nullable().optional(),
  })
  .strict();
export const stormActionSchema = z
  .object({
    kind: z.literal("spin"),
    amount: stormAmountSchema,
    expectedVersion: integer,
    ruleVersion,
    mathProfileId: z.string().uuid().nullable().optional(),
  })
  .strict();
export const stormCommandSchema = z
  .object({
    type: z.literal("storm_command"),
    requestId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    action: stormActionSchema,
  })
  .strict();
export const stormMutationResponseSchema = z
  .object({
    session: stormSessionSchema,
    round: stormRoundSchema,
    balance: money,
    walletVersion: integer,
  })
  .strict();
export type StormTile = z.infer<typeof stormTileSchema>;
export type StormSymbol = z.infer<typeof stormSymbolSchema>;
export type StormProgress = z.infer<typeof stormProgressSchema>;
export type StormSession = z.infer<typeof stormSessionSchema>;
export type StormSpinResult = z.infer<typeof stormSpinResultSchema>;
export type StormRound = z.infer<typeof stormRoundSchema>;
export type StormAction = z.infer<typeof stormActionSchema>;
export type StormCommand = z.infer<typeof stormCommandSchema>;
export type StormMutationResponse = z.infer<typeof stormMutationResponseSchema>;
export type StormStateResponse = z.infer<typeof stormStateResponseSchema>;
export type StormConfig = z.infer<typeof stormConfigResponseSchema>;
export type StormMathProfile = z.infer<typeof stormMathProfileSchema>;
