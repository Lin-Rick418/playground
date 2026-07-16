import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { migrationDefinitions, type MigrationDefinition } from "../migrations/index.js";

const MIGRATION_LOCK_KEY = 48201930;
const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

type MigrationExecutor = Pick<Pool | PoolClient, "query">;

type AppliedMigrationRow = QueryResultRow & {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date | string;
};

export type Migration = MigrationDefinition & { checksum: string };

export function validateMigrationDefinitions(definitions: readonly MigrationDefinition[]) {
  let previousVersion = 0;

  for (const migration of definitions) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Migration version must be a positive safe integer; received ${migration.version}`);
    }

    if (migration.version <= previousVersion) {
      throw new Error(
        `Migration definitions must be strictly ordered; version ${migration.version} follows ${previousVersion}`,
      );
    }

    if (!/^[a-z][a-z0-9_]*$/.test(migration.name)) {
      throw new Error(`Migration ${migration.version} has an invalid name: ${JSON.stringify(migration.name)}`);
    }

    if (!migration.up.trim()) {
      throw new Error(`Migration ${migration.version}_${migration.name} has empty SQL`);
    }

    previousVersion = migration.version;
  }
}

export function buildMigrationCatalog(definitions: readonly MigrationDefinition[]): readonly Migration[] {
  validateMigrationDefinitions(definitions);

  return definitions.map((migration) => ({
    ...migration,
    checksum: createHash("sha256")
      .update(`${migration.version}\0${migration.name}\0${migration.up.trim()}`)
      .digest("hex"),
  }));
}

export const migrationCatalog = buildMigrationCatalog(migrationDefinitions);

function isPostgresError(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readAppliedMigrations(executor: MigrationExecutor) {
  try {
    const result = await executor.query<AppliedMigrationRow>(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
    );

    return result.rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    }));
  } catch (error) {
    if (isPostgresError(error, "42P01")) {
      return null;
    }

    throw error;
  }
}

function validateAppliedHistory(
  applied: NonNullable<Awaited<ReturnType<typeof readAppliedMigrations>>>,
  catalog: readonly Migration[],
) {
  for (let index = 0; index < applied.length; index += 1) {
    const actual = applied[index];
    const expected = catalog[index];

    if (!expected) {
      throw new Error(
        `Database has unknown migration ${actual.version}_${actual.name}; deployed code is older than the schema`,
      );
    }

    if (actual.version !== expected.version) {
      const knownVersion = catalog.some(({ version }) => version === actual.version);
      throw new Error(
        knownVersion
          ? `Out-of-order migration history: expected version ${expected.version} before ${actual.version}`
          : `Database has unknown migration version ${actual.version}; expected ${expected.version}`,
      );
    }

    if (actual.name !== expected.name) {
      throw new Error(
        `Migration ${actual.version} name drift: database has ${actual.name}, code has ${expected.name}`,
      );
    }

    if (actual.checksum !== expected.checksum) {
      throw new Error(
        `Migration ${actual.version}_${actual.name} checksum drift; never edit an applied migration`,
      );
    }
  }
}

export async function getMigrationStatus(
  executor: MigrationExecutor,
  catalog: readonly Migration[] = migrationCatalog,
) {
  const applied = await readAppliedMigrations(executor);

  if (!applied) {
    return {
      initialized: false,
      currentVersion: 0,
      latestVersion: catalog.at(-1)?.version ?? 0,
      applied: [],
      pending: [...catalog],
      isCurrent: false,
    };
  }

  validateAppliedHistory(applied, catalog);
  const pending = catalog.slice(applied.length);

  return {
    initialized: true,
    currentVersion: applied.at(-1)?.version ?? 0,
    latestVersion: catalog.at(-1)?.version ?? 0,
    applied,
    pending,
    isCurrent: pending.length === 0,
  };
}

export async function assertDatabaseSchemaCurrent(
  executor: MigrationExecutor,
  catalog: readonly Migration[] = migrationCatalog,
) {
  const status = await getMigrationStatus(executor, catalog);

  if (!status.initialized) {
    throw new Error(
      "Database schema is not initialized; run npm run db:migrate before starting services or data commands",
    );
  }

  if (!status.isCurrent) {
    const next = status.pending[0];
    throw new Error(
      `Database schema is at version ${status.currentVersion}, expected ${status.latestVersion}; ` +
        `run npm run db:migrate before starting services or data commands (next: ${next.version}_${next.name})`,
    );
  }

  return status;
}

export async function runMigrations(
  databasePool: Pool,
  definitions: readonly MigrationDefinition[] = migrationDefinitions,
) {
  const catalog = buildMigrationCatalog(definitions);
  const client = await databasePool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(SCHEMA_MIGRATIONS_TABLE_SQL);
    const status = await getMigrationStatus(client, catalog);
    const applied: Migration[] = [];

    for (const migration of status.pending) {
      await client.query("BEGIN");

      try {
        await client.query(migration.up);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        applied.push(migration);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.version}_${migration.name} failed`, { cause: error });
      }
    }

    return {
      applied,
      currentVersion: catalog.at(-1)?.version ?? 0,
      latestVersion: catalog.at(-1)?.version ?? 0,
    };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
