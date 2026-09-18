import { randomInt } from "node:crypto";
import { fromMinorUnits, roundHalfUp, toMinorUnits, type HiloChoice } from "@baccarat/contracts";

export const MAX_MULTIPLIER = 10000;
export const MAX_SKIPS = 52;
export type Ratio = { numerator: bigint; denominator: bigint };
// Before the first guess this is the risk-adjusted value, not a cashout entitlement.
export const INITIAL_RATIO: Ratio = { numerator: 94n, denominator: 100n };
export function rank(card: number) {
  if (!Number.isInteger(card) || card < 0 || card > 51) throw new RangeError("Invalid card");
  return Math.floor(card / 4) + 1;
}
export function drawCard() {
  return randomInt(52);
}
export function choices(card: number): HiloChoice[] {
  const r = rank(card);
  return r === 1
    ? ["higher", "same"]
    : r === 13
      ? ["lower", "same"]
      : ["higher_or_equal", "lower_or_equal"];
}
export function wins(card: number, next: number, choice: HiloChoice) {
  if (!choices(card).includes(choice)) throw new RangeError("Invalid choice for card");
  const a = rank(card),
    b = rank(next);
  switch (choice) {
    case "higher":
      return b > a;
    case "lower":
      return b < a;
    case "same":
      return b === a;
    case "higher_or_equal":
      return b >= a;
    case "lower_or_equal":
      return b <= a;
  }
}
export function winningRanks(card: number, choice: HiloChoice) {
  if (!choices(card).includes(choice)) throw new RangeError("Invalid choice for card");
  switch (choice) {
    case "same":
      return 1;
    case "higher":
    case "lower":
      return 12;
    case "higher_or_equal":
      return 14 - rank(card);
    case "lower_or_equal":
      return rank(card);
  }
}
export function nextRatio(ratio: Ratio, count: number): Ratio {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 12 ||
    ratio.numerator <= 0n ||
    ratio.denominator <= 0n
  )
    throw new RangeError("Invalid payout ratio");
  let n = ratio.numerator * 13n,
    d = ratio.denominator * BigInt(count);
  let a = n,
    b = d;
  while (b) [a, b] = [b, a % b];
  n /= a;
  d /= a;
  return { numerator: n, denominator: d };
}
export function withinLimit(ratio: Ratio) {
  return ratio.numerator <= BigInt(MAX_MULTIPLIER) * ratio.denominator;
}
export function multiplier(ratio: Ratio) {
  return Number(ratio.numerator) / Number(ratio.denominator);
}
export function payout(amount: number, ratio: Ratio) {
  return fromMinorUnits(roundHalfUp(toMinorUnits(amount) * ratio.numerator, ratio.denominator));
}
export function options(card: number, amount: number, ratio: Ratio, active = true) {
  return choices(card).map((choice) => {
    const count = winningRanks(card, choice);
    const next = nextRatio(ratio, count);
    const allowed = withinLimit(next);
    return {
      choice,
      winningRanks: count,
      totalRanks: 13 as const,
      multiplier: multiplier(next),
      payout: payout(amount, next),
      enabled: active && allowed,
      reason: !active ? ("ROUND_ENDED" as const) : !allowed ? ("MULTIPLIER_LIMIT" as const) : null,
    };
  });
}
export function mustCashout(card: number, ratio: Ratio, skips: number) {
  return (
    !withinLimit(nextRatio(ratio, 12)) ||
    (skips >= MAX_SKIPS &&
      choices(card).every((c) => !withinLimit(nextRatio(ratio, winningRanks(card, c)))))
  );
}
