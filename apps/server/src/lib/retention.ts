import { pool } from "./db.js";

type RetentionExecutor = {
  query(queryText: string, values: unknown[]): Promise<{ rowCount: number | null }>;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RETENTION_BATCH_SIZE = 500;

const deleteQueries = {
  idempotencyKeys: `
    WITH candidates AS (
      SELECT ctid
      FROM idempotency_keys
      WHERE created_at < $1 AND scope NOT LIKE 'mines.%' AND scope NOT LIKE 'plinko.%' AND scope NOT LIKE 'hilo.%' AND scope NOT LIKE 'blackjack.%'
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM idempotency_keys AS target
    USING candidates
    WHERE target.ctid = candidates.ctid
  `,
  authSessions: `
    WITH candidates AS (
      SELECT ctid
      FROM auth_sessions
      WHERE expires_at < $1 OR revoked_at < $1
      ORDER BY LEAST(expires_at, COALESCE(revoked_at, expires_at)) ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM auth_sessions AS target
    USING candidates
    WHERE target.ctid = candidates.ctid
  `,
  loginRateLimits: `
    WITH candidates AS (
      SELECT ctid
      FROM login_rate_limits
      WHERE expires_at < $1
      ORDER BY expires_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM login_rate_limits AS target
    USING candidates
    WHERE target.ctid = candidates.ctid
  `,
} as const;

function requirePositiveInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

async function deleteInBatches(
  executor: RetentionExecutor,
  query: string,
  cutoff: string,
  batchSize: number,
) {
  let deleted = 0;

  while (true) {
    const result = await executor.query(query, [cutoff, batchSize]);
    const batchDeleted = result.rowCount ?? 0;
    deleted += batchDeleted;

    if (batchDeleted < batchSize) {
      return deleted;
    }
  }
}

export async function runRetentionCleanup(
  options: {
    idempotencyRetentionDays: number;
    authSessionRetentionDays: number;
    batchSize?: number;
    now?: Date;
  },
  executor: RetentionExecutor = pool,
) {
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  requirePositiveInteger("IDEMPOTENCY_RETENTION_DAYS", options.idempotencyRetentionDays);
  requirePositiveInteger("AUTH_SESSION_RETENTION_DAYS", options.authSessionRetentionDays);
  requirePositiveInteger("retention batch size", batchSize);

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Retention cleanup time must be valid");
  }

  const idempotencyCutoff = new Date(
    now.getTime() - options.idempotencyRetentionDays * DAY_MS,
  ).toISOString();
  const authSessionCutoff = new Date(
    now.getTime() - options.authSessionRetentionDays * DAY_MS,
  ).toISOString();
  const nowIso = now.toISOString();

  const [idempotencyKeys, authSessions, loginRateLimits] = await Promise.all([
    deleteInBatches(executor, deleteQueries.idempotencyKeys, idempotencyCutoff, batchSize),
    deleteInBatches(executor, deleteQueries.authSessions, authSessionCutoff, batchSize),
    deleteInBatches(executor, deleteQueries.loginRateLimits, nowIso, batchSize),
  ]);

  return {
    idempotencyKeys,
    authSessions,
    loginRateLimits,
    total: idempotencyKeys + authSessions + loginRateLimits,
    idempotencyCutoff,
    authSessionCutoff,
    completedAt: nowIso,
  };
}
