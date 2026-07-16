import type { GameTableRecord } from "../types/domain.js";

export const REVEAL_WINDOW_MS = 5000;
export const DEAL_ANIMATION_BUFFER_MS = 7000;

type ScheduledTable = Pick<GameTableRecord, "roundDurationMs" | "roundPhaseOffsetMs">;
type RoundWindow = {
  bettingOpensAt: string;
  bettingClosesAt: string;
};

export type Clock = {
  now: () => number;
};

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function getScheduledBettingOpensAtMs(
  table: Pick<ScheduledTable, "roundPhaseOffsetMs">,
  nowMs: number,
  applyPhaseOffset = false,
) {
  const phaseOffsetMs = applyPhaseOffset ? Math.max(0, table.roundPhaseOffsetMs) : 0;
  return nowMs + DEAL_ANIMATION_BUFFER_MS + phaseOffsetMs;
}

export function getFreshRoundWindow(
  table: ScheduledTable,
  clock: Clock = systemClock,
  applyPhaseOffset = false,
): RoundWindow {
  const opensAtMs = getScheduledBettingOpensAtMs(table, clock.now(), applyPhaseOffset);

  return {
    bettingOpensAt: new Date(opensAtMs).toISOString(),
    bettingClosesAt: new Date(opensAtMs + table.roundDurationMs).toISOString(),
  };
}

export function assertValidRoundWindow(window: RoundWindow, createdAt: string) {
  const createdAtMs = Date.parse(createdAt);
  const opensAtMs = Date.parse(window.bettingOpensAt);
  const closesAtMs = Date.parse(window.bettingClosesAt);

  if (![createdAtMs, opensAtMs, closesAtMs].every(Number.isFinite)) {
    throw new Error("Round timestamps must be valid ISO dates");
  }

  if (opensAtMs <= createdAtMs) {
    throw new Error("Round betting window must open after the round is created");
  }

  if (closesAtMs <= opensAtMs) {
    throw new Error("Round betting window must close after it opens");
  }
}
