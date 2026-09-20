import assert from "node:assert/strict";
import test from "node:test";
import { toMinorUnits } from "@baccarat/contracts";
import {
  choose,
  exceedsMinesMultiplierLimit,
  generateMineCells,
  minesMultiplier,
  minesPayout,
} from "../modules/mines/math.js";
import { publicMinesRound } from "../modules/mines/service.js";
import { calculateBalanceTransition, reconcileFinancialLedger } from "./financial-ledger.js";
import { getSafeBalanceAfterChange, MAX_ACCOUNT_BALANCE } from "./account-policy.js";

test("the base Mines payout formula has 95% expectation before the v2 forced-loss rule", () => {
  for (let mines = 1; mines <= 24; mines++) {
    let survivalNumerator = 1n,
      survivalDenominator = 1n;
    for (let safe = 1; safe <= 25 - mines; safe++) {
      survivalNumerator *= BigInt(26 - mines - safe);
      survivalDenominator *= BigInt(26 - safe);
      assert.equal(
        survivalNumerator * choose(25, safe),
        survivalDenominator * choose(25 - mines, safe),
      );
      for (let amount = 100; amount <= 5000; amount += 100) {
        const paidCents = toMinorUnits(minesPayout(amount, mines, safe));
        const exactNumerator = BigInt(amount) * 95n * survivalDenominator;
        const error = paidCents * survivalNumerator - exactNumerator;
        assert.ok(2n * error <= survivalNumerator && 2n * error > -survivalNumerator);
      }
    }
  }
  assert.equal(minesPayout(100, 1, 1), 98.96);
  assert.ok(minesMultiplier(1, 1) < 1);
  assert.equal(minesPayout(100, 24, 1), 2375);
});

test("v2 caps every reachable safe result using the exact ratio across all mine counts", () => {
  for (let mines = 3; mines <= 24; mines++) {
    let capReached = false;
    for (let safe = 1; safe <= 25 - mines; safe++) {
      const capped = exceedsMinesMultiplierLimit(mines, safe);
      assert.equal(capped, minesMultiplier(mines, safe) > 1000);
      if (capReached) assert.equal(capped, true);
      capReached ||= capped;
      if (!capped) {
        for (let amount = 100; amount <= 5000; amount += 100) {
          assert.ok(minesPayout(amount, mines, safe) <= amount * 1000);
        }
      }
    }
  }
  assert.equal(exceedsMinesMultiplierLimit(24, 1), false);
  assert.equal(exceedsMinesMultiplierLimit(10, 15), true);
});

test("random boards have unique bounded cells and public active state never reveals the private board", () => {
  for (let count = 1; count <= 24; count++) {
    const board = generateMineCells(count);
    assert.equal(board.length, count);
    assert.equal(new Set(board).size, count);
    assert.ok(board.every((cell) => cell >= 0 && cell <= 24));
  }
  const row = {
    id: "test",
    amount: "100.00",
    mine_count: 1,
    mine_cells: [24],
    revealed_cells: [0],
    status: "ACTIVE",
    payout: "0.00",
    version: 2,
    created_at: new Date(),
    settled_at: null,
  };
  const active = publicMinesRound(row);
  assert.equal(active.mineCells, null);
  assert.equal(active.cashoutAmount, 98.96);
  assert.deepEqual(
    publicMinesRound({ ...row, status: "LOST", settled_at: new Date() }).mineCells,
    [24],
  );
});

test("ledger arithmetic and account boundaries retain cents", () => {
  assert.equal(calculateBalanceTransition(100.75, -100).balanceAfter, 0.75);
  assert.equal(getSafeBalanceAfterChange(MAX_ACCOUNT_BALANCE - 0.01, 0.01), MAX_ACCOUNT_BALANCE);
  assert.equal(getSafeBalanceAfterChange(MAX_ACCOUNT_BALANCE, 0.01), null);
  assert.equal(
    reconcileFinancialLedger(0.3, [
      { entrySequence: 1, balanceBefore: 0, delta: 0.1, balanceAfter: 0.1 },
      { entrySequence: 2, balanceBefore: 0.1, delta: 0.2, balanceAfter: 0.3 },
    ]).isReconciled,
    true,
  );
});
