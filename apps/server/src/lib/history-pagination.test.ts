import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  parseHistoryPageQuery,
} from "./history-pagination.js";

test("history cursor round-trips stable ordering fields", () => {
  const cursor = encodeHistoryCursor({
    settledAt: "2026-07-17T01:02:03.000Z",
    createdAt: "2026-07-17T01:00:00.000Z",
    roundId: "round-1",
  });

  assert.deepEqual(decodeHistoryCursor(cursor), {
    version: 1,
    settledAt: "2026-07-17T01:02:03.000Z",
    createdAt: "2026-07-17T01:00:00.000Z",
    roundId: "round-1",
  });
  assert.deepEqual(parseHistoryPageQuery({ limit: "50", cursor }), {
    success: true,
    data: { limit: 50, cursor: decodeHistoryCursor(cursor) },
  });
});

test("history query rejects ambiguous limits, unknown fields, and malformed cursors", () => {
  assert.deepEqual(parseHistoryPageQuery({}), {
    success: true,
    data: { limit: 20, cursor: null },
  });
  assert.deepEqual(parseHistoryPageQuery({ limit: "0" }), { success: false });
  assert.deepEqual(parseHistoryPageQuery({ limit: "51" }), { success: false });
  assert.deepEqual(parseHistoryPageQuery({ limit: ["20"] }), { success: false });
  assert.deepEqual(parseHistoryPageQuery({ extra: "value" }), { success: false });
  assert.deepEqual(parseHistoryPageQuery({ cursor: "bm90LWpzb24" }), { success: false });
});
