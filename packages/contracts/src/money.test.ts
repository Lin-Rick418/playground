import assert from "node:assert/strict";
import test from "node:test";
import {
  toMinorUnits,
  fromMinorUnits,
  minorUnitsToDecimal,
  sumMoney,
  roundHalfUp,
} from "./money.js";
import { moneySchema, minesStartRequestSchema } from "./index.js";

test("money retains cents with exact sums, signed values, and safe decimal round trips", () => {
  assert.equal(sumMoney([100.75, 0.5]), 101.25);
  assert.equal(sumMoney([0.1, 0.2]), 0.3);
  assert.equal(sumMoney([100.75, -100]), 0.75);
  assert.equal(toMinorUnits("-123.99"), -12399n);
  assert.equal(minorUnitsToDecimal(-1n), "-0.01");
  for (const value of [0, 0.01, 1.15, -123.99, 1_999_999_999.99, 2_000_000_000]) {
    assert.equal(fromMinorUnits(toMinorUnits(value)), value);
    assert.equal(moneySchema.safeParse(value).success, true);
  }
  for (const value of [0.001, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.equal(moneySchema.safeParse(value).success, false);
});

test("ROUND_HALF_UP rounds final payout once, including exact half-cent ties", () => {
  assert.equal(fromMinorUnits(roundHalfUp(123455n, 10n)), 123.46);
  assert.equal(fromMinorUnits(roundHalfUp(123454n, 10n)), 123.45);
  assert.equal(fromMinorUnits(roundHalfUp(123456n, 10n)), 123.46);
  assert.equal(roundHalfUp(1n, 2n), 1n);
});

test("Mines stakes are exactly the fifty choices from 100 through 5000", () => {
  for (let amount = 100; amount <= 5000; amount += 100)
    assert.equal(minesStartRequestSchema.safeParse({ amount, mineCount: 3 }).success, true);
  for (const amount of [0, 99, 150, 5100, 100.01])
    assert.equal(minesStartRequestSchema.safeParse({ amount, mineCount: 3 }).success, false);
  for (let mineCount = 3; mineCount <= 24; mineCount++)
    assert.equal(minesStartRequestSchema.safeParse({ amount: 100, mineCount }).success, true);
  for (const mineCount of [0, 1, 2, 25, 1.5])
    assert.equal(minesStartRequestSchema.safeParse({ amount: 100, mineCount }).success, false);
});
