import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createServiceLogger } from "./logger.js";

test("structured logger emits correlation fields and redacts secrets", () => {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const testLogger = createServiceLogger({
    service: "logger-test",
    instanceId: "test-instance",
    environment: "production",
    destination,
  });

  testLogger.info({
    event: "round_settled",
    requestId: "request-1",
    roundId: "round-1",
    userId: "user-1",
    password: "password-secret",
    token: "token-secret",
    req: {
      headers: {
        authorization: "Bearer authorization-secret",
        cookie: "refresh=cookie-secret",
      },
      body: { currentPassword: "body-secret" },
    },
  }, "settled");

  const entry = JSON.parse(chunks.join("")) as Record<string, unknown>;
  assert.equal(entry.service, "logger-test");
  assert.equal(entry.instanceId, "test-instance");
  assert.equal(entry.event, "round_settled");
  assert.equal(entry.requestId, "request-1");
  assert.equal(entry.roundId, "round-1");
  assert.equal(entry.userId, "user-1");
  assert.equal(entry.password, "[REDACTED]");
  assert.equal(entry.token, "[REDACTED]");
  assert.deepEqual(entry.req, {
    headers: {
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
    },
    body: "[REDACTED]",
  });
  assert.doesNotMatch(chunks.join(""), /password-secret|token-secret|authorization-secret|cookie-secret|body-secret/);
});

test("test environment is silent without an explicit destination", () => {
  const testLogger = createServiceLogger({ service: "silent-test", environment: "test" });
  assert.equal(testLogger.level, "silent");
});
