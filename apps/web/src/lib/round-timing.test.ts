import { describe, expect, it } from "vitest";
import {
  getClientClockAtServerTime,
  getDisplayDurationBeforeDeadline,
  getRoundCountdownSeconds,
} from "./round-timing";

const epochMs = Date.UTC(2026, 6, 21);
const round = {
  bettingOpensAt: new Date(epochMs + 9_000).toISOString(),
  bettingClosesAt: new Date(epochMs + 39_000).toISOString(),
};

describe("round presentation timing", () => {
  it("advances the client clock to the opening boundary without an intermediate render", () => {
    expect(getClientClockAtServerTime(epochMs + 8_750, 250, epochMs + 9_000)).toBe(epochMs + 8_750);
    expect(getClientClockAtServerTime(epochMs + 8_500, 250, epochMs + 9_000)).toBe(epochMs + 8_750);
  });

  it("shows no betting countdown before opening and starts with the full betting duration", () => {
    expect(getRoundCountdownSeconds(round, epochMs)).toBe(0);
    expect(getRoundCountdownSeconds(round, epochMs + 8_999)).toBe(0);
    expect(getRoundCountdownSeconds(round, epochMs + 9_000)).toBe(30);
    expect(getRoundCountdownSeconds(round, epochMs + 39_000)).toBe(0);
  });

  it("never lets a settlement display cross the betting-open deadline", () => {
    expect(getDisplayDurationBeforeDeadline(3_400, round.bettingOpensAt, epochMs)).toBe(3_400);
    expect(getDisplayDurationBeforeDeadline(3_400, round.bettingOpensAt, epochMs + 8_000)).toBe(
      1_000,
    );
    expect(getDisplayDurationBeforeDeadline(3_400, round.bettingOpensAt, epochMs + 9_000)).toBe(0);
    expect(getDisplayDurationBeforeDeadline(3_400, "invalid", epochMs)).toBe(0);
  });
});
