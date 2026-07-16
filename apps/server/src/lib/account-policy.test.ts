import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustBalanceSchema,
  createPlayerSchema,
  getMaximumPayout,
  getPasswordPolicyViolation,
  getSafeBalanceAfterChange,
  isValidBetForTable,
  isValidTableMoneyPolicy,
  MAX_ACCOUNT_BALANCE,
  normalizeUsername,
  placeBetSchema,
  toSafeAdminUser,
  toSafeUser,
  wouldRemoveLastActiveAdmin,
} from "./account-policy.js";

test("normalizes usernames before enforcing the canonical format", () => {
  assert.equal(normalizeUsername("  Ａlice_01  "), "alice_01");
  const result = createPlayerSchema.parse({
    username: "  Ａlice_01  ",
    password: "Strong!Pass2026",
    balance: 1_000,
  });
  assert.equal(result.username, "alice_01");
});

test("enforces password strength and prevents username inclusion", () => {
  assert.match(getPasswordPolicyViolation("short") ?? "", /at least/);
  assert.match(getPasswordPolicyViolation("OnlyLettersHere!") ?? "", /uppercase, lowercase, number/);
  assert.match(getPasswordPolicyViolation("Alice!Secure2026", "alice") ?? "", /username/);
  assert.equal(getPasswordPolicyViolation("Strong!Pass2026", "alice"), null);
});

test("rejects unsafe, non-denominated, duplicate, and extra bet inputs", () => {
  assert.equal(placeBetSchema.safeParse({ bets: [{ betType: "PLAYER", amount: 101 }] }).success, false);
  assert.equal(
    placeBetSchema.safeParse({ bets: [{ betType: "PLAYER", amount: Number.MAX_SAFE_INTEGER + 1 }] }).success,
    false,
  );
  assert.equal(
    placeBetSchema.safeParse({
      bets: [
        { betType: "PLAYER", amount: 100 },
        { betType: "PLAYER", amount: 200 },
      ],
    }).success,
    false,
  );
  assert.equal(placeBetSchema.safeParse({ bets: [{ betType: "PLAYER", amount: 100, hidden: true }] }).success, false);
});

test("enforces adjustment range, denomination, and non-zero policy", () => {
  assert.equal(adjustBalanceSchema.safeParse({ userId: crypto.randomUUID(), amount: 0 }).success, false);
  assert.equal(adjustBalanceSchema.safeParse({ userId: crypto.randomUUID(), amount: -250 }).success, false);
  assert.equal(adjustBalanceSchema.safeParse({ userId: crypto.randomUUID(), amount: 10_000 }).success, true);
});

test("table money policy is authoritative for every individual bet", () => {
  assert.equal(isValidTableMoneyPolicy(100, 10_000), true);
  assert.equal(isValidTableMoneyPolicy(50, 10_000), false);
  assert.equal(isValidTableMoneyPolicy(10_000, 100), false);
  assert.equal(isValidBetForTable(100, 100, 10_000), true);
  assert.equal(isValidBetForTable(10_100, 100, 10_000), false);
  assert.equal(isValidBetForTable(150, 100, 10_000), false);
});

test("balance math and payout exposure remain within the supported integer range", () => {
  assert.equal(getSafeBalanceAfterChange(1_000, -1_000), 0);
  assert.equal(getSafeBalanceAfterChange(0, -100), null);
  assert.equal(getSafeBalanceAfterChange(MAX_ACCOUNT_BALANCE, 100), null);
  assert.equal(getMaximumPayout("TIE", 100), 900);
  assert.equal(getMaximumPayout("PLAYER_PAIR", 100), 1_200);
});

test("prevents removing the last effective admin while allowing safe transitions", () => {
  const activeAdmin = { role: "ADMIN" as const, isActive: true };
  assert.equal(wouldRemoveLastActiveAdmin(activeAdmin, false, 1), true);
  assert.equal(wouldRemoveLastActiveAdmin(activeAdmin, false, 2), false);
  assert.equal(wouldRemoveLastActiveAdmin(activeAdmin, true, 1), false);
  assert.equal(wouldRemoveLastActiveAdmin({ role: "PLAYER", isActive: true }, false, 1), false);
});

test("safe serializers never expose password hashes or session versions", () => {
  const user = {
    id: crypto.randomUUID(),
    username: "alice",
    passwordHash: "$2b$12$secret",
    authVersion: 4,
    role: "PLAYER" as const,
    isActive: true,
    balance: 1_000,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  assert.deepEqual(Object.keys(toSafeUser(user)).sort(), ["balance", "id", "isActive", "role", "username"]);
  assert.deepEqual(Object.keys(toSafeAdminUser(user)).sort(), [
    "balance",
    "createdAt",
    "id",
    "isActive",
    "role",
    "username",
  ]);
});
