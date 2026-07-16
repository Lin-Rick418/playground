import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "backfills legacy balances and enforces append-only ledger reconciliation",
  { skip: !testDatabaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = testDatabaseUrl;

    const setupPool = new Pool({ connectionString: testDatabaseUrl });
    const { migrationDefinitions } = await import("../migrations/index.js");
    const { runMigrations } = await import("./migration-runner.js");
    await runMigrations(setupPool, migrationDefinitions.slice(0, 4));
    await setupPool.query(`
      INSERT INTO users (
        id, username, password_hash, role, is_active, balance, created_at, updated_at
      ) VALUES (
        'legacy-user', 'legacy', 'hash', 'PLAYER', TRUE, 275, NOW(), NOW()
      );
    `);
    await setupPool.end();

    const {
      applyBalanceMutation,
      createPlayer,
      ensureSeedData,
      pool,
      reconcileAllUserBalances,
      reconcileUserBalance,
      withTransaction,
    } = await import("./db.js");

    try {
      await runMigrations(pool);
      await ensureSeedData({ seedDemoUsers: true });

      const legacyLedger = await pool.query(
        `SELECT source, balance_before, delta, balance_after
         FROM financial_ledger_entries
         WHERE user_id = 'legacy-user'`,
      );
      assert.deepEqual(legacyLedger.rows, [
        {
          source: "LEGACY_OPENING_BALANCE",
          balance_before: 0,
          delta: 275,
          balance_after: 275,
        },
      ]);

      const seededFunding = await pool.query(
        `SELECT ledger.source, ledger.actor_type, ledger.delta
         FROM financial_ledger_entries ledger
         JOIN users ON users.id = ledger.user_id
         WHERE users.username = 'player1'`,
      );
      assert.deepEqual(seededFunding.rows, [
        { source: "INITIAL_FUNDING", actor_type: "SYSTEM", delta: 10000 },
      ]);

      const player = await createPlayer({
        username: "ledger_player",
        passwordHash: `$2b$12$${"a".repeat(53)}`,
        balance: 1000,
        actorId: "admin-actor",
      });

      await withTransaction(async (client) => {
        await applyBalanceMutation(
          {
            userId: player.id,
            delta: -200,
            actorType: "PLAYER",
            actorId: player.id,
            source: "BET_DEBIT",
            referenceType: "BET",
            referenceId: "bet-1",
          },
          client,
        );
        await applyBalanceMutation(
          {
            userId: player.id,
            delta: 150,
            actorType: "SYSTEM",
            source: "SETTLEMENT_CREDIT",
            referenceType: "ROUND",
            referenceId: "round-1",
          },
          client,
        );
        await applyBalanceMutation(
          {
            userId: player.id,
            delta: 50,
            actorType: "ADMIN",
            actorId: "admin-actor",
            source: "ADMIN_ADJUSTMENT",
            referenceType: "BALANCE_ADJUSTMENT",
            referenceId: "adjustment-1",
          },
          client,
        );
      });

      await assert.rejects(
        withTransaction((client) =>
          applyBalanceMutation(
            {
              userId: player.id,
              delta: -1,
              actorType: "PLAYER",
              actorId: player.id,
              source: "BET_DEBIT",
              referenceType: "BET",
              referenceId: "bet-1",
            },
            client,
          ),
        ),
        (error: unknown) => (error as { code?: string }).code === "23505",
      );

      assert.deepEqual(await reconcileUserBalance(player.id), {
        userId: player.id,
        currentBalance: 1000,
        ledgerBalance: 1000,
        totalDelta: 1000,
        entryCount: 4,
        chainConsistent: true,
        isReconciled: true,
      });
      assert.equal(
        (await reconcileAllUserBalances()).every((result) => result.isReconciled),
        true,
      );

      await assert.rejects(
        pool.query(
          "UPDATE financial_ledger_entries SET metadata = '{}'::jsonb WHERE user_id = $1",
          [player.id],
        ),
        (error: unknown) => (error as { code?: string }).code === "55000",
      );
      await assert.rejects(
        pool.query("UPDATE users SET balance = balance + 100 WHERE id = $1", [player.id]),
        (error: unknown) => (error as { code?: string }).code === "55000",
      );
      await assert.rejects(
        pool.query("TRUNCATE financial_ledger_entries"),
        (error: unknown) => (error as { code?: string }).code === "55000",
      );
    } finally {
      await pool.end();
    }
  },
);
