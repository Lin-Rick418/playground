import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshToken, getRefreshCookieOptions, hashRefreshToken, readCookie } from "./session-token.js";

test("refresh tokens are high-entropy opaque values stored only as hashes", () => {
  const first = createRefreshToken();
  const second = createRefreshToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.match(hashRefreshToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashRefreshToken(first), first);
});

test("cookie parsing selects and safely decodes the refresh cookie", () => {
  assert.equal(readCookie("other=1; baccarat_refresh=abc%2D123", "baccarat_refresh"), "abc-123");
  assert.equal(readCookie("other=1", "baccarat_refresh"), null);
  assert.equal(readCookie("baccarat_refresh=%E0%A4%A", "baccarat_refresh"), null);
});

test("refresh cookies are HttpOnly, strict same-site, and secure in production", () => {
  assert.deepEqual(getRefreshCookieOptions(true), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  });
});
