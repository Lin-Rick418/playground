import { Pool } from "pg";
import { env } from "../config/env.js";

const sslConfig =
  env.databaseSsl === "true"
    ? { rejectUnauthorized: true }
    : env.databaseSsl === "no-verify"
      ? { rejectUnauthorized: false }
      : undefined;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: sslConfig,
  max: env.databasePoolMax,
  connectionTimeoutMillis: env.databaseConnectionTimeoutMs,
  idleTimeoutMillis: env.databaseIdleTimeoutMs,
  statement_timeout: env.databaseStatementTimeoutMs,
  query_timeout: env.databaseStatementTimeoutMs,
});

pool.on("error", (error: Error) => {
  console.error("Postgres pool error", error);
});
