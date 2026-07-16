import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReadiness, withTimeout } from "./health.js";

const now = Date.parse("2026-01-01T00:00:10.000Z");

test("readiness requires a responsive database and fresh healthy worker", () => {
  const ready = evaluateReadiness({
    databaseOk: true,
    databaseLatencyMs: 4,
    workerHeartbeat: {
      instanceId: "worker-1",
      status: "healthy",
      lastSeenAt: "2026-01-01T00:00:09.000Z",
      lastHealthyAt: "2026-01-01T00:00:09.000Z",
    },
    now,
    maxWorkerAgeMs: 5_000,
  });

  assert.equal(ready.status, "ready");
  assert.equal(ready.checks.roundWorker.status, "up");
});

test("readiness reports stale, degraded, missing, or database-down dependencies", () => {
  const stale = evaluateReadiness({
    databaseOk: true,
    databaseLatencyMs: 4,
    workerHeartbeat: {
      instanceId: "worker-1",
      status: "healthy",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      lastHealthyAt: "2026-01-01T00:00:00.000Z",
    },
    now,
    maxWorkerAgeMs: 5_000,
  });
  const degraded = evaluateReadiness({
    databaseOk: true,
    databaseLatencyMs: 4,
    workerHeartbeat: {
      instanceId: "worker-1",
      status: "degraded",
      lastSeenAt: "2026-01-01T00:00:09.000Z",
      lastHealthyAt: null,
    },
    now,
    maxWorkerAgeMs: 5_000,
  });
  const databaseDown = evaluateReadiness({
    databaseOk: false,
    databaseLatencyMs: 1_500,
    workerHeartbeat: null,
    now,
    maxWorkerAgeMs: 5_000,
  });

  assert.equal(stale.status, "not_ready");
  assert.equal(degraded.status, "not_ready");
  assert.equal(databaseDown.status, "not_ready");
});

test("dependency checks have a bounded timeout", async () => {
  await assert.rejects(withTimeout(new Promise(() => undefined), 5), /timed out/);
});
