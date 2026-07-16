import assert from "node:assert/strict";
import test from "node:test";
import {
  DEAL_ANIMATION_BUFFER_MS,
  getScheduledBettingOpensAtMs,
  REVEAL_WINDOW_MS,
} from "./round-schedule.js";

const epochMs = Date.UTC(2025, 0, 1);

test("assigns each configured table a distinct opening phase", () => {
  const tables = [
    { roundPhaseOffsetMs: 0 },
    { roundPhaseOffsetMs: 2000 },
    { roundPhaseOffsetMs: 4000 },
    { roundPhaseOffsetMs: 6000 },
  ];

  const openings = tables.map((table) => getScheduledBettingOpensAtMs(table, epochMs, true));

  assert.deepEqual(openings, [
    epochMs + DEAL_ANIMATION_BUFFER_MS,
    epochMs + DEAL_ANIMATION_BUFFER_MS + 2000,
    epochMs + DEAL_ANIMATION_BUFFER_MS + 4000,
    epochMs + DEAL_ANIMATION_BUFFER_MS + 6000,
  ]);
});

test("uses only the deal buffer after phase initialization", () => {
  const table = { roundPhaseOffsetMs: 6000 };
  const settlementMs = epochMs + 15000 + REVEAL_WINDOW_MS;
  const nextOpeningMs = getScheduledBettingOpensAtMs(table, settlementMs);

  assert.equal(nextOpeningMs, settlementMs + DEAL_ANIMATION_BUFFER_MS);
});

test("never applies a negative phase delay", () => {
  const table = { roundPhaseOffsetMs: -5000 };

  assert.equal(
    getScheduledBettingOpensAtMs(table, epochMs, true),
    epochMs + DEAL_ANIMATION_BUFFER_MS,
  );
});
