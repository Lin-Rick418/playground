import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBusinessDayWindow } from "./business-day.js";

describe("getBusinessDayWindow", () => {
  it("uses the Asia/Taipei calendar day instead of the server process offset", () => {
    const beforeTaipeiMidnight = getBusinessDayWindow(new Date("2026-07-15T15:59:59.999Z"), "Asia/Taipei");
    const afterTaipeiMidnight = getBusinessDayWindow(new Date("2026-07-15T16:00:00.000Z"), "Asia/Taipei");

    assert.deepEqual(
      {
        date: beforeTaipeiMidnight.date,
        start: beforeTaipeiMidnight.start.toISOString(),
        end: beforeTaipeiMidnight.end.toISOString(),
      },
      {
        date: "2026-07-15",
        start: "2026-07-14T16:00:00.000Z",
        end: "2026-07-15T16:00:00.000Z",
      },
    );
    assert.deepEqual(
      {
        date: afterTaipeiMidnight.date,
        start: afterTaipeiMidnight.start.toISOString(),
        end: afterTaipeiMidnight.end.toISOString(),
      },
      {
        date: "2026-07-16",
        start: "2026-07-15T16:00:00.000Z",
        end: "2026-07-16T16:00:00.000Z",
      },
    );
  });

  it("returns a 23-hour window across the New York spring DST transition", () => {
    const window = getBusinessDayWindow(new Date("2026-03-08T16:00:00.000Z"), "America/New_York");

    assert.equal(window.date, "2026-03-08");
    assert.equal(window.start.toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(window.end.toISOString(), "2026-03-09T04:00:00.000Z");
    assert.equal(window.end.getTime() - window.start.getTime(), 23 * 60 * 60 * 1000);
  });

  it("returns a 25-hour window across the New York autumn DST transition", () => {
    const window = getBusinessDayWindow(new Date("2026-11-01T16:00:00.000Z"), "America/New_York");

    assert.equal(window.date, "2026-11-01");
    assert.equal(window.start.toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(window.end.toISOString(), "2026-11-02T05:00:00.000Z");
    assert.equal(window.end.getTime() - window.start.getTime(), 25 * 60 * 60 * 1000);
  });

  it("rejects an invalid IANA timezone", () => {
    assert.throws(() => getBusinessDayWindow(new Date(), "Taipei-ish"), /valid IANA time zone/);
  });
});
