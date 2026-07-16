import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { attachLiveWebSocketServer } from "./lib/live-ws.js";
import { ensureSeedData, getServiceHeartbeat } from "./lib/db.js";
import { evaluateReadiness, withTimeout } from "./lib/health.js";
import { authRouter } from "./modules/auth/router.js";
import { gameRouter } from "./modules/game/router.js";
import { adminRouter } from "./modules/admin/router.js";

const app = express();

// Trust X-Forwarded-For only from the local reverse proxy (nginx) so login
// rate limiting sees real client IPs without letting remote clients spoof them.
app.set("trust proxy", "loopback");
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

const DEPENDENCY_CHECK_TIMEOUT_MS = 1_500;
const WORKER_HEARTBEAT_MAX_AGE_MS = 10_000;

app.get("/health/live", (_req, res) => {
  res.json({ status: "alive" });
});

async function readinessHandler(_req: express.Request, res: express.Response) {
  const startedAt = performance.now();

  try {
    const workerHeartbeat = await withTimeout(
      getServiceHeartbeat("round-worker"),
      DEPENDENCY_CHECK_TIMEOUT_MS,
    );
    const snapshot = evaluateReadiness({
      databaseOk: true,
      databaseLatencyMs: Math.round(performance.now() - startedAt),
      workerHeartbeat,
      now: Date.now(),
      maxWorkerAgeMs: WORKER_HEARTBEAT_MAX_AGE_MS,
    });
    return res.status(snapshot.status === "ready" ? 200 : 503).json(snapshot);
  } catch (error) {
    console.error("Readiness dependency check failed", error);
    const snapshot = evaluateReadiness({
      databaseOk: false,
      databaseLatencyMs: Math.round(performance.now() - startedAt),
      workerHeartbeat: null,
      now: Date.now(),
      maxWorkerAgeMs: WORKER_HEARTBEAT_MAX_AGE_MS,
    });
    return res.status(503).json(snapshot);
  }
}

app.get("/health", readinessHandler);
app.get("/health/ready", readinessHandler);

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
