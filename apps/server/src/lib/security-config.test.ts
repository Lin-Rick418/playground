import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production nginx config sets the required browser security headers", () => {
  const config = readFileSync(new URL("../../../../deploy/nginx/baccarat.conf", import.meta.url), "utf8");
  const httpsBlockOffset = config.indexOf("server {\n  listen 443 ssl http2;");
  assert.ok(httpsBlockOffset > 0);
  const httpBlock = config.slice(0, httpsBlockOffset);
  const httpsBlock = config.slice(httpsBlockOffset);

  assert.match(httpBlock, /listen 80;/);
  assert.match(httpBlock, /\.well-known\/acme-challenge/);
  assert.match(httpBlock, /return 301 https:\/\/\$host\$request_uri;/);
  assert.doesNotMatch(httpBlock, /Strict-Transport-Security|proxy_pass|apps\/web\/dist/);
  assert.match(httpsBlock, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(httpsBlock, /ssl_session_tickets off;/);
  assert.match(httpsBlock, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(httpsBlock, /includeSubDomains|preload/);

  assert.match(httpsBlock, /Content-Security-Policy/);
  assert.match(httpsBlock, /frame-ancestors 'none'/);
  assert.match(httpsBlock, /X-Content-Type-Options nosniff/);
  assert.match(httpsBlock, /Referrer-Policy strict-origin-when-cross-origin/);
  assert.match(httpsBlock, /Permissions-Policy/);

  const contentSecurityPolicy = httpsBlock.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  assert.ok(contentSecurityPolicy);
  assert.match(contentSecurityPolicy, /connect-src 'self';/);
  assert.match(contentSecurityPolicy, /manifest-src 'self';/);
  assert.match(contentSecurityPolicy, /worker-src 'self';/);
  assert.doesNotMatch(contentSecurityPolicy, /connect-src[^;]*\s(?:ws:|wss:)(?:\s|;)/);
});
