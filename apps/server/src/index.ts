import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { attachLiveWebSocketServer } from "./lib/live-ws.js";
import { ensureSeedData } from "./lib/db.js";
import { authRouter } from "./modules/auth/router.js";
import { gameRouter } from "./modules/game/router.js";
import { adminRouter } from "./modules/admin/router.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRouter);
app.use("/game", gameRouter);
app.use("/admin", adminRouter);

await ensureSeedData();
const server = createServer(app);
await attachLiveWebSocketServer(server);

server.listen(env.port, env.host, () => {
  console.log(`Server listening on http://${env.host}:${env.port}`);
});
