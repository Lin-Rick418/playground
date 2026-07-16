import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidRoundWindow,
  DEAL_ANIMATION_BUFFER_MS,
  getFreshRoundWindow,
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

test("uses a fresh clock after delayed settlement without overlapping the previous window", () => {
  const previousClosesAtMs = epochMs + 30000;
  let currentTimeMs = previousClosesAtMs + REVEAL_WINDOW_MS;
  const staleTickTimeMs = currentTimeMs;
  const clock = { now: () => currentTimeMs };
  const table = { roundDurationMs: 30000, roundPhaseOffsetMs: 0 };

  // Simulate settlement and persistence work taking longer than the deal buffer.
  currentTimeMs += DEAL_ANIMATION_BUFFER_MS + 5000;
  const nextWindow = getFreshRoundWindow(table, clock);
  const nextOpensAtMs = Date.parse(nextWindow.bettingOpensAt);

  assert.equal(nextOpensAtMs, currentTimeMs + DEAL_ANIMATION_BUFFER_MS);
  assert.ok(nextOpensAtMs > currentTimeMs);
  assert.ok(nextOpensAtMs > previousClosesAtMs);
  assert.notEqual(nextOpensAtMs, staleTickTimeMs + DEAL_ANIMATION_BUFFER_MS);
  assert.doesNotThrow(() =>
    assertValidRoundWindow(nextWindow, new Date(currentTimeMs).toISOString()),
  );
});

test("rejects round windows that are already open at the persistence boundary", () => {
  const createdAt = new Date(epochMs).toISOString();

  assert.throws(
    () =>
      assertValidRoundWindow(
        {
          bettingOpensAt: createdAt,
          bettingClosesAt: new Date(epochMs + 30000).toISOString(),
        },
        createdAt,
      ),
    /must open after the round is created/,
  );
});

test("rejects invalid or reversed round windows at the persistence boundary", () => {
  const createdAt = new Date(epochMs).toISOString();

  assert.throws(
    () =>
      assertValidRoundWindow(
        {
          bettingOpensAt: "not-a-date",
          bettingClosesAt: new Date(epochMs + 30000).toISOString(),
        },
        createdAt,
      ),
    /valid ISO dates/,
  );

  assert.throws(
    () =>
      assertValidRoundWindow(
        {
          bettingOpensAt: new Date(epochMs + 30000).toISOString(),
          bettingClosesAt: new Date(epochMs + 30000).toISOString(),
        },
        createdAt,
      ),
    /must close after it opens/,
  );
});
