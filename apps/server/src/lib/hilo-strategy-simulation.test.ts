import assert from "node:assert/strict";
import test from "node:test";
import { simulateStrategyRound, strategyChoice } from "./hilo-strategy-simulation.js";
import { INITIAL_RATIO, nextRatio, payout, MAX_SKIPS } from "../modules/hilo/math.js";
import { toMinorUnits } from "@baccarat/contracts";

const card = (rank: number) => (rank - 1) * 4;

test("strategy only chooses A/2/3 higher and J/Q/K lower for every suit", () => {
  const expected = [
    "higher",
    "higher_or_equal",
    "higher_or_equal",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "lower_or_equal",
    "lower_or_equal",
    "lower",
  ];
  for (let index = 0; index < 52; index++)
    assert.equal(strategyChoice(index), expected[Math.floor(index / 4)]);
});

test("preview selection is free; A-to-A higher loses the whole bet", () => {
  const sequence = [card(7), card(4), card(1), card(1)];
  const round = simulateStrategyRound(() => sequence.shift()!);
  assert.deepEqual(round, {
    reason: "lost",
    payoutCents: 0n,
    guesses: 1,
    skips: 0,
    previewRefreshes: 2,
  });
});

for (const target of [3n, 50n]) {
  test(`same-rank twos win; stop at the first exact multiplier strictly above ${target}`, () => {
    const round = simulateStrategyRound(() => card(2), target);
    assert.equal(round.reason, "target_cashout");
    assert.equal(round.skips, 0);
    let ratio = INITIAL_RATIO;
    for (let i = 0; i < round.guesses; i++) {
      assert.ok(ratio.numerator <= target * ratio.denominator);
      ratio = nextRatio(ratio, 12);
    }
    assert.ok(ratio.numerator > target * ratio.denominator);
    assert.equal(round.payoutCents, toMinorUnits(payout(100, ratio)));
  });
}

test("52 skips do not change the multiplier; exhaust the limit and cash out", () => {
  let draws = 0;
  const round = simulateStrategyRound(() => (++draws === 1 ? card(1) : card(7)));
  assert.equal(round.reason, "skip_limit_cashout");
  assert.equal(round.guesses, 1);
  assert.equal(round.skips, MAX_SKIPS);
  assert.equal(draws, MAX_SKIPS + 2);
  assert.equal(round.payoutCents, 10183n);
});
