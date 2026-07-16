import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const databaseSsl = process.env.DATABASE_SSL ?? "false";
const sslConfig =
  databaseSsl === "true"
    ? { rejectUnauthorized: true }
    : databaseSsl === "no-verify"
      ? { rejectUnauthorized: false }
      : undefined;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/baccarat",
  ssl: sslConfig,
});

pool.on("error", (error: Error) => {
  console.error("Postgres pool error", error);
});
