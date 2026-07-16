import assert from "node:assert/strict";
import test from "node:test";
import { verifyLoginPassword } from "./login-password.js";

test("unknown users still execute one password hash comparison", async () => {
  const comparisons: Array<{ password: string; passwordHash: string }> = [];

  const result = await verifyLoginPassword("guess", undefined, async (password, passwordHash) => {
    comparisons.push({ password, passwordHash });
    return false;
  });

  assert.equal(result, false);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].password, "guess");
  assert.match(comparisons[0].passwordHash, /^\$2[aby]\$/);
});
