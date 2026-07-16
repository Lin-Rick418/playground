import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requireStrongJwtSecret } from "./jwt-secret.js";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const strongSecret = "R3ss2wgJ9G1O7awNyJf3X9mjQFM9G0c3KNB2c4ipSfJ49IxMpwYFC1xlYdO9dYlT";

function loadProductionEnv(jwtSecret: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", 'await import("./src/config/env.ts")'],
    {
      cwd: serverRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        JWT_SECRET: jwtSecret,
        NODE_ENV: "production",
      },
    },
  );
}

test("rejects a missing production JWT secret", () => {
  assert.throws(() => requireStrongJwtSecret(undefined), /is required/);
  assert.throws(() => requireStrongJwtSecret(""), /is required/);
});

test("rejects known placeholder values even when they are long enough", () => {
  assert.throws(
    () => requireStrongJwtSecret("replace-with-a-long-random-secret"),
    /placeholder/,
  );
  assert.throws(
    () => requireStrongJwtSecret("CHANGE-ME-to-a-longer-production-secret"),
    /placeholder/,
  );
});

test("rejects secrets shorter than 32 bytes", () => {
  assert.throws(() => requireStrongJwtSecret("aB3!".repeat(7)), /at least 32 bytes/);
});

test("rejects long but predictably repeated secrets", () => {
  assert.throws(() => requireStrongJwtSecret("abcd1234".repeat(8)), /insufficient entropy/);
  assert.throws(
    () => requireStrongJwtSecret(`${"A".repeat(40)}bcdefghi`),
    /insufficient entropy/,
  );
});

test("accepts a high-entropy secret", () => {
  assert.equal(requireStrongJwtSecret(strongSecret), strongSecret);
});

test("production environment loading fails closed on an empty secret", () => {
  const result = loadProductionEnv("");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET is required outside development/);
});

test("production environment loading accepts a generated high-entropy secret", () => {
  const result = loadProductionEnv(strongSecret);

  assert.equal(result.status, 0, result.stderr);
});
