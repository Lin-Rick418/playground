import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  stormPrizeStyleSchema,
  stormPresetSettings,
  STORM_PRESET_REVISION,
  STORM_FIXED_MAX_WIN_FACTOR,
  STORM_CALIBRATION_STAKES,
  stormTargetRtpSchema,
  stormRtpTolerance,
  STORM_MAX_PAYOUT_SCALE,
} from "@baccarat/contracts";
import {
  mathFingerprint,
  seededRandom,
  simulate,
  type CalibrationReport,
} from "../modules/storm/calibration.js";

try {
  const input = z
    .object({
      volatility: stormPrizeStyleSchema,
      targetRtp: stormTargetRtpSchema,
      presetRevision: z.literal(STORM_PRESET_REVISION),
    })
    .strict()
    .parse(JSON.parse(readFileSync(0, "utf8")));
  const settings = stormPresetSettings(input.volatility);
  const absoluteMaximum = STORM_FIXED_MAX_WIN_FACTOR * 100;
  if (input.targetRtp > absoluteMaximum)
    throw new Error(
      `目標 RTP 超過固定派彩上限可容納的理論最大值 ${absoluteMaximum}%，請降低目標 RTP`,
    );
  const tolerance = stormRtpTolerance(input.targetRtp);
  const startedAt = new Date().toISOString();
  const modelRevision = "configurable-3.0";
  const fingerprint = mathFingerprint(modelRevision);
  const progress = (stage: string) => process.stderr.write(JSON.stringify({ stage }) + "\n");
  const quick = process.argv.includes("--smoke");
  const trainingCycles = quick ? 1000 : 2_000_000;
  const profile = {
    payoutScale: input.targetRtp === 0 ? 0 : 300000,
    maxWinFactor: STORM_FIXED_MAX_WIN_FACTOR,
    settings,
  };
  for (let iteration = 0; iteration < 6; iteration++) {
    progress(`校準倍率 ${iteration + 1}/6`);
    const sample = simulate(profile, trainingCycles, 20, seededRandom(0x4820fa37));
    if (Math.abs(sample.rtpPercent - input.targetRtp) <= tolerance.deviation / 10) break;
    if (sample.rtpPercent === 0) {
      if (profile.payoutScale === 300000 || profile.payoutScale === STORM_MAX_PAYOUT_SCALE)
        throw new Error("未產生派彩，無法校準目標 RTP；請調整目標 RTP 或獎項風格");
      profile.payoutScale = Math.min(STORM_MAX_PAYOUT_SCALE, profile.payoutScale * 2);
      continue;
    }
    profile.payoutScale = Math.max(
      1,
      Math.min(
        STORM_MAX_PAYOUT_SCALE,
        Math.round((profile.payoutScale * input.targetRtp) / sample.rtpPercent),
      ),
    );
  }
  const samples: CalibrationReport["samples"] = [];
  for (const stake of STORM_CALIBRATION_STAKES) {
    progress(`獨立驗證投注 ${stake}，${quick ? "1,000" : "4,000,000"} 個完整付費局`);
    samples.push(simulate(profile, quick ? 1000 : 4_000_000, stake));
  }
  if (fingerprint !== mathFingerprint(modelRevision))
    throw new Error("校準期間程式已變更，請重新校準");
  const passed =
    !quick &&
    samples.every(
      (s) =>
        s.halfWidth <= tolerance.halfWidth &&
        Math.abs(s.rtpPercent - input.targetRtp) <= tolerance.deviation,
    );
  const report: CalibrationReport = {
    modelRevision,
    volatility: input.volatility,
    presetRevision: STORM_PRESET_REVISION,
    fingerprint,
    profile,
    targetRtp: input.targetRtp,
    passed,
    startedAt,
    completedAt: new Date().toISOString(),
    trainingCycles,
    samples,
    rng: "Training: fixed-seed xorshift32; independent validation: production crypto.randomInt",
    samplingUnit: "One paid spin and its entire free series, including retriggers and cycle cap",
    stoppingPolicy:
      "Fresh virtual funds per cycle; no stop-loss, take-profit or unfinished free series; no DB or wallets",
    tolerancePercentagePoints: tolerance.deviation,
  };
  process.stdout.write(JSON.stringify(report) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "校準失敗" }) + "\n",
  );
  process.exitCode = 1;
}
