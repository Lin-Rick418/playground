import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { coreIntegrityConstraints } from "./database-integrity.js";

const shouldRun = process.env.RUN_DB_INTEGRATION_TESTS === "true";

describe("core PostgreSQL integrity constraints", { skip: !shouldRun }, () => {
  let database: typeof import("./db.js");

  const tableId = "integrity-table";
  const adminId = "integrity-admin";
  const playerId = "integrity-player";
  const roundId = "integrity-round";

  before(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required for the integration test");

    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    assert.match(
      databaseName,
      /^baccarat_integrity_test_[a-z0-9_]+$/,
      "Refusing to run against a database without the baccarat_integrity_test_ prefix",
    );

    database = await import("./db.js");

    const existingTables = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_class
       WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
         AND relkind = 'r'
         AND relname IN ('game_tables', 'users', 'game_rounds', 'bets', 'balance_adjustments')`,
    );
    assert.equal(existingTables.rows[0]?.count, "0", "Integration test database must start empty");

    await database.initializeDatabase();

    const now = new Date("2026-01-01T00:00:00.000Z");
    const closesAt = new Date(now.getTime() + 30_000);

    await database.pool.query(
      `INSERT INTO game_tables (
         id, code, name, display_order, round_duration_ms, round_phase_offset_ms,
         min_bet, max_bet, created_at
       ) VALUES ($1, 'I01', 'Integrity table', 1, 30000, 0, 100, 10000, $2)`,
      [tableId, now],
    );
    await database.pool.query(
      `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
       VALUES ($1, 'integrity_admin', 'hash', 'ADMIN', 0, $3, $3),
              ($2, 'integrity_player', 'hash', 'PLAYER', 1000, $3, $3)`,
      [adminId, playerId, now],
    );
    await database.pool.query(
      `INSERT INTO game_rounds (
         id, table_id, player_total, banker_total, winner, status,
         betting_opens_at, betting_closes_at, created_at
       ) VALUES ($1, $2, 0, 0, 'TIE', 'OPEN', $3, $4, $3)`,
      [roundId, tableId, now, closesAt],
    );
  });

  after(async () => {
    await database?.pool.end();
  });

  it("installs and validates every named CHECK/FK plus supporting indexes", async () => {
    const result = await database.pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conname = ANY($1::text[])
       ORDER BY conname`,
      [coreIntegrityConstraints.map(({ name }) => name)],
    );

    assert.equal(result.rowCount, coreIntegrityConstraints.length);
    assert.ok(result.rows.every(({ convalidated }) => convalidated));

    const indexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'uq_game_tables_display_order',
           'idx_balance_adjustments_admin_id',
           'idx_balance_adjustments_user_id'
         )`,
    );
    assert.equal(indexes.rowCount, 3);
  });

  it("rejects invalid domains, references, amounts, and time windows", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");

    await assert.rejects(
      database.pool.query(
        `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
         VALUES ('invalid-role', 'invalid_role', 'hash', 'SUPERUSER', 0, $1, $1)`,
        [now],
      ),
      /users_role_ck/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO game_tables (
           id, code, name, display_order, round_duration_ms, round_phase_offset_ms,
           min_bet, max_bet, created_at
         ) VALUES ('invalid-limits', 'I02', 'Invalid limits', 2, 30000, 0, 1000, 100, $1)`,
        [now],
      ),
      /game_tables_bet_limits_ck/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO game_rounds (
           id, table_id, player_total, banker_total, winner, status,
           betting_opens_at, betting_closes_at, created_at
         ) VALUES ('orphan-round', 'missing-table', 0, 0, 'TIE', 'OPEN', $1, $2, $1)`,
        [now, new Date(now.getTime() + 30_000)],
      ),
      /game_rounds_table_fk/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO game_rounds (
           id, table_id, player_total, banker_total, winner, status,
           betting_opens_at, betting_closes_at, created_at
         ) VALUES ('invalid-window', $1, 0, 0, 'TIE', 'OPEN', $2, $2, $2)`,
        [tableId, now],
      ),
      /game_rounds_time_window_ck/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at)
         VALUES ('invalid-amount', $1, $2, 'PLAYER', 0, 0, $3)`,
        [playerId, roundId, now],
      ),
      /bets_amounts_ck/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at)
         VALUES ('orphan-bet', 'missing-user', $1, 'PLAYER', 100, 0, $2)`,
        [roundId, now],
      ),
      /bets_user_fk/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO balance_adjustments (id, admin_id, user_id, amount, created_at)
         VALUES ('zero-adjustment', $1, $2, 0, $3)`,
        [adminId, playerId, now],
      ),
      /balance_adjustments_amount_nonzero_ck/,
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO balance_adjustments (id, admin_id, user_id, amount, created_at)
         VALUES ('orphan-adjustment', 'missing-admin', $1, 100, $2)`,
        [playerId, now],
      ),
      /balance_adjustments_admin_fk/,
    );
  });

  it("fails startup on dirty existing data and succeeds after remediation", async () => {
    const now = new Date("2026-01-03T00:00:00.000Z");

    await database.pool.query("ALTER TABLE users DROP CONSTRAINT users_balance_nonnegative_ck");
    await database.pool.query(
      `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
       VALUES ('legacy-negative-balance', 'legacy_negative', 'hash', 'PLAYER', -1, $1, $1)`,
      [now],
    );

    await assert.rejects(database.initializeDatabase(), /users_balance_nonnegative_ck/);

    const rolledBackConstraint = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_constraint
       WHERE conrelid = 'users'::regclass
         AND conname = 'users_balance_nonnegative_ck'`,
    );
    assert.equal(rolledBackConstraint.rows[0]?.count, "0");

    await database.pool.query("DELETE FROM users WHERE id = 'legacy-negative-balance'");
    await database.initializeDatabase();

    const validatedConstraint = await database.pool.query<{ convalidated: boolean }>(
      `SELECT convalidated
       FROM pg_constraint
       WHERE conrelid = 'users'::regclass
         AND conname = 'users_balance_nonnegative_ck'`,
    );
    assert.equal(validatedConstraint.rows[0]?.convalidated, true);
  });
});
