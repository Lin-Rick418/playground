import cors from "cors";
import express, { type Express } from "express";
import { env } from "./config/env.js";
import {
  createGlobalErrorHandler,
  createRejectedRequestLogger,
  notFoundHandler,
  requestIdMiddleware,
  type ApiErrorLogger,
} from "./lib/api-errors.js";
import { adminRouter } from "./modules/admin/router.js";
import { authRouter } from "./modules/auth/router.js";
import { gameRouter } from "./modules/game/router.js";

type CreateAppOptions = {
  logger?: ApiErrorLogger;
  registerAdditionalRoutes?: (app: Express) => void;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const logger = options.logger ?? console;

  // Trust X-Forwarded-For only from the local reverse proxy (nginx) so login
  // rate limiting sees real client IPs without letting remote clients spoof it.
  app.set("trust proxy", "loopback");
  app.use(requestIdMiddleware);
  app.use(createRejectedRequestLogger(logger));
  app.use(cors({ origin: env.corsOrigin, exposedHeaders: ["X-Request-Id"] }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/auth", authRouter);
  app.use("/game", gameRouter);
  app.use("/admin", adminRouter);
  options.registerAdditionalRoutes?.(app);

  app.use(notFoundHandler);
  app.use(createGlobalErrorHandler(logger));

  return app;
}
