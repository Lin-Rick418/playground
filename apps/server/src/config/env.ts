import dotenv from "dotenv";
import { requireStrongJwtSecret } from "./jwt-secret.js";

dotenv.config();

// Fail safe: only an explicit development/test NODE_ENV relaxes security
// defaults, so forgetting to set NODE_ENV in a deployment cannot silently
// enable the dev JWT secret, wildcard CORS, or demo account seeding.
const nodeEnv = process.env.NODE_ENV ?? "production";
const isDevelopment = nodeEnv === "development" || nodeEnv === "test";
const isProduction = !isDevelopment;

const jwtSecret = isProduction
  ? requireStrongJwtSecret(process.env.JWT_SECRET)
  : process.env.JWT_SECRET ?? "change-me";

export const env = {
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret,
  // `false` disables cross-origin requests entirely (same-origin deployments
  // behind the nginx proxy need no CORS at all).
  corsOrigin: process.env.CORS_ORIGIN ?? (isProduction ? false : "*"),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/baccarat",
  databaseSsl: process.env.DATABASE_SSL ?? "false",
};
