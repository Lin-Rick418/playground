import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { initialState, spin, type Feature } from "../modules/storm/math.js";

// Offline only: use the production math and its default crypto RNG. Each sample
// is one paid spin plus its ENTIRE free series, including all retriggers.
const cycles = Number(process.argv[2] ?? 1_000_000);
const stake = 20;
const startingBalance = 1_000_000;
assert(Number.isSafeInteger(cycles) && cycles > 1 && cycles <= 10_000_000);
const fingerprint = (relativePath: string) =>
  createHash("sha256")
    .update(readFileSync(new URL(relativePath, import.meta.url)))
    .digest("hex");
const sourceHashes = {
  mathSha256: fingerprint("../modules/storm/math.ts"),
  contractsSha256: fingerprint("../../../../packages/contracts/src/storm.ts"),
  moneySha256: fingerprint("../../../../packages/contracts/src/money.ts"),
};
const startedAt = new Date().toISOString();
const started = performance.now();

function moments() {
  return { n: 0, mean: 0, m2: 0, total: 0, max: 0 };
}
function record(stats: ReturnType<typeof moments>, value: number) {
  stats.n++;
  const delta = value - stats.mean;
  stats.mean += delta / stats.n;
  stats.m2 += delta * (value - stats.mean);
  stats.total += value;
  stats.max = Math.max(stats.max, value);
}
function featureStats() {
  return {
    series: 0,
    spins: 0,
    winningSpins: 0,
    retriggers: 0,
    cappedSpins: 0,
    zeroPayoutSeries: 0,
    profitableSeries: 0,
    breakEvenSeries: 0,
    returns: [] as number[],
    finalMultipliers: moments(),
    payouts: moments(),
  };
}
const features: Record<Feature, ReturnType<typeof featureStats>> = {
  normal: featureStats(),
  super: featureStats(),
};
const gross = moments();
const paidBase = moments();
const paidBonus = moments();
const freeReturn = moments();
const bonusCounts = [0, 0, 0, 0, 0];
let freeSpins = 0;
let paidWinningSpins = 0;
let profitableCycles = 0;
let breakEvenCycles = 0;
let paidCappedSpins = 0;
let cascadeLimitedSpins = 0;
let batchPayout = 0;
let batchCycles = 0;
const batches: { cycles: number; rtpPercent: number }[] = [];
const batchSize = Math.max(1, Math.ceil(cycles / 20));

for (let cycle = 1; cycle <= cycles; cycle++) {
  // Fresh virtual funds avoid stop-loss, wallet limits, or bankroll selection
  // bias. This does not contact the service, database, or any player wallet.
  const paid = spin({ ...initialState(), balance: startingBalance }, stake);
  assert.equal(paid.cost, stake);
  assert.equal(paid.wasFree, false);
  let state = paid.state;
  let cyclePayout = paid.payout;
  let featurePayout = 0;
  let seriesSpins = 0;
  paidWinningSpins += Number(paid.payout > 0);
  paidCappedSpins += Number(paid.capped);
  cascadeLimitedSpins += Number(paid.limited);
  bonusCounts[paid.bonusCount]++;
  record(paidBase, paid.payout - paid.bonusWin);
  record(paidBonus, paid.bonusWin);
  const feature = state.freeLeft > 0 ? features[state.feature] : undefined;
  if (feature) feature.series++;
  while (state.freeLeft > 0) {
    assert(feature);
    const result = spin(state, stake);
    assert.equal(result.cost, 0);
    assert.equal(result.wasFree, true);
    state = result.state;
    cyclePayout += result.payout;
    featurePayout += result.payout;
    seriesSpins++;
    freeSpins++;
    feature.spins++;
    feature.winningSpins += Number(result.payout > 0);
    feature.retriggers += Number(result.awarded > 0);
    feature.cappedSpins += Number(result.capped);
    cascadeLimitedSpins += Number(result.limited);
    assert(seriesSpins <= 100);
  }
  assert.equal(state.balance, startingBalance - stake + cyclePayout);
  if (feature) {
    assert.equal(state.featureWin, featurePayout);
    feature.zeroPayoutSeries += Number(featurePayout === 0);
    feature.profitableSeries += Number(featurePayout > stake);
    feature.breakEvenSeries += Number(featurePayout === stake);
    feature.returns.push(featurePayout / stake);
    record(feature.payouts, featurePayout);
    record(feature.finalMultipliers, state.multiplier);
  }
  profitableCycles += Number(cyclePayout > stake);
  breakEvenCycles += Number(cyclePayout === stake);
  record(gross, cyclePayout);
  record(freeReturn, featurePayout);
  batchPayout += cyclePayout;
  batchCycles++;
  if (cycle % batchSize === 0 || cycle === cycles) {
    batches.push({ cycles: batchCycles, rtpPercent: (batchPayout / (batchCycles * stake)) * 100 });
    batchPayout = 0;
    batchCycles = 0;
    process.stderr.write(
      `${cycle}/${cycles} paid cycles; ${freeSpins} free spins; RTP ${((gross.total / (cycle * stake)) * 100).toFixed(2)}%\n`,
    );
  }
}

assert.equal(gross.total, paidBase.total + paidBonus.total + freeReturn.total);
assert.equal(freeReturn.total, features.normal.payouts.total + features.super.payouts.total);
assert(Number.isSafeInteger(gross.total));
const totalStake = cycles * stake;
const rtpPercent = (gross.mean / stake) * 100;
const standardErrorPercentagePoints = (Math.sqrt(gross.m2 / (cycles - 1) / cycles) / stake) * 100;
const contributions = Object.fromEntries(
  Object.entries({
    paidBase: paidBase.total,
    paidSuperBonus: paidBonus.total,
    normalFree: features.normal.payouts.total,
    superFree: features.super.payouts.total,
  }).map(([key, payout]) => [key, { payout, rtpPercentagePoints: (payout / totalStake) * 100 }]),
);
const featureResults = Object.fromEntries(
  Object.entries(features).map(([key, stats]) => {
    stats.returns.sort((a, b) => a - b);
    const quantile = (p: number) =>
      stats.returns[Math.max(0, Math.ceil(p * stats.returns.length) - 1)] ?? null;
    return [
      key,
      {
        series: stats.series,
        triggerPercent: (stats.series / cycles) * 100,
        spins: stats.spins,
        averageSpins: stats.series ? stats.spins / stats.series : null,
        winningSpins: stats.winningSpins,
        winningSpinPercent: stats.spins ? (stats.winningSpins / stats.spins) * 100 : null,
        retriggers: stats.retriggers,
        cappedSpins: stats.cappedSpins,
        zeroPayoutSeries: stats.zeroPayoutSeries,
        profitableSeries: stats.profitableSeries,
        profitableSeriesPercent: stats.series
          ? (stats.profitableSeries / stats.series) * 100
          : null,
        breakEvenSeries: stats.breakEvenSeries,
        totalPayout: stats.payouts.total,
        averageSeriesReturnX: stats.series ? stats.payouts.mean / stake : null,
        medianSeriesReturnX: quantile(0.5),
        p90SeriesReturnX: quantile(0.9),
        p99SeriesReturnX: quantile(0.99),
        maxSeriesReturnX: stats.series ? stats.payouts.max / stake : null,
        averageFinalMultiplier: stats.series ? stats.finalMultipliers.mean : null,
      },
    ];
  }),
);
assert.equal(
  fingerprint("../modules/storm/math.ts"),
  sourceHashes.mathSha256,
  "Math changed during simulation",
);
assert.equal(
  fingerprint("../../../../packages/contracts/src/storm.ts"),
  sourceHashes.contractsSha256,
  "Contracts changed during simulation",
);
assert.equal(
  fingerprint("../../../../packages/contracts/src/money.ts"),
  sourceHashes.moneySha256,
  "Money arithmetic changed during simulation",
);
process.stdout.write(
  `${JSON.stringify(
    {
      startedAt,
      elapsedSeconds: (performance.now() - started) / 1000,
      ruleVersion: 1,
      ...sourceHashes,
      rng: "Production default: node:crypto randomInt; independent reruns differ",
      samplingUnit: "One paid spin plus its entire awarded free series; no incomplete series",
      stake,
      paidCycles: cycles,
      freeSpins,
      totalSpins: cycles + freeSpins,
      totalStake,
      totalPayout: gross.total,
      netPlayerProfit: gross.total - totalStake,
      rtpPercent,
      standardErrorPercentagePoints,
      approximate95PercentInterval: [
        rtpPercent - 1.96 * standardErrorPercentagePoints,
        rtpPercent + 1.96 * standardErrorPercentagePoints,
      ],
      paidWinningSpins,
      paidWinningSpinPercent: (paidWinningSpins / cycles) * 100,
      profitableCycles,
      profitableCyclePercent: (profitableCycles / cycles) * 100,
      breakEvenCycles,
      maxCyclePayout: gross.max,
      paidCappedSpins,
      cascadeLimitedSpins,
      bonusCounts,
      contributions,
      features: featureResults,
      batches,
    },
    null,
    2,
  )}\n`,
);
