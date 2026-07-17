import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { ensureSeedData, pool } from "./lib/db.js";
import {
  closeHttpServer,
  installProcessShutdownHandlers,
} from "./lib/graceful-shutdown.js";
import { attachLiveWebSocketServer } from "./lib/live-ws.js";
import { assertDatabaseSchemaCurrent } from "./lib/migration-runner.js";
import { logger } from "./lib/logger.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

await assertDatabaseSchemaCurrent(pool);
await ensureSeedData();
const app = createApp();
const server = createServer(app);
const stopLiveWebSocketServer = await attachLiveWebSocketServer(server);

installProcessShutdownHandlers({
  serviceName: "Baccarat API",
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  shutdown: async () => {
    const httpClosing = closeHttpServer(server);
    const errors: unknown[] = [];

    try {
      await stopLiveWebSocketServer();
    } catch (error) {
      errors.push(error);
    }
    try {
      await httpClosing;
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "API shutdown did not complete cleanly");
    }
  },
});

server.listen(env.port, env.host, () => {
  logger.info({
    event: "http_server_started",
    host: env.host,
    port: env.port,
  }, "Baccarat API listening");
});
