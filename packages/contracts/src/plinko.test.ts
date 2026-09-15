import assert from "node:assert/strict";
import test from "node:test";
import {
  plinkoStartRequestSchema,
  plinkoRoundSchema,
  plinkoMutationResponseSchema,
} from "./plinko.js";

test("Plinko rejects forged outcomes and invalid betting settings", () => {
  const bet = { amount: 100, rows: 16, risk: "medium", ruleVersion: 1 };
  assert.ok(plinkoStartRequestSchema.safeParse(bet).success);
  for (const change of [
    { amount: 0 },
    { amount: 101 },
    { amount: 5100 },
    { rows: 7 },
    { rows: 17 },
    { rows: 8.5 },
    { risk: "expert" },
    { multiplier: 1000 },
    { slotIndex: 0 },
    { userId: "another" },
  ])
    assert.equal(plinkoStartRequestSchema.safeParse({ ...bet, ...change }).success, false);
  // Positive unknown versions reach the business conflict handler, not silent coercion.
  assert.ok(plinkoStartRequestSchema.safeParse({ ...bet, ruleVersion: 2 }).success);
});

test("Plinko response path, precision and wallet version are validated", () => {
  const round = {
    id: "51979dfd-1a04-4330-85a4-4747b5470543",
    amount: 100,
    rows: 16,
    risk: "high",
    path: Array(16).fill(0),
    slotIndex: 0,
    multiplier: 964.8761,
    payout: 96487.61,
    ruleVersion: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    settledAt: "2026-09-15T00:00:00.000Z",
  };
  assert.ok(plinkoRoundSchema.safeParse(round).success);
  assert.equal(plinkoRoundSchema.safeParse({ ...round, path: [0, 1] }).success, false);
  assert.equal(plinkoRoundSchema.safeParse({ ...round, slotIndex: 1 }).success, false);
  assert.equal(plinkoRoundSchema.safeParse({ ...round, multiplier: 964.87612 }).success, false);
  assert.equal(plinkoMutationResponseSchema.safeParse({ round, balance: 10 }).success, false);
  assert.ok(
    plinkoMutationResponseSchema.safeParse({ round, balance: 10.01, walletVersion: 2 }).success,
  );
});
