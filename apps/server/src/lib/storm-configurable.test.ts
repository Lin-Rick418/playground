import assert from "node:assert/strict";
import test from "node:test";
import {
  STORM_BALANCED_SETTINGS,
  STORM_LEGACY_SETTINGS,
  STORM_PAY,
  stormSettingsSchema,
  stormMathProfileSchema,
  STORM_MAX_PAYOUT_SCALE,
  stormTargetRtpSchema,
  initialStormProgress,
  stormSpinResultSchema,
  type StormProgress,
} from "@baccarat/contracts";
import { configuredSpinner } from "../modules/storm/math-v3.js";
import { spinBalanced, BALANCED_WEIGHTS } from "../modules/storm/math-v2.js";
import { WEIGHTS, SUPER_BONUS } from "../modules/storm/math.js";
import { seededRandom } from "../modules/storm/calibration.js";

test("current settings accurately expose the original weights, pays and bonus table", () => {
  assert.deepEqual(
    STORM_LEGACY_SETTINGS.symbolWeights,
    Object.fromEntries(WEIGHTS.map(([k, w]) => [k, w * 100])),
  );
  assert.deepEqual(
    STORM_LEGACY_SETTINGS.paytable,
    Object.fromEntries(Object.entries(STORM_PAY).map(([k, p]) => [k, p * 10])),
  );
  assert.deepEqual(
    STORM_LEGACY_SETTINGS.superBonus,
    SUPER_BONUS.slice(1).map((p) => p * 100),
  );
  assert.deepEqual(
    STORM_BALANCED_SETTINGS.symbolWeights,
    Object.fromEntries(BALANCED_WEIGHTS.map(([k, w]) => [k, w * 10])),
  );
});
test("parameter schema rejects inconsistent probabilities and series bounds", () => {
  for (const extra of [
    { symbolWeights: { ...STORM_LEGACY_SETTINGS.symbolWeights, ruby: 0 } },
    { orbWeights: { ...STORM_LEGACY_SETTINGS.orbWeights, "2": -1 } },
    { freeMax: 9 },
    { freeInitial: 16 },
    { maxCascades: 13 },
    { upgradeMode: "adaptive" },
    { freePayDivisor: 0 },
  ])
    assert.equal(
      stormSettingsSchema.safeParse({ ...STORM_LEGACY_SETTINGS, ...extra }).success,
      false,
    );
  assert.equal(stormSettingsSchema.safeParse(STORM_LEGACY_SETTINGS).success, true);
  assert.equal(stormSettingsSchema.safeParse(STORM_BALANCED_SETTINGS).success, true);
});
test("v3 balanced preset reproduces v2 RNG consumption and exact settlements", () => {
  const profile = { payoutScale: 206672, maxWinFactor: 1000 };
  const spin = configuredSpinner({ ...profile, settings: STORM_BALANCED_SETTINGS });
  const oldRandom = seededRandom(55121),
    newRandom = seededRandom(55121);
  let state: StormProgress & { balance: number } = { ...initialStormProgress(), balance: 1000000 };
  for (let i = 0; i < 5000; i++) {
    const old = spinBalanced(state, 20, profile, oldRandom),
      next = spin(state, 20, newRandom);
    assert.deepEqual(next, old);
    state = next.state;
  }
});
test("custom probabilities, payout and free awards affect generated outcomes", () => {
  const settings = structuredClone(STORM_LEGACY_SETTINGS);
  settings.symbolWeights = {
    ...settings.symbolWeights,
    ruby: 9500,
    emerald: 0,
    sapphire: 0,
    amber: 0,
    lotus: 0,
    scarab: 0,
    sun: 0,
    moon: 0,
    gold: 0,
    scatter: 500,
    orb: 0,
  };
  settings.freeInitial = 7;
  settings.freeRetrigger = 2;
  settings.freeMax = 20;
  settings.maxCascades = 1;
  const spin = configuredSpinner({ payoutScale: 1000000, maxWinFactor: 25000, settings });
  let n = 0;
  const rng = () => (n++ < 4 ? 0.99 : 0);
  const result = spin({ ...initialStormProgress(), balance: 10000 }, 20, rng);
  stormSpinResultSchema.parse(result);
  assert.equal(result.awarded, 7);
  assert.equal(result.frames.length, 2);
  assert.equal(result.payout, 72);
  assert.equal(result.state.freeGranted, 7);
});
test("per-spin cap preserves later free liability while cycle cap consumes previous payouts", () => {
  const state = {
    ...initialStormProgress(),
    balance: 10000,
    cycleWin: 1999.99,
    freeLeft: 3,
    freeGranted: 10,
  };
  const base = { payoutScale: 1000000, maxWinFactor: 100 };
  const cycle = configuredSpinner({ ...base, settings: STORM_BALANCED_SETTINGS })(
    state,
    20,
    () => 0,
  );
  assert.equal(cycle.payout, 0.01);
  assert.equal(cycle.state.freeLeft, 0);
  const spin = configuredSpinner({
    ...base,
    settings: { ...STORM_BALANCED_SETTINGS, capScope: "spin" },
  })(state, 20, () => 0);
  assert.equal(spin.payout, 288);
  assert.equal(spin.state.freeLeft, 2);
  assert.equal(spin.state.cycleWin, 2287.99);
});

test("custom repeat upgrade probabilities and multiplier caps are used by the engine", () => {
  const settings = {
    ...structuredClone(STORM_LEGACY_SETTINGS),
    maxCascades: 1,
    normalUpgradeChance: 10000,
    factorCap: 5,
    accumulatorCap: 7,
  };
  const sequence: number[] = [];
  const draw = (kind: keyof typeof settings.symbolWeights) => {
    let sum = 0;
    for (const [k, w] of Object.entries(settings.symbolWeights)) {
      if (k === kind) {
        sequence.push((sum + w / 2) / 10000);
        break;
      }
      sum += w;
    }
    if (kind === "orb") sequence.push(0);
  };
  for (let i = 0; i < 8; i++) draw("ruby");
  for (let i = 0; i < 22; i++) draw("orb");
  for (let i = 0; i < 8; i++) draw("sapphire");
  let index = 0;
  const result = configuredSpinner({ payoutScale: 1000000, maxWinFactor: 25000, settings })(
    { ...initialStormProgress(), balance: 10000, freeLeft: 1, freeGranted: 15 },
    20,
    () => sequence[index++] ?? 0,
  );
  stormSpinResultSchema.parse(result);
  assert.equal(result.factor, 5);
  assert.equal(result.collected, 22000);
  assert.equal(result.state.multiplier, 7);
  assert.equal(result.payout, 120);
  assert.equal(result.upgrades.length, 198);
});

test("zero and very high RTP profiles settle within the same exact payout cap", () => {
  const state = { ...initialStormProgress(), balance: 10000 };
  const profile = {
    id: "00000000-0000-4000-8000-000000000001",
    modelRevision: "configurable-3.0" as const,
    targetRtp: 0,
    payoutScale: 0,
    maxWinFactor: 1000,
    settings: STORM_BALANCED_SETTINGS,
  };
  const zero = configuredSpinner(stormMathProfileSchema.parse(profile) as typeof profile)(
    state,
    20,
    () => 0,
  );
  stormSpinResultSchema.parse(zero);
  assert.equal(zero.payout, 0);
  assert.equal(zero.state.balance, 9980);
  for (const scale of [30000000, STORM_MAX_PAYOUT_SCALE]) {
    const high = { ...profile, targetRtp: 10000, payoutScale: scale };
    stormMathProfileSchema.parse(high);
    const result = configuredSpinner(high)(state, 20, () => 0);
    stormSpinResultSchema.parse(result);
    assert.equal(result.payout, 20000);
    assert.equal(result.state.balance, 29980);
    assert.equal(result.capped, true);
  }
  for (const target of [0, 0.01, 1, 100, 1000, 10000])
    assert.equal(stormTargetRtpSchema.safeParse(target).success, true);
  for (const target of [-1, 0.001, NaN, Infinity, 1e20])
    assert.equal(stormTargetRtpSchema.safeParse(target).success, false);
});
