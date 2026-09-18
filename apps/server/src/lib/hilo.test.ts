import assert from "node:assert/strict";
import test from "node:test";
import { hiloCommandSchema, toMinorUnits } from "@baccarat/contracts";
import {
  choices,
  rank,
  winningRanks,
  wins,
  nextRatio,
  INITIAL_RATIO,
  payout,
  withinLimit,
  mustCashout,
  drawCard,
  options,
  type Ratio,
} from "../modules/hilo/math.js";

test("all 52 cards and legal choices have the exact non-certain success probability", () => {
  for (let card = 0; card < 52; card++) {
    const legal = choices(card);
    assert.equal(legal.length, 2);
    for (const choice of legal) {
      const count = Array.from({ length: 52 }, (_, n) => n).filter((n) =>
        wins(card, n, choice),
      ).length;
      assert.equal(count, 4 * winningRanks(card, choice));
      assert.ok(count > 0 && count < 52);
      if (rank(card) > 1 && rank(card) < 13) assert.ok(wins(card, card, choice));
    }
  }
  assert.deepEqual(choices(0), ["higher", "same"]);
  assert.deepEqual(choices(51), ["lower", "same"]);
  assert.throws(() => wins(0, 10, "higher_or_equal"));
  assert.throws(() => rank(52));
  for (let i = 0; i < 100; i++) {
    const card = drawCard();
    assert.ok(card >= 0 && card <= 51);
  }
});

test("94% is applied once: exact conditional expectation survives every subsequent choice", () => {
  let prior: Ratio = INITIAL_RATIO;
  for (let step = 0; step < 110; step++) {
    for (let count = 1; count <= 12; count++) {
      const next = nextRatio(prior, count);
      assert.equal(
        next.numerator * BigInt(count) * prior.denominator,
        prior.numerator * 13n * next.denominator,
      );
      if (withinLimit(next))
        for (const amount of [100, 5000]) {
          const cents = toMinorUnits(payout(amount, next));
          const error = cents * next.denominator - toMinorUnits(amount) * next.numerator;
          assert.ok(2n * error <= next.denominator && 2n * error > -next.denominator);
        }
    }
    prior = nextRatio(prior, 12);
  }
  assert.equal(payout(100, nextRatio(INITIAL_RATIO, 12)), 101.83);
  assert.equal(payout(100, nextRatio(INITIAL_RATIO, 1)), 1222);
  const twice = nextRatio(nextRatio(INITIAL_RATIO, 12), 12);
  assert.equal(payout(100, twice), 110.32);
  assert.equal(payout(100, { numerator: 24691n, denominator: 20000n }), 123.46);
});

test("cap rejects guesses before drawing, and auto cashout respects remaining skips", () => {
  assert.ok(withinLimit({ numerator: 10000n, denominator: 1n }));
  assert.equal(withinLimit({ numerator: 10000001n, denominator: 1000n }), false);
  const near = { numerator: 9000n, denominator: 1n };
  assert.ok(options(24, 100, near).every((o) => !o.enabled));
  assert.equal(mustCashout(24, near, 51), false);
  assert.equal(mustCashout(24, near, 52), true);
  assert.equal(mustCashout(0, near, 52), false);
  assert.equal(mustCashout(0, { numerator: 9300n, denominator: 1n }, 0), true);
  let r = INITIAL_RATIO,
    successes = 0;
  while (withinLimit(nextRatio(r, 12))) {
    r = nextRatio(r, 12);
    successes++;
  }
  assert.ok(successes <= 116);
});

test("strict commands reject injected outcomes, invalid amounts, versions and missing ownership references", () => {
  const base = {
    type: "hilo_command",
    requestId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "test-key-1",
  };
  const ref = { previewId: base.requestId, expectedVersion: 1 };
  assert.ok(
    hiloCommandSchema.safeParse({ ...base, action: { kind: "start", amount: 100, ...ref } })
      .success,
  );
  for (const amount of [0, 99, 150, 5001, 100.5])
    assert.equal(
      hiloCommandSchema.safeParse({ ...base, action: { kind: "start", amount, ...ref } }).success,
      false,
    );
  for (const extra of [{ card: 1 }, { userId: "x" }, { payout: 100 }])
    assert.equal(
      hiloCommandSchema.safeParse({
        ...base,
        action: { kind: "start", amount: 100, ...ref, ...extra },
      }).success,
      false,
    );
  assert.equal(
    hiloCommandSchema.safeParse({
      ...base,
      action: { kind: "guess", roundId: base.requestId, expectedVersion: 0, choice: "same" },
    }).success,
    false,
  );
});
