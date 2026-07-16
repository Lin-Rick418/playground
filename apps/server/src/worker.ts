import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { ensureSeedData, pool, recordServiceHeartbeat } from "./lib/db.js";
import { assertDatabaseSchemaCurrent } from "./lib/migration-runner.js";
import { startRoundManager } from "./lib/round-manager.js";

await assertDatabaseSchemaCurrent(pool);
await ensureSeedData();
const workerInstanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
let lastHeartbeatAt = 0;
let lastHeartbeatHealthy: boolean | undefined;
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
