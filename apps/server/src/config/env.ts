import dotenv from "dotenv";

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
};
