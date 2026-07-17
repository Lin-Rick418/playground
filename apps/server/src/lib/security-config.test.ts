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

  const contentSecurityPolicy = config.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  assert.ok(contentSecurityPolicy);
  assert.match(contentSecurityPolicy, /connect-src 'self';/);
  assert.match(contentSecurityPolicy, /manifest-src 'self';/);
  assert.match(contentSecurityPolicy, /worker-src 'self';/);
  assert.doesNotMatch(contentSecurityPolicy, /connect-src[^;]*\s(?:ws:|wss:)(?:\s|;)/);
});
