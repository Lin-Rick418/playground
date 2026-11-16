import assert from "node:assert/strict";
import test from "node:test";
import {
  initialStormProgress,
  stormSpinResultSchema,
  toMinorUnits,
  type StormProgress,
} from "@baccarat/contracts";
import { spinBalanced } from "../modules/storm/math-v2.js";
import { seededRandom } from "../modules/storm/calibration.js";
const profile = { payoutScale: 200000, maxWinFactor: 1000 };

test("balanced model preserves exact wallet accounting and series limits at every stake", () => {
  for (const stake of [10, 20, 50, 100]) {
    const rng = seededRandom(53123 + stake);
    for (let cycle = 0; cycle < 500; cycle++) {
      let state: StormProgress & { balance: number } = {
        ...initialStormProgress(),
        balance: 1_000_000,
      };
      let total = 0n,
        count = 0;
      do {
        const result = spinBalanced(state, stake, profile, rng);
        stormSpinResultSchema.parse(result);
        assert.equal(
          toMinorUnits(result.state.balance),
          toMinorUnits(state.balance) - toMinorUnits(result.cost) + toMinorUnits(result.payout),
        );
        assert.equal(result.wasFree, state.freeLeft > 0);
        assert.equal(
          new Set(result.upgrades.map((event) => event.id)).size,
          result.upgrades.length,
        );
        assert(result.factor <= 20 && result.state.multiplier <= 10);
        total += toMinorUnits(result.payout);
        assert.equal(toMinorUnits(result.state.cycleWin!), total);
        state = result.state;
        assert(++count <= 31);
      } while (state.freeLeft);
      assert(total <= toMinorUnits(stake * profile.maxWinFactor));
    }
  }
});

test("fast offline evaluation consumes exactly the same RNG and settles the same outcomes", () => {
  const captured = seededRandom(2016),
    offline = seededRandom(2016);
  let a: StormProgress & { balance: number } = { ...initialStormProgress(), balance: 1_000_000 };
  let b = { ...a };
  for (let i = 0; i < 2000; i++) {
    const full = spinBalanced(a, 20, profile, captured);
    const fast = spinBalanced(b, 20, profile, offline, false);
    assert.deepEqual({ ...full, frames: [] }, fast);
    a = full.state;
    b = fast.state;
  }
});

test("whole-cycle cap counts paid payouts and closes remaining free spins", () => {
  const result = spinBalanced(
    { ...initialStormProgress(), balance: 10000, freeLeft: 5, freeGranted: 10, cycleWin: 1999.99 },
    20,
    { payoutScale: 10000000, maxWinFactor: 100 },
    () => 0,
  );
  assert.equal(result.payout, 0.01);
  assert.equal(result.state.cycleWin, 2000);
  assert.equal(result.state.freeLeft, 0);
  assert.equal(result.capped, true);
});

test("new paid cycle clears previous cycle winnings and rejects invalid parameters", () => {
  const state = { ...initialStormProgress(), balance: 10000, cycleWin: 20000 };
  const result = spinBalanced(state, 20, profile, () => 0);
  assert.equal(result.state.cycleWin, result.payout);
  assert.throws(() => spinBalanced(state, 20, { ...profile, payoutScale: 0 }));
});
