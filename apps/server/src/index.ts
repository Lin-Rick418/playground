import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { ensureSeedData, pool } from "./lib/db.js";
import { attachLiveWebSocketServer } from "./lib/live-ws.js";
import { assertDatabaseSchemaCurrent } from "./lib/migration-runner.js";

await assertDatabaseSchemaCurrent(pool);
await ensureSeedData();
const app = createApp();
const server = createServer(app);
await attachLiveWebSocketServer(server);

server.listen(env.port, env.host, () => {
  console.log(`Server listening on http://${env.host}:${env.port}`);
});
