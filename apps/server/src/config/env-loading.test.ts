import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const strongSecret = "R3ss2wgJ9G1O7awNyJf3X9mjQFM9G0c3KNB2c4ipSfJ49IxMpwYFC1xlYdO9dYlT";

function loadEnv(overrides: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      'const { env } = await import("./src/config/env.ts"); console.log(JSON.stringify(env))',
    ],
    {
      cwd: serverRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        JWT_SECRET: strongSecret,
        CORS_ORIGIN: "false",
        DATABASE_SSL: "false",
        ...overrides,
      },
    },
  );
}

test("environment loading rejects invalid PORT values", () => {
  const result = loadEnv({ PORT: "8O80" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PORT must be an integer between 1 and 65535/);
});

test("environment loading rejects unknown DATABASE_SSL modes", () => {
  const result = loadEnv({ DATABASE_SSL: "yes" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_SSL must be one of: false, true, no-verify/);
});

test("environment loading rejects multiple CORS origins", () => {
  const result = loadEnv({ CORS_ORIGIN: "https://one.example,https://two.example" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CORS_ORIGIN must be false or one http\(s\) origin/);
});

test("environment loading returns typed normalized values", () => {
  const result = loadEnv({
    PORT: "443",
    HOST: "api.internal.example",
    DATABASE_SSL: "TRUE",
    CORS_ORIGIN: "https://app.example.com/",
  });

  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(loaded.port, 443);
  assert.equal(loaded.host, "api.internal.example");
  assert.equal(loaded.databaseSsl, "true");
  assert.equal(loaded.corsOrigin, "https://app.example.com");
});

test("Blackjack requires an explicit boolean feature flag", () => {
  for (const [value, expected] of [["true", true], ["false", false]] as const) {
    const result = loadEnv({ BLACKJACK_ENABLED: value });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).blackjackEnabled, expected);
  }
  const invalid = loadEnv({ BLACKJACK_ENABLED: "yes" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /BLACKJACK_ENABLED must be true or false/);
});
