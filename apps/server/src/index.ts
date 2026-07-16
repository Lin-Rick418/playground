import { createServer } from "node:http";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { attachLiveWebSocketServer } from "./lib/live-ws.js";
import { ensureSeedData } from "./lib/db.js";

await ensureSeedData();
const app = createApp();
const server = createServer(app);
await attachLiveWebSocketServer(server);

server.listen(env.port, env.host, () => {
  console.log(`Server listening on http://${env.host}:${env.port}`);
});
