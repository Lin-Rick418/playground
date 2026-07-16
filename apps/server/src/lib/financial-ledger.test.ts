import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalanceTransition, reconcileFinancialLedger } from "./financial-ledger.js";

test("reconciles initial funding, bet debit, settlement credit, and admin adjustment", () => {
  const result = reconcileFinancialLedger(850, [
    { entrySequence: 4, delta: -50, balanceBefore: 900, balanceAfter: 850 },
    { entrySequence: 2, delta: -300, balanceBefore: 1000, balanceAfter: 700 },
    { entrySequence: 1, delta: 1000, balanceBefore: 0, balanceAfter: 1000 },
    { entrySequence: 3, delta: 200, balanceBefore: 700, balanceAfter: 900 },
  ]);

  assert.deepEqual(result, {
    currentBalance: 850,
    ledgerBalance: 850,
    totalDelta: 850,
    entryCount: 4,
    chainConsistent: true,
    arithmeticConsistent: true,
    isReconciled: true,
  });
});

test("detects broken ledger chains and current balance drift", () => {
  const brokenChain = reconcileFinancialLedger(900, [
    { entrySequence: 1, delta: 1000, balanceBefore: 0, balanceAfter: 1000 },
    { entrySequence: 2, delta: -100, balanceBefore: 950, balanceAfter: 850 },
  ]);
  const balanceDrift = reconcileFinancialLedger(999, [
    { entrySequence: 1, delta: 1000, balanceBefore: 0, balanceAfter: 1000 },
  ]);

  assert.equal(brokenChain.chainConsistent, false);
  assert.equal(brokenChain.isReconciled, false);
  assert.equal(balanceDrift.chainConsistent, true);
  assert.equal(balanceDrift.isReconciled, false);
});

test("rejects unsafe or negative balance transitions", () => {
  assert.deepEqual(calculateBalanceTransition(1000, -250), {
    balanceBefore: 1000,
    delta: -250,
    balanceAfter: 750,
  });
  assert.throws(() => calculateBalanceTransition(100, -101), /Balance cannot be negative/);
  assert.throws(() => calculateBalanceTransition(Number.MAX_SAFE_INTEGER, 1), /safe integer/);
});
