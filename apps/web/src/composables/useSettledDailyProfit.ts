import { ref } from "vue";

export function getRollingMoneyValue(start: number, end: number, progress: number) {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const easedProgress = 1 - (1 - clampedProgress) ** 3;
  return Math.round(start + (end - start) * easedProgress);
}

export function isPayoutBalanceReady(options: {
  balanceBeforePayout: number | null;
  currentBalance: number | null;
  payoutAmount: number;
}) {
  if (options.payoutAmount <= 0 || options.balanceBeforePayout === null) {
    return true;
  }

  return options.currentBalance === options.balanceBeforePayout + options.payoutAmount;
}

export function useSettledDailyProfit() {
  const displayedProfit = ref<number | null>(null);
  const animationRevision = ref(0);
  let initialized = false;

  function initialize(profit: number | null) {
    if (initialized) {
      return;
    }

    initialized = true;
    displayedProfit.value = profit;
  }

  function applySettlement(profit: number | null, animate = true) {
    if (profit === null) {
      return false;
    }

    initialized = true;

    if (profit === displayedProfit.value) {
      return false;
    }

    displayedProfit.value = profit;
    if (animate) {
      animationRevision.value += 1;
    }
    return true;
  }

  return {
    displayedProfit,
    animationRevision,
    initialize,
    applySettlement,
  };
}
