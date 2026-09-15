#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# Check PWA-specific routing and header inheritance without requiring TLS files.
node --input-type=module - "$ROOT/deploy/nginx/baccarat.conf" <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const config = readFileSync(process.argv[2], 'utf8');
for (const [route, mime] of [['= /sw.js', 'application/javascript'], ['= /manifest.webmanifest', 'application/manifest+json'], ['^~ /pwa/', 'text/html'], ['^~ /icons/', 'image/png']]) {
  const start = config.indexOf(`location ${route} {`);
  assert.notEqual(start, -1, `${route} route missing`);
  let depth = 1;
  let end = config.indexOf('{', start) + 1;
  const contentStart = end;
  while (depth && end < config.length) {
    if (config[end] === '{') depth++;
    if (config[end] === '}') depth--;
    end++;
  }
  const block = config.slice(contentStart, end - 1);
  assert.ok(block.includes('expires -1;'), `${route} must revalidate`);
  assert.ok(block.includes('try_files $uri =404;'), `${route} must not serve SPA fallback`);
  assert.ok(block.includes(mime), `${route} MIME missing`);
  assert.ok(!block.includes('add_header'), `${route} must inherit CSP and HSTS`);
}
console.log('PWA routing and header checks passed');
JS
