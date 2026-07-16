import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintIdempotencyRequest, parseIdempotencyKey } from "./idempotency.js";

test("accepts bounded opaque idempotency keys", () => {
  assert.equal(parseIdempotencyKey("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(parseIdempotencyKey("request_1234"), "request_1234");
});

test("rejects missing, ambiguous, short, and unsafe idempotency keys", () => {
  assert.equal(parseIdempotencyKey(undefined), null);
  assert.equal(parseIdempotencyKey(["request_1234", "request_5678"]), null);
  assert.equal(parseIdempotencyKey("short"), null);
  assert.equal(parseIdempotencyKey("request key with spaces"), null);
});

test("fingerprints identical request payloads consistently", () => {
  const payload = { tableId: "table-1", bets: [{ betType: "PLAYER", amount: 100 }] };

  assert.equal(fingerprintIdempotencyRequest(payload), fingerprintIdempotencyRequest(payload));
  assert.notEqual(
    fingerprintIdempotencyRequest(payload),
    fingerprintIdempotencyRequest({ tableId: "table-1", bets: [{ betType: "PLAYER", amount: 200 }] }),
  );
});
