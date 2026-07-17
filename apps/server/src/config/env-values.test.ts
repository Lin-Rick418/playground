import assert from "node:assert/strict";
import test from "node:test";
import { parseCorsOrigin, parseDatabaseSsl, parseHost } from "./env-values.js";

test("database SSL mode is normalized and fails closed", () => {
  assert.equal(parseDatabaseSsl(undefined), "false");
  assert.equal(parseDatabaseSsl(" TRUE "), "true");
  assert.equal(parseDatabaseSsl("no-verify"), "no-verify");
  assert.throws(() => parseDatabaseSsl("yes"), /false, true, no-verify/);
  assert.throws(() => parseDatabaseSsl("1"), /false, true, no-verify/);
});

test("host accepts IP addresses and DNS hostnames only", () => {
  assert.equal(parseHost(undefined), "0.0.0.0");
  assert.equal(parseHost("127.0.0.1"), "127.0.0.1");
  assert.equal(parseHost("::1"), "::1");
  assert.equal(parseHost("api.internal.example"), "api.internal.example");
  assert.throws(() => parseHost(""), /HOST/);
  assert.throws(() => parseHost("https://example.com"), /HOST/);
  assert.throws(() => parseHost("bad host"), /HOST/);
});

test("CORS origin supports false and one exact HTTP origin", () => {
  assert.equal(parseCorsOrigin(undefined, { isProduction: true }), false);
  assert.equal(parseCorsOrigin(undefined, { isProduction: false }), "*");
  assert.equal(parseCorsOrigin("false", { isProduction: true }), false);
  assert.equal(
    parseCorsOrigin("https://app.example.com", { isProduction: true }),
    "https://app.example.com",
  );
  assert.equal(parseCorsOrigin("*", { isProduction: false }), "*");
  assert.throws(() => parseCorsOrigin("*", { isProduction: true }), /development or test/);
  assert.throws(
    () => parseCorsOrigin("https://one.example,https://two.example", { isProduction: true }),
    /one http\(s\) origin/,
  );
  assert.throws(
    () => parseCorsOrigin("https://example.com/path", { isProduction: true }),
    /one http\(s\) origin/,
  );
});
