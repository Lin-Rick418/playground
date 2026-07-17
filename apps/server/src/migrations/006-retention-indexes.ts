import type { MigrationDefinition } from "./types.js";

export const retentionIndexesMigration: MigrationDefinition = {
  version: 6,
  name: "retention_indexes",
  up: `
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
      ON idempotency_keys (created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
      ON auth_sessions (expires_at ASC);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked
      ON auth_sessions (revoked_at ASC)
      WHERE revoked_at IS NOT NULL;
  `,
};
