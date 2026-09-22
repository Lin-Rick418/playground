import dotenv from "dotenv";
import { requireStrongJwtSecret } from "./jwt-secret.js";
import { assertValidTimeZone } from "../lib/business-day.js";
import { parseBoundedInteger } from "./env-number.js";
import { parseCorsOrigin, parseDatabaseSsl, parseHost } from "./env-values.js";

// dotenv 17 prints an injection banner to stdout by default, which corrupts
// consumers that parse this process's stdout (e.g. the env-loading tests).
dotenv.config({ quiet: true });

// Fail safe: only an explicit development/test NODE_ENV relaxes security
// defaults, so forgetting to set NODE_ENV in a deployment cannot silently
// enable the dev JWT secret, wildcard CORS, or demo account seeding.
const nodeEnv = process.env.NODE_ENV ?? "production";
const isDevelopment = nodeEnv === "development" || nodeEnv === "test";
const isProduction = !isDevelopment;
const businessTimeZone = process.env.BUSINESS_TIME_ZONE ?? "Asia/Taipei";

assertValidTimeZone(businessTimeZone);

const jwtSecret = isProduction
  ? requireStrongJwtSecret(process.env.JWT_SECRET)
  : (process.env.JWT_SECRET ?? "change-me");

if (
  process.env.MINES_ENABLED !== undefined &&
  !["true", "false"].includes(process.env.MINES_ENABLED)
) {
  throw new Error("MINES_ENABLED must be true or false");
}

if (
  process.env.PLINKO_ENABLED !== undefined &&
  !["true", "false"].includes(process.env.PLINKO_ENABLED)
) {
  throw new Error("PLINKO_ENABLED must be true or false");
}

if (
  process.env.HILO_ENABLED !== undefined &&
  !["true", "false"].includes(process.env.HILO_ENABLED)
) {
  throw new Error("HILO_ENABLED must be true or false");
}

if (
  process.env.BLACKJACK_ENABLED !== undefined &&
  !["true", "false"].includes(process.env.BLACKJACK_ENABLED)
) {
  throw new Error("BLACKJACK_ENABLED must be true or false");
}

export const env = {
  blackjackEnabled: process.env.BLACKJACK_ENABLED === "true",
  plinkoEnabled: process.env.PLINKO_ENABLED !== "false",
  hiloEnabled: process.env.HILO_ENABLED === "true",
  minesEnabled: process.env.MINES_ENABLED !== "false",
  isProduction,
  port: parseBoundedInteger("PORT", process.env.PORT, 4000, { min: 1, max: 65_535 }),
  host: parseHost(process.env.HOST),
  jwtSecret,
  // `false` disables cross-origin requests entirely (same-origin deployments
  // behind the nginx proxy need no CORS at all).
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN, { isProduction }),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/baccarat",
  databaseSsl: parseDatabaseSsl(process.env.DATABASE_SSL),
  businessTimeZone,
  databasePoolMax: parseBoundedInteger("DATABASE_POOL_MAX", process.env.DATABASE_POOL_MAX, 20, {
    min: 1,
    max: 100,
  }),
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
  idempotencyRetentionDays: parseBoundedInteger(
    "IDEMPOTENCY_RETENTION_DAYS",
    process.env.IDEMPOTENCY_RETENTION_DAYS,
    7,
    { min: 1, max: 3_650 },
  ),
  authSessionRetentionDays: parseBoundedInteger(
    "AUTH_SESSION_RETENTION_DAYS",
    process.env.AUTH_SESSION_RETENTION_DAYS,
    30,
    { min: 1, max: 3_650 },
  ),
};
