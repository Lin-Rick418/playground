import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production nginx config sets the required browser security headers", () => {
  const config = readFileSync(new URL("../../../../deploy/nginx/baccarat.conf", import.meta.url), "utf8");

  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /Strict-Transport-Security/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /X-Content-Type-Options nosniff/);
  assert.match(config, /Referrer-Policy strict-origin-when-cross-origin/);
  assert.match(config, /Permissions-Policy/);
});
