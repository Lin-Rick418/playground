import assert from "node:assert/strict";
import test from "node:test";
import {
  STORM_STAKES,
  STORM_BALANCED_SETTINGS,
  initialStormProgress,
  stormActionSchema,
  stormConfigResponseSchema,
  stormSpinResultSchema,
  toMinorUnits,
} from "@baccarat/contracts";
import { spin } from "../modules/storm/math.js";
import { spinBalanced } from "../modules/storm/math-v2.js";
import { configuredSpinner } from "../modules/storm/math-v3.js";

test("Storm contracts advertise eight stakes and still read legacy requests/configs", () => {
  const config = {
    stakes: [...STORM_STAKES],
    ruleVersion: 1,
    enabled: true,
    maxWinFactor: 25000,
    rtp: null,
  };
  assert.deepEqual(STORM_STAKES, [10, 50, 100, 200, 500, 1000, 2000, 5000]);
  stormConfigResponseSchema.parse(config);
  stormConfigResponseSchema.parse({ ...config, stakes: [10, 20, 50, 100] });
  for (const amount of [...STORM_STAKES, 20])
    stormActionSchema.parse({ kind: "spin", amount, expectedVersion: 0, ruleVersion: 1 });
  for (const amount of [0, 11, 30, 200.5, 5001, Infinity, NaN])
    assert.equal(
      stormActionSchema.safeParse({ kind: "spin", amount, expectedVersion: 0, ruleVersion: 1 })
        .success,
      false,
    );
});

const profile = { payoutScale: 1_000_000, maxWinFactor: 1000 };
const engines = {
  legacy: (state: Parameters<typeof spin>[0], stake: number) => spin(state, stake, () => 0),
  balanced: (state: Parameters<typeof spin>[0], stake: number) =>
    spinBalanced(state, stake, profile, () => 0),
  configurable: (state: Parameters<typeof spin>[0], stake: number) =>
    configuredSpinner({ ...profile, settings: STORM_BALANCED_SETTINGS })(state, stake, () => 0),
};
for (const [name, engine] of Object.entries(engines))
  test(`${name} accepts every stake with proportional payouts, exact debits and no free debit`, () => {
    for (const freeLeft of [0, 1]) {
      const state = {
        ...initialStormProgress(),
        balance: 1_000_000.01,
        freeLeft,
        freeGranted: freeLeft ? 30 : 0,
      };
      const base = engine(state, 10);
      for (const stake of [...STORM_STAKES, 20]) {
        const result = stormSpinResultSchema.parse(engine(state, stake));
        assert.equal(result.cost, freeLeft ? 0 : stake);
        assert.equal(toMinorUnits(result.payout) * 10n, toMinorUnits(base.payout) * BigInt(stake));
        assert.equal(
          toMinorUnits(result.state.balance),
          toMinorUnits(state.balance) - toMinorUnits(result.cost) + toMinorUnits(result.payout),
        );
        assert.deepEqual(
          result.board.map((tile) => tile.kind),
          base.board.map((tile) => tile.kind),
        );
      }
      for (const stake of [0, 30, 200.5, 5001, Infinity, NaN])
        assert.throws(() => engine(state, stake));
    }
  });
