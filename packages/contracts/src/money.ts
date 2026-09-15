/** Exact monetary arithmetic. Numbers are transport values, never arithmetic operands. */
export function toMinorUnits(value: number | string): bigint {
  const text = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new RangeError("Money must have at most two decimal places");
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Money minor units must be a safe integer");
  }
  return negative ? -minor : minor;
}

export function minorUnitsToDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function fromMinorUnits(value: bigint): number {
  const decimal = minorUnitsToDecimal(value);
  const result = Number(decimal);
  if (toMinorUnits(result) !== value) throw new RangeError("Money cannot be represented safely");
  return result;
}

export function isMoney(value: number): boolean {
  try {
    toMinorUnits(value);
    return Number.isFinite(value);
  } catch {
    return false;
  }
}

export function sumMoney(values: readonly number[]): number {
  return fromMinorUnits(values.reduce((sum, value) => sum + toMinorUnits(value), 0n));
}

/** ROUND_HALF_UP for a nonnegative exact rational, in minor units. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("Invalid rounding operands");
  return (2n * numerator + denominator) / (2n * denominator);
}
