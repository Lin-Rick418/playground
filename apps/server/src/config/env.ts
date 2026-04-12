import dotenv from "dotenv";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required in production");
}

export const env = {
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  corsOrigin: process.env.CORS_ORIGIN ?? (isProduction ? undefined : "*"),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/baccarat",
  databaseSsl: process.env.DATABASE_SSL === "true",
};
