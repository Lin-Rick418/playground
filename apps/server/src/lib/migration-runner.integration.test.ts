import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  assertDatabaseSchemaCurrent,
  getMigrationStatus,
  migrationCatalog,
  runMigrations,
} from "./migration-runner.js";

const shouldRun = process.env.RUN_MIGRATION_INTEGRATION_TESTS === "true";

describe("versioned PostgreSQL migrations", { skip: !shouldRun }, () => {
  let pool: Pool;
  let databaseUrl: string;

  before(async () => {
    databaseUrl = process.env.DATABASE_URL ?? "";
    assert.ok(databaseUrl, "DATABASE_URL is required for the migration integration test");

    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    assert.match(
      databaseName,
      /^baccarat_migration_test_[a-z0-9_]+$/,
      "Refusing to run against a database without the baccarat_migration_test_ prefix",
    );

    pool = new Pool({ connectionString: databaseUrl });
    const existingTables = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_class
       WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
         AND relkind = 'r'`,
    );
    assert.equal(existingTables.rows[0]?.count, "0", "Migration integration database must start empty");
  });

  after(async () => {
    await pool?.end();
  });

  it("fails schema checks without doing DDL before the explicit migration command", async () => {
    await assert.rejects(assertDatabaseSchemaCurrent(pool), /schema is not initialized/);

    const result = await pool.query<{ migration_table: string | null }>(
      "SELECT to_regclass('schema_migrations')::text AS migration_table",
    );
    assert.equal(result.rows[0]?.migration_table, null);

    await pool.query("CREATE TABLE users (id TEXT PRIMARY KEY)");
    await assert.rejects(runMigrations(pool), /Refusing to adopt unmanaged database schema/);
    assert.equal(
      (await pool.query<{ migration_table: string | null }>(
        "SELECT to_regclass('schema_migrations')::text AS migration_table",
      )).rows[0]?.migration_table,
      null,
    );
    await pool.query("DROP TABLE users");
  });

  it("upgrades an empty database in order and is idempotent on rerun", async () => {
    const firstRun = await runMigrations(pool);
    assert.deepEqual(
      firstRun.applied.map(({ version }) => version),
      migrationCatalog.map(({ version }) => version),
    );

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'game_tables'
         AND column_name IN ('round_phase_offset_ms', 'round_schedule_version')
       ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.rows.map(({ column_name }) => column_name),
      ["round_phase_offset_ms", "round_schedule_version"],
    );

    const history = await pool.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    assert.equal(history.rowCount, migrationCatalog.length);
    assert.ok(history.rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));

    await assertDatabaseSchemaCurrent(pool);
    const secondRun = await runMigrations(pool);
    assert.deepEqual(secondRun.applied, []);
  });

  it("rejects checksum drift in an already-applied migration", async () => {
    await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = $1", [
      migrationCatalog[0].version,
    ]);

    await assert.rejects(getMigrationStatus(pool), /checksum drift/);
    await assert.rejects(runMigrations(pool), /checksum drift/);

    await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = $2", [
      migrationCatalog[0].checksum,
      migrationCatalog[0].version,
    ]);
    await assertDatabaseSchemaCurrent(pool);
  });

  it("rejects live schema fingerprint drift even when migration history is current", async () => {
    await pool.query("DROP TRIGGER users_balance_requires_ledger ON users");
    await assert.rejects(assertDatabaseSchemaCurrent(pool), /schema fingerprint drift/);
    await pool.query(`
      CREATE TRIGGER users_balance_requires_ledger
      BEFORE UPDATE OF balance ON users
      FOR EACH ROW EXECUTE FUNCTION reject_unjournaled_user_balance_update()
    `);
    await assertDatabaseSchemaCurrent(pool);
  });

  it("rejects a migration history with a missing earlier version", async () => {
    const removed = migrationCatalog[1];
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", [removed.version]);

    await assert.rejects(getMigrationStatus(pool), /Out-of-order migration history/);

    await pool.query(
      "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
      [removed.version, removed.name, removed.checksum],
    );
    await assertDatabaseSchemaCurrent(pool);
  });

  it("serializes concurrent runners so each migration is recorded exactly once", async () => {
    await pool.query(`
      DROP TABLE IF EXISTS plinko_rounds, mines_rounds, balance_adjustments, bets, game_rounds, users, game_tables CASCADE;
      DROP TABLE IF EXISTS schema_migrations;
    `);
    const secondPool = new Pool({ connectionString: databaseUrl });

    try {
      const results = await Promise.all([runMigrations(pool), runMigrations(secondPool)]);
      const appliedVersions = results
        .flatMap(({ applied }) => applied.map(({ version }) => version))
        .sort((left, right) => left - right);

      assert.deepEqual(
        appliedVersions,
        migrationCatalog.map(({ version }) => version),
      );

      const history = await pool.query<{ count: string; distinct_count: string }>(
        `SELECT count(*)::text AS count, count(DISTINCT version)::text AS distinct_count
         FROM schema_migrations`,
      );
      assert.equal(history.rows[0]?.count, String(migrationCatalog.length));
      assert.equal(history.rows[0]?.distinct_count, String(migrationCatalog.length));
      await assertDatabaseSchemaCurrent(pool);
    } finally {
      await secondPool.end();
    }
  });
});
