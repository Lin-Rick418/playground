import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "../../config/env.js";
import { logger, toLogError } from "../logger.js";

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
  logger.error({ event: "postgres_pool_error", err: toLogError(error) }, "Postgres pool error");
});

export type DbExecutor = Pool | PoolClient;
export type DbRow = Record<string, unknown>;

export function toIsoString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

export function parseJsonValue<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

export function isPoolClient(executor: DbExecutor): executor is PoolClient {
  return "release" in executor;
}

export async function queryRows<T extends QueryResultRow = QueryResultRow>(
  executor: DbExecutor,
  text: string,
  values: unknown[] = [],
) {
  const result = await executor.query<T>(text, values);
  return result.rows;
}

export async function queryRow<T extends QueryResultRow = QueryResultRow>(
  executor: DbExecutor,
  text: string,
  values: unknown[] = [],
) {
  const rows = await queryRows<T>(executor, text, values);
  return rows[0] ?? null;
}

export function requireRecord<T>(record: T | null, entity: string): T {
  if (!record) {
    throw new Error(`${entity} disappeared during a database write`);
  }

  return record;
}

export function assertPasswordHash(passwordHash: string) {
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new TypeError("Password must be stored as a bcrypt hash");
  }
}

export async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
