import { describe, expect, it } from "vitest";
import {
  getRollingMoneyValue,
  isPayoutBalanceReady,
  useSettledDailyProfit,
} from "./useSettledDailyProfit";

describe("getRollingMoneyValue", () => {
  it("lands on the exact settlement amount in either direction", () => {
    expect(getRollingMoneyValue(1_000, 1_600, 0)).toBe(1_000);
    expect(getRollingMoneyValue(1_000, 1_600, 0.5)).toBeGreaterThan(1_000);
    expect(getRollingMoneyValue(1_000, 1_600, 1)).toBe(1_600);
    expect(getRollingMoneyValue(500, -200, 1)).toBe(-200);
  });
});

describe("isPayoutBalanceReady", () => {
  it("waits for the personal balance snapshot that includes the settlement payout", () => {
    expect(
      isPayoutBalanceReady({
        balanceBeforePayout: 9_900,
        currentBalance: 9_900,
        payoutAmount: 200,
      }),
    ).toBe(false);
    expect(
      isPayoutBalanceReady({
        balanceBeforePayout: 9_900,
        currentBalance: 10_100,
        payoutAmount: 200,
      }),
    ).toBe(true);
  });
});

describe("useSettledDailyProfit", () => {
  it("ignores store changes until a settlement is explicitly applied", () => {
    const profit = useSettledDailyProfit();

    profit.initialize(1_200);
    profit.initialize(1_500);

    expect(profit.displayedProfit.value).toBe(1_200);
    expect(profit.animationRevision.value).toBe(0);
    expect(profit.applySettlement(1_450)).toBe(true);
    expect(profit.displayedProfit.value).toBe(1_450);
    expect(profit.animationRevision.value).toBe(1);
  });

  it("keeps the last known amount when settlement profit is unavailable", () => {
    const profit = useSettledDailyProfit();
    profit.initialize(-300);

    expect(profit.applySettlement(null)).toBe(false);
    expect(profit.displayedProfit.value).toBe(-300);
  });

  it("can apply a missed settlement without replaying the animation", () => {
    const profit = useSettledDailyProfit();
    profit.initialize(500);

    expect(profit.applySettlement(700, false)).toBe(true);
    expect(profit.displayedProfit.value).toBe(700);
    expect(profit.animationRevision.value).toBe(0);
  });
});
