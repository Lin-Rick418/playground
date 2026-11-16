import test from "node:test";
import assert from "node:assert/strict";
import {
  STORM_LEGACY_SETTINGS,
  STORM_CALIBRATION_STAKES,
  STORM_FIXED_MAX_WIN_FACTOR,
  STORM_MAX_PAYOUT_SCALE,
  stormPresetSettings,
  stormSpinResultSchema,
  initialStormProgress,
} from "@baccarat/contracts";
import { configuredSpinner } from "../modules/storm/math-v3.js";
import { simulate, seededRandom } from "../modules/storm/calibration.js";

test("both styles lock symbol, free-trigger and orb rules and differ only in payout allocation", () => {
  const low = stormPresetSettings("low"),
    high = stormPresetSettings("high");
  assert.equal(STORM_FIXED_MAX_WIN_FACTOR, 25000);
  assert.deepEqual(low.symbolWeights, STORM_LEGACY_SETTINGS.symbolWeights);
  const allocation = ["paytable", "freePayDivisor", "superBonus"];
  for (const key of Object.keys(low) as (keyof typeof low)[]) {
    if (allocation.includes(key)) assert.notDeepEqual(low[key], high[key]);
    else assert.deepEqual(low[key], high[key]);
  }
  low.symbolWeights.ruby = 0;
  assert.equal(stormPresetSettings("low").symbolWeights.ruby, 1200);
});

test("same seeded outcomes allocate more 20x prizes to high style at the same RTP target", () => {
  const samples = ["low", "high"].map((style) => {
    const settings = stormPresetSettings(style as "low" | "high");
    let scale = 300000;
    for (let i = 0; i < 3; i++) {
      const training = simulate(
        { settings, payoutScale: scale, maxWinFactor: 25000 },
        30000,
        20,
        seededRandom(67239),
      );
      scale = Math.round((scale * 100) / training.rtpPercent);
    }
    return simulate(
      { settings, payoutScale: scale, maxWinFactor: 25000 },
      80000,
      20,
      seededRandom(91156),
    );
  });
  const big = (s: (typeof samples)[0]) => s.payoutBands[4] + s.payoutBands[5];
  const small = (s: (typeof samples)[0]) => s.payoutBands[1] + s.payoutBands[2] + s.payoutBands[3];
  assert.equal(samples[0].paidHitPercent, samples[1].paidHitPercent);
  assert.ok(big(samples[1]) > big(samples[0]));
  assert.ok(small(samples[0]) > small(samples[1]));
  assert.ok(samples[1].standardDeviationX > samples[0].standardDeviationX);
});

test("fixed profiles respect 25000x and transport bounds for every supported stake", () => {
  for (const style of ["low", "high"] as const)
    for (const stake of STORM_CALIBRATION_STAKES)
      for (const scale of [0, STORM_MAX_PAYOUT_SCALE]) {
        const result = configuredSpinner({
          settings: stormPresetSettings(style),
          payoutScale: scale,
          maxWinFactor: 25000,
        })({ ...initialStormProgress(), balance: 1000000 }, stake, () => 0.925);
        stormSpinResultSchema.parse(result);
        assert.equal(result.payout, scale === 0 ? 0 : stake * 25000);
        assert.equal(result.state.freeLeft, 0);
      }
});
