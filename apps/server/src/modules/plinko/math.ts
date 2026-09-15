import { randomInt } from "node:crypto";
import { fromMinorUnits, toMinorUnits, roundHalfUp, type PlinkoRisk } from "@baccarat/contracts";

export const PLINKO_RULE_VERSION = 1;
export const PLINKO_RISKS = ["low", "medium", "high"] as const;

// Stake public paytable, verified 2026-09-15. Integer tenths, left edge to centre.
// Immutable v1 input: https://stake.com/zh/casino/games/plinko
const baseHalfTenths: Record<PlinkoRisk, number[][]> = {
  low: [
    [56, 21, 11, 10, 5],
    [56, 20, 16, 10, 7],
    [89, 30, 14, 11, 10, 5],
    [84, 30, 19, 13, 10, 7],
    [100, 30, 16, 14, 11, 10, 5],
    [81, 40, 30, 19, 12, 9, 7],
    [71, 40, 19, 14, 13, 11, 10, 5],
    [150, 80, 30, 20, 15, 11, 10, 7],
    [160, 90, 20, 14, 14, 12, 11, 10, 5],
  ],
  medium: [
    [130, 30, 13, 7, 4],
    [180, 40, 17, 9, 5],
    [220, 50, 20, 14, 6, 4],
    [240, 60, 30, 18, 7, 5],
    [330, 110, 40, 20, 11, 6, 3],
    [430, 130, 60, 30, 13, 7, 4],
    [580, 150, 70, 40, 19, 10, 5, 2],
    [880, 180, 110, 50, 30, 13, 5, 3],
    [1100, 410, 100, 50, 30, 15, 10, 5, 3],
  ],
  high: [
    [290, 40, 15, 3, 2],
    [430, 70, 20, 6, 2],
    [760, 100, 30, 9, 3, 2],
    [1200, 140, 52, 14, 4, 2],
    [1700, 240, 81, 20, 7, 2, 2],
    [2600, 370, 110, 40, 10, 2, 2],
    [4200, 560, 180, 50, 19, 3, 2, 2],
    [6200, 830, 270, 80, 30, 5, 2, 2],
    [10000, 1300, 260, 90, 40, 20, 2, 2, 2],
  ],
};

export function plinkoWeights(rows: number): bigint[] {
  if (!Number.isInteger(rows) || rows < 8 || rows > 16) throw new RangeError("Invalid Plinko rows");
  let weight = 1n;
  return Array.from({ length: rows + 1 }, (_, k) => {
    if (k) weight = (weight * BigInt(rows - k + 1)) / BigInt(k);
    return weight;
  });
}

// Built once from exact rationals at startup, never adjusted per player or bet.
export const plinkoTables = Object.freeze(
  PLINKO_RISKS.flatMap((risk) =>
    baseHalfTenths[risk].map((half, index) => {
      const rows = index + 8;
      const original = [...half, ...half.slice(0, rows % 2 ? half.length : -1).reverse()];
      const weights = plinkoWeights(rows);
      const denominator = original.reduce((sum, value, k) => sum + BigInt(value) * weights[k], 0n);
      const units = Object.freeze(
        original.map((value) =>
          Number(roundHalfUp(9550n * BigInt(value) * 2n ** BigInt(rows), denominator)),
        ),
      );
      const rtpNumerator = units.reduce((sum, value, k) => sum + BigInt(value) * weights[k], 0n);
      const rtpDenominator = 10000n * 2n ** BigInt(rows);
      if (rtpNumerator * 100n < 95n * rtpDenominator || rtpNumerator * 100n > 96n * rtpDenominator)
        throw new Error("Plinko paytable RTP outside approved range");
      return Object.freeze({
        rows,
        risk,
        units,
        multipliers: Object.freeze(units.map((value) => value / 10000)),
        rtp: Number(rtpNumerator) / Number(rtpDenominator),
      });
    }),
  ),
);

export function getPlinkoTable(rows: number, risk: PlinkoRisk) {
  const table = plinkoTables.find((entry) => entry.rows === rows && entry.risk === risk);
  if (!table) throw new RangeError("Invalid Plinko settings");
  return table;
}

export function generatePlinkoPath(rows: number): (0 | 1)[] {
  plinkoWeights(rows);
  return Array.from({ length: rows }, () => randomInt(2) as 0 | 1);
}

export function plinkoPayout(amount: number, multiplierUnits: number) {
  if (
    !Number.isInteger(amount) ||
    amount < 100 ||
    amount > 5000 ||
    amount % 100 !== 0 ||
    !Number.isSafeInteger(multiplierUnits) ||
    multiplierUnits <= 0
  )
    throw new RangeError("Invalid Plinko payout inputs");
  return fromMinorUnits(roundHalfUp(toMinorUnits(amount) * BigInt(multiplierUnits), 10000n));
}
