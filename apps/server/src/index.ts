import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { loadBuildMetadata } from "./lib/build-metadata.js";
import { attachLiveWebSocketServer } from "./lib/live-ws.js";
import { ensureSeedData } from "./lib/db.js";
import { authRouter } from "./modules/auth/router.js";
import { gameRouter } from "./modules/game/router.js";
import { adminRouter } from "./modules/admin/router.js";

const app = express();
const buildMetadata = loadBuildMetadata();

// Trust X-Forwarded-For only from the local reverse proxy (nginx) so login
// rate limiting sees real client IPs without letting remote clients spoof them.
app.set("trust proxy", "loopback");
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/build-metadata", (_req, res) => {
  if (!buildMetadata) {
    res.status(503).json({ message: "Build metadata is unavailable" });
    return;
  }

  res.json(buildMetadata);
});

app.use("/auth", authRouter);
app.use("/game", gameRouter);
app.use("/admin", adminRouter);

const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("Unhandled error", err);
  if (!res.headersSent) {
    res.status(500).json({ message: "Internal server error" });
  }
};
app.use(globalErrorHandler);

await ensureSeedData();
const server = createServer(app);
await attachLiveWebSocketServer(server);

server.listen(env.port, env.host, () => {
  console.log(`Server listening on http://${env.host}:${env.port}`);
});
