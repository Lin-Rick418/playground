import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type StormSettings, initialStormProgress } from "@baccarat/contracts";
import { MODEL_REVISION, spinBalanced, type BalancedProfile } from "./math-v2.js";

import { configuredSpinner } from "./math-v3.js";

export function mathFingerprint(modelRevision = "balanced-2.0") {
  const root = new URL("../../../../../", import.meta.url);
  const hash = createHash("sha256");
  for (const file of [
    modelRevision === "configurable-3.0"
      ? "apps/server/src/modules/storm/math-v3.ts"
      : "apps/server/src/modules/storm/math-v2.ts",
    ...(modelRevision === "configurable-3.0"
      ? [
          "packages/contracts/src/storm-settings.ts",
          "packages/contracts/src/storm-rtp.ts",
          "packages/contracts/src/storm-presets.ts",
        ]
      : []),
    "packages/contracts/src/storm.ts",
    "packages/contracts/src/money.ts",
  ])
    hash.update(readFileSync(new URL(file, root)));
  return hash.digest("hex");
}
export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}
export function simulate(
  profile: BalancedProfile & { settings?: StormSettings },
  cycles: number,
  stake: number,
  rng?: () => number,
) {
  const spin = profile.settings
    ? configuredSpinner({ ...profile, settings: profile.settings })
    : (
        state: Parameters<typeof spinBalanced>[0],
        stake: number,
        rng?: () => number,
        frames = true,
      ) => spinBalanced(state, stake, profile, rng, frames);
  const freeMax = profile.settings?.freeMax ?? 30;
  const maximumCycle =
    stake * profile.maxWinFactor * (profile.settings?.capScope === "spin" ? freeMax + 1 : 1);
  let mean = 0,
    m2 = 0,
    totalPayoutMinor = 0n,
    freeSpins = 0;
  let paidHits = 0,
    profitable = 0,
    features = 0,
    basePayout = 0n;
  let maxReturn = 0,
    dry = 0,
    maxDry = 0;
  const payoutBands = [0, 0, 0, 0, 0, 0]; // zero, <1x, 1–5x, 5–20x, 20–100x, >=100x
  for (let i = 1; i <= cycles; i++) {
    const paid = spin({ ...initialStormProgress(), balance: 1_000_000 }, stake, rng, false);
    let state = paid.state;
    let payout = Math.round(paid.payout * 100);
    basePayout += BigInt(payout);
    paidHits += Number(paid.payout > 0);
    if (paid.payout > 0) dry = 0;
    else {
      dry++;
      maxDry = Math.max(maxDry, dry);
    }
    if (state.freeLeft > 0) features++;
    let count = 0;
    while (state.freeLeft > 0) {
      const result = spin(state, stake, rng, false);
      state = result.state;
      payout += Math.round(result.payout * 100);
      freeSpins++;
      if (++count > freeMax) throw new Error("Free series did not terminate");
    }
    if (payout > maximumCycle * 100) throw new Error("Cycle payout exceeded cap");
    const multiple = payout / (stake * 100);
    payoutBands[
      multiple === 0
        ? 0
        : multiple < 1
          ? 1
          : multiple < 5
            ? 2
            : multiple < 20
              ? 3
              : multiple < 100
                ? 4
                : 5
    ]++;
    profitable += Number(multiple > 1);
    totalPayoutMinor += BigInt(payout);
    const delta = multiple - mean;
    mean += delta / i;
    m2 += delta * (multiple - mean);
    maxReturn = Math.max(maxReturn, multiple);
  }
  const half = 1.96 * Math.sqrt(m2 / (cycles - 1) / cycles) * 100;
  return {
    stake,
    cycles,
    freeSpins,
    totalStake: cycles * stake,
    totalPayout: Number(totalPayoutMinor) / 100,
    totalPayoutMinor: totalPayoutMinor.toString(),
    rtpPercent: mean * 100,
    interval95: [mean * 100 - half, mean * 100 + half],
    halfWidth: half,
    standardDeviationX: Math.sqrt(m2 / (cycles - 1)),
    paidHitPercent: (paidHits / cycles) * 100,
    profitableCyclePercent: (profitable / cycles) * 100,
    featureTriggerPercent: (features / cycles) * 100,
    baseRtpPercentagePoints: Number(basePayout) / (cycles * stake),
    maxReturnX: maxReturn,
    maxConsecutivePaidMisses: maxDry,
    payoutBands,
  };
}
export type CalibrationReport = {
  volatility?: "low" | "high";
  presetRevision?: string;
  modelRevision: typeof MODEL_REVISION | "configurable-3.0";
  fingerprint: string;
  profile: BalancedProfile & { settings?: StormSettings };
  targetRtp: number;
  passed: boolean;
  startedAt: string;
  completedAt: string;
  trainingCycles: number;
  samples: ReturnType<typeof simulate>[];
  rng: string;
  samplingUnit: string;
  stoppingPolicy: string;
  tolerancePercentagePoints: number;
};
