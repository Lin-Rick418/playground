import { sumMoney as sumExactMoney } from "@baccarat/contracts";

/** Format balances for the player UI without exposing fractional credits. */
export function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  const truncated = Math.trunc(value);
  return (Object.is(truncated, -0) ? 0 : truncated).toLocaleString("zh-TW");
}

/** Keep addition exact at the server's 0.01-credit precision. */
export function sumMoney(values: number[]) {
  return sumExactMoney(values);
}
