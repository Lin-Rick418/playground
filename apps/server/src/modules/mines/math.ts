import { randomInt } from "node:crypto";
import { fromMinorUnits, roundHalfUp, toMinorUnits } from "@baccarat/contracts";

export function choose(n: number, k: number): bigint {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n)
    throw new RangeError("Invalid combination");
  let value = 1n;
  for (let i = 1; i <= Math.min(k, n - k); i++) value = (value * BigInt(n - i + 1)) / BigInt(i);
  return value;
}

export function payoutRatio(mineCount: number, safeCount: number) {
  if (
    !Number.isInteger(mineCount) ||
    mineCount < 1 ||
    mineCount > 24 ||
    !Number.isInteger(safeCount) ||
    safeCount < 1 ||
    safeCount > 25 - mineCount
  ) {
    throw new RangeError("Invalid Mines payout parameters");
  }
  return {
    numerator: 95n * choose(25, safeCount),
    denominator: 100n * choose(25 - mineCount, safeCount),
  };
}

export function minesPayout(amount: number, mineCount: number, safeCount: number): number {
  if (!Number.isInteger(amount) || amount < 100 || amount > 5000 || amount % 100 !== 0)
    throw new RangeError("Invalid Mines stake");
  const ratio = payoutRatio(mineCount, safeCount);
  return fromMinorUnits(roundHalfUp(toMinorUnits(amount) * ratio.numerator, ratio.denominator));
}

export function minesMultiplier(mineCount: number, safeCount: number): number {
  const ratio = payoutRatio(mineCount, safeCount);
  return Number(ratio.numerator) / Number(ratio.denominator);
}

export function generateMineCells(mineCount: number): number[] {
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > 24)
    throw new RangeError("Invalid mine count");
  const cells = Array.from({ length: 25 }, (_, i) => i);
  // Partial Fisher-Yates, crypto.randomInt performs unbiased rejection sampling.
  for (let i = 0; i < mineCount; i++) {
    const j = randomInt(i, 25);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mineCount).sort((a, b) => a - b);
}
