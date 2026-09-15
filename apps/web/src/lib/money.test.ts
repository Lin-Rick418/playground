import { describe, expect, it } from "vitest";
import { formatMoney, sumMoney } from "./money";

describe("player money display", () => {
  it("truncates fractional credits toward zero, including negative values", () => {
    expect(formatMoney(123.99)).toBe("123");
    expect(formatMoney(-123.99)).toBe("-123");
    expect(formatMoney(-0.99)).toBe("0");
    expect(formatMoney(null)).toBe("--");
  });

  it("adds values in minor units before presentation", () => {
    expect(sumMoney([100.75, 0.5])).toBe(101.25);
    expect(sumMoney([0.1, 0.2, -0.3])).toBe(0);
    expect(formatMoney(sumMoney([-123.99, 0.5]))).toBe("-123");
  });
});
