import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { ensureSeedData, pool, recordServiceHeartbeat } from "./lib/db.js";
import { installProcessShutdownHandlers } from "./lib/graceful-shutdown.js";
import { assertDatabaseSchemaCurrent } from "./lib/migration-runner.js";
import { startRoundManager, stopRoundManager } from "./lib/round-manager.js";

await assertDatabaseSchemaCurrent(pool);
await ensureSeedData();
const workerInstanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
let lastHeartbeatAt = 0;
let lastHeartbeatHealthy: boolean | undefined;

installProcessShutdownHandlers({
  serviceName: "Baccarat round worker",
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  shutdown: async (reason) => {
    const errors: unknown[] = [];

    try {
      await stopRoundManager();
    } catch (error) {
      errors.push(error);
    }
    try {
      await recordServiceHeartbeat({
        serviceName: "round-worker",
        instanceId: workerInstanceId,
        healthy: false,
        detail: `Shutting down after ${reason}`,
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Worker shutdown did not complete cleanly");
    }
  },
});

await startRoundManager({
  onTickComplete: async (result) => {
    const now = Date.now();
    if (lastHeartbeatHealthy === result.healthy && now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) {
      return;
    }

    await recordServiceHeartbeat({
      serviceName: "round-worker",
      instanceId: workerInstanceId,
      healthy: result.healthy,
      detail: result.detail,
    });
    lastHeartbeatAt = now;
    lastHeartbeatHealthy = result.healthy;
  },
});

console.log("Round worker started");
