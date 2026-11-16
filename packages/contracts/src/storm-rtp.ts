import { z } from "zod";

// Storage/transport precision only; this is not a gameplay RTP policy limit.
export const STORM_MAX_TARGET_RTP = 90_000_000_000_000;
export const STORM_MAX_PAYOUT_SCALE = 2_147_483_647;
export const stormTargetRtpSchema = z
  .number()
  .min(0)
  .max(STORM_MAX_TARGET_RTP)
  .refine((value) => /^\d+(?:\.\d{1,2})?$/.test(String(value)), "RTP 最多兩位小數");
export function stormRtpTolerance(targetRtp: number) {
  return { deviation: targetRtp * 0.005, halfWidth: targetRtp * 0.0035 };
}
