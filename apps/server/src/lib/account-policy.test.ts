import assert from "node:assert/strict";
import test from "node:test";
import {
  changePasswordSchema,
  getMaximumPayout,
  getPasswordPolicyViolation,
  getSafeBalanceAfterChange,
  isValidBetForTable,
  isValidTableMoneyPolicy,
  MAX_ACCOUNT_BALANCE,
  normalizeUsername,
  placeBetSchema,
  usernameSchema,
} from "./account-policy.js";

test("normalizes usernames before enforcing the canonical format", () => {
  assert.equal(normalizeUsername("  Ａlice_01  "), "alice_01");
  assert.equal(usernameSchema.parse("  Ａlice_01  "), "alice_01");
});

test("enforces password strength and prevents username inclusion", () => {
  assert.match(getPasswordPolicyViolation("short") ?? "", /at least/);
  assert.match(getPasswordPolicyViolation("OnlyLettersHere!") ?? "", /English letter and a number/);
  assert.match(getPasswordPolicyViolation("Alice!Secure2026", "alice") ?? "", /username/);
  assert.equal(getPasswordPolicyViolation("Strong!Pass2026", "alice"), null);
});

test("accepts passwords with at least six characters, an English letter and a number", () => {
  for (const password of ["abc123", "ABC123", "Abc123", "a12345", "abcdef1", "abc12!", "a".repeat(71) + "1"]) {
    assert.equal(getPasswordPolicyViolation(password), null);
    assert.equal(changePasswordSchema.safeParse({ currentPassword: "legacy", newPassword: password }).success, true);
  }
  for (const password of ["ab123", "abcdef", "123456", "!!!123", "abc 12", "中文abc1", "a".repeat(72) + "1"]) {
    assert.notEqual(getPasswordPolicyViolation(password), null);
    assert.equal(changePasswordSchema.safeParse({ currentPassword: "legacy", newPassword: password }).success, false);
  }
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

test("change-password policy rejects reuse and weak replacements", () => {
  assert.equal(
    changePasswordSchema.safeParse({ currentPassword: "Strong!Pass2026", newPassword: "Strong!Pass2026" }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({ currentPassword: "OldStrong!Pass2026", newPassword: "weak" }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({ currentPassword: "OldStrong!Pass2026", newPassword: "NewStrong!Pass2027" }).success,
    true,
  );
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
