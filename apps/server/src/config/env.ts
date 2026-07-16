import dotenv from "dotenv";
import { parseBoundedInteger } from "./env-number.js";

dotenv.config();

// Fail safe: only an explicit development/test NODE_ENV relaxes security
// defaults, so forgetting to set NODE_ENV in a deployment cannot silently
// enable the dev JWT secret, wildcard CORS, or demo account seeding.
const nodeEnv = process.env.NODE_ENV ?? "production";
const isDevelopment = nodeEnv === "development" || nodeEnv === "test";
const isProduction = !isDevelopment;

if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me")) {
  throw new Error("JWT_SECRET must be set to a strong secret outside development");
}

export const env = {
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  // `false` disables cross-origin requests entirely (same-origin deployments
  // behind the nginx proxy need no CORS at all).
  corsOrigin: process.env.CORS_ORIGIN ?? (isProduction ? false : "*"),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/baccarat",
  databaseSsl: process.env.DATABASE_SSL ?? "false",
  databasePoolMax: parseBoundedInteger("DATABASE_POOL_MAX", process.env.DATABASE_POOL_MAX, 20, { min: 1, max: 100 }),
  databaseConnectionTimeoutMs: parseBoundedInteger(
    "DATABASE_CONNECTION_TIMEOUT_MS",
    process.env.DATABASE_CONNECTION_TIMEOUT_MS,
    3_000,
    { min: 100, max: 30_000 },
  ),
  databaseIdleTimeoutMs: parseBoundedInteger(
    "DATABASE_IDLE_TIMEOUT_MS",
    process.env.DATABASE_IDLE_TIMEOUT_MS,
    30_000,
    { min: 1_000, max: 300_000 },
  ),
  databaseStatementTimeoutMs: parseBoundedInteger(
    "DATABASE_STATEMENT_TIMEOUT_MS",
    process.env.DATABASE_STATEMENT_TIMEOUT_MS,
    5_000,
    { min: 500, max: 60_000 },
  ),
};
