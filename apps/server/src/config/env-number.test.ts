import assert from "node:assert/strict";
import test from "node:test";
import { parseBoundedInteger } from "./env-number.js";

test("bounded integer environment values fail closed", () => {
  assert.equal(parseBoundedInteger("POOL", undefined, 20, { min: 1, max: 100 }), 20);
  assert.equal(parseBoundedInteger("POOL", "50", 20, { min: 1, max: 100 }), 50);
  assert.throws(() => parseBoundedInteger("POOL", "0", 20, { min: 1, max: 100 }), /POOL/);
  assert.throws(() => parseBoundedInteger("POOL", "10.5", 20, { min: 1, max: 100 }), /POOL/);
  assert.throws(() => parseBoundedInteger("POOL", "101", 20, { min: 1, max: 100 }), /POOL/);
});
