import { type DbExecutor, type DbRow, pool, queryRow, queryRows, requireRecord, toIsoString } from "./client.js";

export type AuthSession = {
  id: string;
  userId: string;
  expiresAt: string;
};

function mapAuthSession(row: DbRow): AuthSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    expiresAt: toIsoString(row.expires_at),
  };
}

export async function createAuthSession(
  input: { id: string; userId: string; refreshTokenHash: string; expiresAt: string },
  executor: DbExecutor = pool,
) {
  const now = new Date().toISOString();
  const row = await queryRow(
    executor,
    `INSERT INTO auth_sessions (
      id, user_id, refresh_token_hash, expires_at, revoked_at, created_at, last_used_at
    ) VALUES ($1, $2, $3, $4, NULL, $5, $5)
    RETURNING id, user_id, expires_at`,
    [input.id, input.userId, input.refreshTokenHash, input.expiresAt, now],
  );

  return mapAuthSession(requireRecord(row, "Created auth session"));
}

export async function rotateAuthSession(
  input: { currentRefreshTokenHash: string; nextRefreshTokenHash: string },
  executor: DbExecutor = pool,
) {
  const now = new Date().toISOString();
  const row = await queryRow(
    executor,
    `UPDATE auth_sessions
     SET refresh_token_hash = $1, last_used_at = $2
     WHERE refresh_token_hash = $3 AND revoked_at IS NULL AND expires_at > $2
     RETURNING id, user_id, expires_at`,
    [input.nextRefreshTokenHash, now, input.currentRefreshTokenHash],
  );

  return row ? mapAuthSession(row) : null;
}

export async function revokeAuthSessionByRefreshTokenHash(
  refreshTokenHash: string,
  executor: DbExecutor = pool,
) {
  const revokedAt = new Date().toISOString();
  const row = await queryRow(
    executor,
    `UPDATE auth_sessions
     SET revoked_at = $1
     WHERE refresh_token_hash = $2 AND revoked_at IS NULL
     RETURNING id, user_id, expires_at`,
    [revokedAt, refreshTokenHash],
  );

  return row ? mapAuthSession(row) : null;
}

export async function revokeAuthSessionsByUserId(userId: string, executor: DbExecutor = pool) {
  const revokedAt = new Date().toISOString();
  const rows = await queryRows(
    executor,
    `UPDATE auth_sessions
     SET revoked_at = $1
     WHERE user_id = $2 AND revoked_at IS NULL
     RETURNING id, user_id, expires_at`,
    [revokedAt, userId],
  );
  return rows.map((row: DbRow) => mapAuthSession(row));
}

export async function isAuthSessionActive(sessionId: string, executor: DbExecutor = pool) {
  const row = await queryRow(
    executor,
    "SELECT 1 FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()",
    [sessionId],
  );
  return Boolean(row);
}
