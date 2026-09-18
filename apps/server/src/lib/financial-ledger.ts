import { isMoney, sumMoney, toMinorUnits } from "@baccarat/contracts";
export const financialLedgerActorTypes = ["SYSTEM", "ADMIN", "PLAYER"] as const;
export const financialLedgerSources = [
  "LEGACY_OPENING_BALANCE",
  "INITIAL_FUNDING",
  "ADMIN_ADJUSTMENT",
  "BET_DEBIT",
  "PLINKO_BET_DEBIT",
  "PLINKO_SETTLEMENT_CREDIT",
  "HILO_BET_DEBIT",
  "HILO_SETTLEMENT_CREDIT",
  "MINES_BET_DEBIT",
  "MINES_SETTLEMENT_CREDIT",
  "SETTLEMENT_CREDIT",
] as const;
export const financialLedgerReferenceTypes = ["USER", "BALANCE_ADJUSTMENT", "BET", "ROUND", "MINES_ROUND", "PLINKO_ROUND", "HILO_ROUND"] as const;

export type FinancialLedgerActorType = (typeof financialLedgerActorTypes)[number];
export type FinancialLedgerSource = (typeof financialLedgerSources)[number];
export type FinancialLedgerReferenceType = (typeof financialLedgerReferenceTypes)[number];

export type FinancialLedgerReconciliationEntry = {
  entrySequence: number;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
};

function requireSafeInteger(value: number, name: string) {
  if (!isMoney(value)) {
    throw new RangeError(`${name} must have safe integer minor units`);
  }
}

export function calculateBalanceTransition(balanceBefore: number, delta: number) {
  requireSafeInteger(balanceBefore, "balanceBefore");
  requireSafeInteger(delta, "delta");

  const balanceAfter = sumMoney([balanceBefore, delta]);
  requireSafeInteger(balanceAfter, "balanceAfter");

  if (balanceBefore < 0 || balanceAfter < 0) {
    throw new RangeError("Balance cannot be negative");
  }

  return { balanceBefore, delta, balanceAfter };
}

export function reconcileFinancialLedger(
  currentBalance: number,
  entries: FinancialLedgerReconciliationEntry[],
) {
  requireSafeInteger(currentBalance, "currentBalance");

  const orderedEntries = [...entries].sort((left, right) => left.entrySequence - right.entrySequence);
  let expectedBalanceBefore = 0;
  let totalDelta = 0;
  let chainConsistent = orderedEntries.length > 0;
  let arithmeticConsistent = orderedEntries.length > 0;

  for (const entry of orderedEntries) {
    if (
      !Number.isSafeInteger(entry.entrySequence) ||
      !isMoney(entry.delta) ||
      !isMoney(entry.balanceBefore) ||
      !isMoney(entry.balanceAfter)
    ) {
      arithmeticConsistent = false;
      chainConsistent = false;
      continue;
    }

    if (entry.balanceBefore !== expectedBalanceBefore) {
      chainConsistent = false;
    }

    if (toMinorUnits(entry.balanceAfter) !== toMinorUnits(entry.balanceBefore) + toMinorUnits(entry.delta)) {
      arithmeticConsistent = false;
    }

    expectedBalanceBefore = entry.balanceAfter;
    totalDelta = sumMoney([totalDelta, entry.delta]);
  }

  const ledgerBalance = orderedEntries.length > 0 ? orderedEntries.at(-1)!.balanceAfter : 0;
  const isReconciled =
    chainConsistent &&
    arithmeticConsistent &&
    ledgerBalance === totalDelta &&
    ledgerBalance === currentBalance;

  return {
    currentBalance,
    ledgerBalance,
    totalDelta,
    entryCount: orderedEntries.length,
    chainConsistent,
    arithmeticConsistent,
    isReconciled,
  };
}
