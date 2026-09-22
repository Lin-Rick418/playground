import { blackjackRouter } from "./modules/blackjack/router.js";
import { hiloRouter } from "./modules/hilo/router.js";
import cors from "cors";
import express, { type Express } from "express";
import { env } from "./config/env.js";
import {
  createGlobalErrorHandler,
  createRejectedRequestLogger,
  notFoundHandler,
  requestIdMiddleware,
  sendApiError,
  type ApiErrorLogger,
} from "./lib/api-errors.js";
import { readBuildMetadata } from "./lib/build-metadata.js";
import { getServiceHeartbeat } from "./lib/db.js";
import { evaluateReadiness, withTimeout } from "./lib/health.js";
import { logger as serviceLogger } from "./lib/logger.js";
import { authRouter } from "./modules/auth/router.js";
import { plinkoRouter } from "./modules/plinko/router.js";
import { minesRouter } from "./modules/mines/router.js";
import { gameRouter } from "./modules/game/router.js";

const DEPENDENCY_CHECK_TIMEOUT_MS = 1_500;
const WORKER_HEARTBEAT_MAX_AGE_MS = 10_000;

type CreateAppOptions = {
  logger?: ApiErrorLogger;
  registerAdditionalRoutes?: (app: Express) => void;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const logger = options.logger ?? serviceLogger;
  app.disable("x-powered-by");

  // Trust X-Forwarded-For only from the local reverse proxy (nginx) so login
  // rate limiting sees real client IPs without letting remote clients spoof it.
  app.set("trust proxy", "loopback");
  app.use(requestIdMiddleware);
  app.use(createRejectedRequestLogger(logger));
  app.use(cors({ origin: env.corsOrigin, credentials: true, exposedHeaders: ["X-Request-Id"] }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(express.json());

  app.get("/health/live", (_req, res) => {
    res.json({ status: "alive" });
  });

  app.get("/build-metadata", async (req, res) => {
    try {
      return res.json(await readBuildMetadata());
    } catch {
      return sendApiError(req, res, 503, "SERVICE_UNAVAILABLE", "Build metadata unavailable");
    }
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
    } catch {
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
  app.use("/mines", minesRouter);
  app.use("/plinko", plinkoRouter);
  app.use("/hilo", hiloRouter);
  app.use("/blackjack", blackjackRouter);
  options.registerAdditionalRoutes?.(app);

  app.use(notFoundHandler);
  app.use(createGlobalErrorHandler(logger));

  return app;
}
