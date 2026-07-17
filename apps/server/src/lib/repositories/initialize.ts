import { ACTIVE_ROUND_UNIQUE_INDEX } from "../active-round-invariant.js";
import { queryRows, withTransaction } from "./client.js";
import { applyLegacySchema } from "./legacy-schema.js";

export async function initializeDatabase() {
  throw new Error("Runtime schema initialization is disabled; run npm run db:migrate explicitly");

  await applyLegacySchema();

  await withTransaction(async (client) => {
    await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
    await client.query(
      `INSERT INTO financial_ledger_entries (
        id, user_id, actor_type, actor_id, source, reference_type, reference_id,
        delta, balance_before, balance_after, metadata, created_at
      )
      SELECT
        'legacy-opening:' || users.id,
        users.id,
        'SYSTEM',
        NULL,
        'LEGACY_OPENING_BALANCE',
        'USER',
        users.id,
        users.balance,
        0,
        users.balance,
        '{"backfilled":true}'::jsonb,
        NOW()
      FROM users
      WHERE NOT EXISTS (
        SELECT 1 FROM financial_ledger_entries
        WHERE financial_ledger_entries.user_id = users.id
      )
      ON CONFLICT (user_id, source, reference_type, reference_id) DO NOTHING`,
    );
  });

  await withTransaction(async (client) => {
    await client.query("LOCK TABLE game_rounds IN SHARE ROW EXCLUSIVE MODE");
    const duplicateActiveRounds = await queryRows<{
      table_id: string;
      round_ids: string[];
      active_count: string;
    }>(
      client,
      `SELECT table_id,
              ARRAY_AGG(id ORDER BY created_at DESC, id DESC) AS round_ids,
              COUNT(*) AS active_count
       FROM game_rounds
       WHERE status IN ('OPEN', 'LOCKED')
       GROUP BY table_id
       HAVING COUNT(*) > 1
       ORDER BY table_id`,
    );

    if (duplicateActiveRounds.length > 0) {
      const duplicateSummary = duplicateActiveRounds
        .map((row) => `${row.table_id} (${row.active_count}: ${row.round_ids.join(", ")})`)
        .join("; ");
      const migrationError = new Error(
        `Cannot enforce one active round per table; resolve existing OPEN/LOCKED duplicates first: ${duplicateSummary}`,
      );
      Object.assign(migrationError, { code: "ACTIVE_ROUND_INVARIANT_MIGRATION_REQUIRED" });
      throw migrationError;
    }

    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_ROUND_UNIQUE_INDEX}
       ON game_rounds (table_id)
       WHERE status IN ('OPEN', 'LOCKED')`,
    );
  });
}
