import type { GameTableRecord } from "../types/domain.js";

export const REVEAL_WINDOW_MS = 5000;
export const DEAL_ANIMATION_BUFFER_MS = 7000;

type ScheduledTable = Pick<GameTableRecord, "roundPhaseOffsetMs">;

export function getScheduledBettingOpensAtMs(
  table: ScheduledTable,
  nowMs = Date.now(),
  applyPhaseOffset = false,
) {
  const phaseOffsetMs = applyPhaseOffset ? Math.max(0, table.roundPhaseOffsetMs) : 0;
  return nowMs + DEAL_ANIMATION_BUFFER_MS + phaseOffsetMs;
}
