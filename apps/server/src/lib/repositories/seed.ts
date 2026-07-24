import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import type { UserRole } from "../../types/domain.js";
import { PASSWORD_BCRYPT_ROUNDS } from "../account-policy.js";
import { assertDatabaseSchemaCurrent } from "../migration-runner.js";
import { pool, queryRow, withTransaction } from "./client.js";
import { applyBalanceMutation, listTables } from "./users.js";
import { migrateTableShoeAtStartup } from "./shoes.js";

const INIT_LOCK_KEY = 48201931;

async function withAdvisoryLock<T>(lockKey: number, handler: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
    return await handler(client);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    } finally {
      client.release();
    }
  }
}

async function seedDemoUser(
  input: { username: string; passwordHash: string; role: UserRole; balance: number },
  executor: PoolClient,
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const inserted = await queryRow(
    executor,
    `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [id, input.username, input.passwordHash, input.role, now, now],
  );

  if (!inserted) {
    return;
  }

  await applyBalanceMutation(
    {
      userId: id,
      delta: input.balance,
      actorType: "SYSTEM",
      source: "INITIAL_FUNDING",
      referenceType: "USER",
      referenceId: id,
      metadata: { seed: "demo" },
    },
    executor,
  );
}

async function seedDemoUsers(executor: PoolClient) {
  const playerPasswordHash = await bcrypt.hash("LuckyShoes!2026", PASSWORD_BCRYPT_ROUNDS);
  await seedDemoUser(
    { username: "player1", passwordHash: playerPasswordHash, role: "PLAYER", balance: 10000 },
    executor,
  );
}

export async function ensureSeedData(options?: { seedDemoUsers?: boolean }) {
  const shouldSeedDemoUsers = options?.seedDemoUsers ?? false;
  const configuredTables = [
    { code: "A01", name: "極速廳 A01", displayOrder: 1, roundDurationMs: 15000, roundPhaseOffsetMs: 0, minBet: 100, maxBet: 10000 },
    { code: "A02", name: "極速廳 A02", displayOrder: 2, roundDurationMs: 15000, roundPhaseOffsetMs: 2000, minBet: 100, maxBet: 10000 },
    { code: "C01", name: "經典廳 C01", displayOrder: 3, roundDurationMs: 30000, roundPhaseOffsetMs: 4000, minBet: 100, maxBet: 10000 },
    { code: "H01", name: "高額廳 H01", displayOrder: 4, roundDurationMs: 30000, roundPhaseOffsetMs: 6000, minBet: 1000, maxBet: 50000 },
  ] as const;

  await assertDatabaseSchemaCurrent(pool);

  await withAdvisoryLock(INIT_LOCK_KEY, async (client) => {
    if (shouldSeedDemoUsers) {
      await withTransaction((tx) => seedDemoUsers(tx));
    }

    const now = new Date().toISOString();

    await withTransaction(async (tx) => {
      for (const table of configuredTables) {
        const existingByOrder = await queryRow(tx, "SELECT id FROM game_tables WHERE display_order = $1", [table.displayOrder]);

        if (existingByOrder) {
          await tx.query("UPDATE game_tables SET code = $1 WHERE id = $2", [`__TMP__${table.displayOrder}`, String(existingByOrder.id)]);
        }
      }

      for (const table of configuredTables) {
        const existingByOrder = await queryRow(tx, "SELECT id FROM game_tables WHERE display_order = $1", [table.displayOrder]);

        if (existingByOrder) {
          await tx.query(
            `UPDATE game_tables
             SET code = $1, name = $2, display_order = $3, round_duration_ms = $4,
                 round_phase_offset_ms = $5, min_bet = $6, max_bet = $7, is_active = TRUE
             WHERE id = $8`,
            [table.code, table.name, table.displayOrder, table.roundDurationMs, table.roundPhaseOffsetMs, table.minBet, table.maxBet, String(existingByOrder.id)],
          );
          continue;
        }

        await tx.query(
          `INSERT INTO game_tables (
             id, code, name, display_order, round_duration_ms, round_phase_offset_ms, min_bet, max_bet, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), table.code, table.name, table.displayOrder, table.roundDurationMs, table.roundPhaseOffsetMs, table.minBet, table.maxBet, now],
        );
      }
    });

    const tables = await listTables(client);
    const fatalMigrations: string[] = [];

    for (const table of tables) {
      const migration = await withTransaction((tx) => migrateTableShoeAtStartup(table.id, tx));
      if (migration.fatalReason) {
        fatalMigrations.push(`${table.id}:${migration.fatalReason}`);
      }
    }

    if (fatalMigrations.length > 0) {
      throw new Error(`Shoe audit startup migration failed closed: ${fatalMigrations.join(", ")}`);
    }
  });
}
