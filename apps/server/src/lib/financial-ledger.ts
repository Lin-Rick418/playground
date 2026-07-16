export const financialLedgerActorTypes = ["SYSTEM", "ADMIN", "PLAYER"] as const;
export const financialLedgerSources = [
  "LEGACY_OPENING_BALANCE",
  "INITIAL_FUNDING",
  "ADMIN_ADJUSTMENT",
  "BET_DEBIT",
  "SETTLEMENT_CREDIT",
] as const;
export const financialLedgerReferenceTypes = ["USER", "BALANCE_ADJUSTMENT", "BET", "ROUND"] as const;

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
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
}

export function calculateBalanceTransition(balanceBefore: number, delta: number) {
  requireSafeInteger(balanceBefore, "balanceBefore");
  requireSafeInteger(delta, "delta");

  const balanceAfter = balanceBefore + delta;
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
      !Number.isSafeInteger(entry.delta) ||
      !Number.isSafeInteger(entry.balanceBefore) ||
      !Number.isSafeInteger(entry.balanceAfter)
    ) {
      arithmeticConsistent = false;
      chainConsistent = false;
      continue;
    }

    if (entry.balanceBefore !== expectedBalanceBefore) {
      chainConsistent = false;
    }

    if (entry.balanceAfter !== entry.balanceBefore + entry.delta) {
      arithmeticConsistent = false;
    }

    expectedBalanceBefore = entry.balanceAfter;
    totalDelta += entry.delta;
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
