import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WEBSOCKET_CONNECTIONS,
  MAX_WEBSOCKET_CONNECTIONS_PER_IP,
  MAX_WEBSOCKET_CONNECTIONS_PER_USER,
  consumeRateLimit,
  isConnectionLimitExceeded,
  isWebSocketPayloadAllowed,
  parseWebSocketClientMessage,
  pruneRateWindows,
  type RateWindow,
} from "./live-ws-policy.js";

test("rate limit rejects only events inside the active window", () => {
  const window: RateWindow = { timestamps: [] };

  assert.equal(consumeRateLimit(window, 1_000, 2, 1_000), true);
  assert.equal(consumeRateLimit(window, 1_500, 2, 1_000), true);
  assert.equal(consumeRateLimit(window, 1_999, 2, 1_000), false);
  assert.equal(consumeRateLimit(window, 2_001, 2, 1_000), true);
});

test("stale rate limit buckets are pruned", () => {
  const windows = new Map<string, RateWindow>([
    ["stale", { timestamps: [1_000] }],
    ["active", { timestamps: [2_500] }],
  ]);

  pruneRateWindows(windows, 3_000, 1_000);

  assert.equal(windows.has("stale"), false);
  assert.equal(windows.has("active"), true);
});

test("connection limits protect global, IP, and user capacity", () => {
  assert.equal(isConnectionLimitExceeded({ total: MAX_WEBSOCKET_CONNECTIONS, forIp: 0 }), true);
  assert.equal(isConnectionLimitExceeded({ total: 0, forIp: MAX_WEBSOCKET_CONNECTIONS_PER_IP }), true);
  assert.equal(
    isConnectionLimitExceeded({ total: 0, forIp: 0, forUser: MAX_WEBSOCKET_CONNECTIONS_PER_USER }),
    true,
  );
  assert.equal(isConnectionLimitExceeded({ total: 1, forIp: 1, forUser: 1 }), false);
});

test("payload and message parsing reject oversized or malformed input", () => {
  assert.equal(isWebSocketPayloadAllowed(8 * 1024), true);
  assert.equal(isWebSocketPayloadAllowed(8 * 1024 + 1), false);
  assert.deepEqual(parseWebSocketClientMessage('{"type":"subscribe_lobby"}'), { type: "subscribe_lobby" });
  assert.deepEqual(parseWebSocketClientMessage('{"type":"subscribe_table","tableId":"table-1"}'), {
    type: "subscribe_table",
    tableId: "table-1",
  });
  assert.equal(parseWebSocketClientMessage("not-json"), null);
  assert.equal(parseWebSocketClientMessage('{"type":"subscribe_table","tableId":""}'), null);
});
