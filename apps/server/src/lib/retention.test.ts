import assert from "node:assert/strict";
import test from "node:test";
import { runRetentionCleanup } from "./retention.js";

test("retention cleanup deletes bounded batches until each table is current", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const remaining = {
    idempotency_keys: [2, 1],
    auth_sessions: [2, 2, 0],
    login_rate_limits: [1],
  };
  const executor = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const table = (Object.keys(remaining) as (keyof typeof remaining)[])
        .find((candidate) => sql.includes(`FROM ${candidate}`));
      assert.ok(table, `Unexpected cleanup query: ${sql}`);
      return { rowCount: remaining[table].shift() ?? 0, rows: [], command: "DELETE", oid: 0, fields: [] };
    },
  };

  const result = await runRetentionCleanup({
    idempotencyRetentionDays: 7,
    authSessionRetentionDays: 30,
    batchSize: 2,
    now: new Date("2026-07-17T00:00:00.000Z"),
  }, executor);

  assert.deepEqual(result, {
    idempotencyKeys: 3,
    authSessions: 4,
    loginRateLimits: 1,
    total: 8,
    idempotencyCutoff: "2026-07-10T00:00:00.000Z",
    authSessionCutoff: "2026-06-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.000Z",
  });
  assert.ok(calls.every(({ sql }) => sql.includes("LIMIT $2") && sql.includes("FOR UPDATE SKIP LOCKED")));
  assert.ok(calls.every(({ params }) => params[1] === 2));
  assert.ok(calls.filter(({ sql }) => sql.includes("FROM idempotency_keys")).every(({ sql }) => sql.includes("scope NOT LIKE 'blackjack.%'")));
});

test("retention cleanup rejects unsafe policy values before issuing SQL", async () => {
  let queryCount = 0;
  const executor = {
    async query() {
      queryCount += 1;
      return { rowCount: 0, rows: [], command: "DELETE", oid: 0, fields: [] };
    },
  };

  await assert.rejects(
    runRetentionCleanup({ idempotencyRetentionDays: 0, authSessionRetentionDays: 30 }, executor),
    /IDEMPOTENCY_RETENTION_DAYS/,
  );
  assert.equal(queryCount, 0);
});
