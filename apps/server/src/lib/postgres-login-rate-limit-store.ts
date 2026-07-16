import type { Pool } from "pg";
import type {
  LoginRateLimitIncrement,
  LoginRateLimitKey,
  LoginRateLimitScope,
  LoginRateLimitState,
  LoginRateLimitStore,
} from "./login-rate-limit.js";

type QueryExecutor = Pick<Pool, "query">;

type RateLimitRow = {
  scope: LoginRateLimitScope;
  key_hash: string;
  failures: number | string;
  expires_at: Date | string;
};

function mapState(row: RateLimitRow): LoginRateLimitState {
  return {
    scope: row.scope,
    keyHash: row.key_hash,
    failures: Number(row.failures),
    expiresAtMs: new Date(row.expires_at).getTime(),
  };
}

function createKeyValues(keys: LoginRateLimitKey[], firstParameter: number) {
  return keys
    .map(
      (_, index) =>
        `($${firstParameter + index * 2}::text, $${firstParameter + index * 2 + 1}::text)`,
    )
    .join(", ");
}

export class PostgresLoginRateLimitStore implements LoginRateLimitStore {
  constructor(private readonly executor: QueryExecutor) {}

  async get(keys: LoginRateLimitKey[], nowMs: number) {
    if (keys.length === 0) return [];

    const values = [
      new Date(nowMs).toISOString(),
      ...keys.flatMap((key) => [key.scope, key.keyHash]),
    ];
    const result = await this.executor.query<RateLimitRow>(
      `SELECT scope, key_hash, failures, expires_at
       FROM login_rate_limits
       WHERE expires_at > $1::timestamptz
         AND (scope, key_hash) IN (VALUES ${createKeyValues(keys, 2)})`,
      values,
    );

    return result.rows.map(mapState);
  }

  async increment(increments: LoginRateLimitIncrement[], nowMs: number) {
    if (increments.length === 0) return [];

    const attemptedAt = new Date(nowMs).toISOString();
    const values = increments.flatMap((increment) => [
      increment.scope,
      increment.keyHash,
      attemptedAt,
      new Date(nowMs + increment.windowMs).toISOString(),
    ]);
    const inputValues = increments
      .map(
        (_, index) =>
          `($${index * 4 + 1}::text, $${index * 4 + 2}::text, ` +
          `$${index * 4 + 3}::timestamptz, $${index * 4 + 4}::timestamptz)`,
      )
      .join(", ");
    const result = await this.executor.query<RateLimitRow>(
      `INSERT INTO login_rate_limits AS existing (
         scope, key_hash, failures, window_started_at, expires_at, updated_at
       )
       SELECT scope, key_hash, 1, attempted_at, new_expires_at, attempted_at
       FROM (VALUES ${inputValues}) AS input(scope, key_hash, attempted_at, new_expires_at)
       ON CONFLICT (scope, key_hash) DO UPDATE SET
         failures = CASE
           WHEN existing.expires_at <= EXCLUDED.window_started_at THEN 1
           ELSE existing.failures + 1
         END,
         window_started_at = CASE
           WHEN existing.expires_at <= EXCLUDED.window_started_at
             THEN EXCLUDED.window_started_at
           ELSE existing.window_started_at
         END,
         expires_at = CASE
           WHEN existing.expires_at <= EXCLUDED.window_started_at THEN EXCLUDED.expires_at
           ELSE existing.expires_at
         END,
         updated_at = EXCLUDED.updated_at
       RETURNING scope, key_hash, failures, expires_at`,
      values,
    );

    return result.rows.map(mapState);
  }

  async clear(keys: LoginRateLimitKey[]) {
    if (keys.length === 0) return;

    await this.executor.query(
      `DELETE FROM login_rate_limits
       WHERE (scope, key_hash) IN (VALUES ${createKeyValues(keys, 1)})`,
      keys.flatMap((key) => [key.scope, key.keyHash]),
    );
  }

  async pruneExpired(nowMs: number, limit: number) {
    const result = await this.executor.query(
      `WITH expired AS (
         SELECT scope, key_hash
         FROM login_rate_limits
         WHERE expires_at <= $1::timestamptz
         ORDER BY expires_at ASC
         LIMIT $2
       )
       DELETE FROM login_rate_limits AS existing
       USING expired
       WHERE existing.scope = expired.scope
         AND existing.key_hash = expired.key_hash`,
      [new Date(nowMs).toISOString(), limit],
    );

    return result.rowCount ?? 0;
  }
}
