import { z } from "zod";
import { STORM_STAKES } from "./storm.js";
import {
  STORM_BALANCED_SETTINGS,
  STORM_LEGACY_SETTINGS,
  stormSettingsSchema,
} from "./storm-settings.js";

export const STORM_PRESET_REVISION = "fixed-symbols-1";
export const STORM_FIXED_MAX_WIN_FACTOR = 25000;
export const stormPrizeStyleSchema = z.enum(["low", "high"]);
export type StormPrizeStyle = z.infer<typeof stormPrizeStyleSchema>;
export const STORM_PRIZE_STYLE_LABELS = {
  low: "小獎多、大獎少",
  high: "大獎多、小獎少",
} as const;
export const STORM_CALIBRATION_STAKES = [...new Set<number>([...STORM_STAKES, 20])].sort(
  (a, b) => a - b,
);

// Symbol, feature-trigger and multiplier probabilities are identical in both styles.
// Only the allocation of payouts between common wins and feature/rare wins differs.
export function stormPresetSettings(style: StormPrizeStyle) {
  stormPrizeStyleSchema.parse(style);
  return stormSettingsSchema.parse({
    ...STORM_BALANCED_SETTINGS,
    symbolWeights: STORM_LEGACY_SETTINGS.symbolWeights,
    capScope: "cycle",
    paytable:
      style === "low"
        ? {
            ruby: 100,
            emerald: 100,
            sapphire: 100,
            amber: 100,
            lotus: 100,
            scarab: 100,
            sun: 100,
            moon: 100,
          }
        : {
            ruby: 10,
            emerald: 10,
            sapphire: 5,
            amber: 5,
            lotus: 10,
            scarab: 5,
            sun: 200,
            moon: 200,
          },
    freePayDivisor: style === "low" ? 8 : 3,
    superBonus: style === "low" ? [100, 200, 500, 1000] : [100, 400, 2000, 5000],
  });
}
