import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  BetType,
  GameRoundRecord,
  GameTableRecord,
  RoundStatus,
  RoundWinner,
  UserRecord,
  UserRole,
} from "../types/domain.js";
import { ACTIVE_ROUND_UNIQUE_INDEX } from "./active-round-invariant.js";
import { type Card, type TableShoeState } from "./baccarat.js";
import { chunkItems } from "./batch.js";
import { coreDatabaseIntegritySql } from "./database-integrity.js";
import { assertValidRoundWindow } from "./round-schedule.js";
import {
  calculateBalanceTransition,
  type FinancialLedgerActorType,
  type FinancialLedgerReferenceType,
  type FinancialLedgerSource,
} from "./financial-ledger.js";
import { betTypes } from "../types/domain.js";
import {
  assertAccountBalance,
  getMaximumPayout,
  MAX_ACCOUNT_BALANCE,
  MONEY_DENOMINATION,
  normalizeUsername,
  PASSWORD_BCRYPT_ROUNDS,
  usernameSchema,
} from "./account-policy.js";
import {
  createShoeCommitment,
  createShoeFromSeed,
  generateShoeSeed,
  SHOE_AUDIT_VERSION,
  SHOE_DEAL_ALGORITHM,
  SHOE_DECK_COUNT,
  SHOE_SHUFFLE_ALGORITHM,
  type AuditedRoundResult,
  type ShoeAuditBundle,
  type ShoeCommitmentRecord,
  type ShoeDealAuditRecord,
} from "./shoe-audit.js";
import { pool } from "./database.js";
import { assertDatabaseSchemaCurrent } from "./migration-runner.js";
import { encodeHistoryCursor, type HistoryCursor } from "./history-pagination.js";

export { pool } from "./database.js";

type DbExecutor = Pool | PoolClient;
type DbRow = Record<string, unknown>;
type PersistedTableShoe = TableShoeState & { shoeId: string };

function toIsoString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function parseJsonValue<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

function isPoolClient(executor: DbExecutor): executor is PoolClient {
  return "release" in executor;
}

async function queryRows<T extends QueryResultRow = QueryResultRow>(
  executor: DbExecutor,
  text: string,
  values: unknown[] = [],
) {
  const result = await executor.query<T>(text, values);
  return result.rows;
}

async function queryRow<T extends QueryResultRow = QueryResultRow>(
  executor: DbExecutor,
  text: string,
  values: unknown[] = [],
) {
  const rows = await queryRows<T>(executor, text, values);
  return rows[0] ?? null;
}

function requireRecord<T>(record: T | null, entity: string): T {
  if (!record) {
    throw new Error(`${entity} disappeared during a database write`);
  }

  return record;
}

function assertPasswordHash(passwordHash: string) {
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new TypeError("Password must be stored as a bcrypt hash");
  }
}

export async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase() {
  throw new Error("Runtime schema initialization is disabled; run npm run db:migrate explicitly");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_tables (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      round_duration_ms INTEGER NOT NULL DEFAULT 30000,
      round_phase_offset_ms INTEGER NOT NULL DEFAULT 0,
      round_schedule_version INTEGER NOT NULL DEFAULT 0,
      min_bet INTEGER NOT NULL DEFAULT 100,
      max_bet INTEGER NOT NULL DEFAULT 10000,
      current_shoe_id TEXT NOT NULL DEFAULT '',
      shoe_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_rounds (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      shoe_id TEXT NOT NULL DEFAULT '',
      player_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
      banker_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
      player_total INTEGER NOT NULL,
      banker_total INTEGER NOT NULL,
      winner TEXT NOT NULL,
      player_pair BOOLEAN NOT NULL DEFAULT FALSE,
      banker_pair BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'SETTLED',
      cancellation_reason TEXT,
      betting_opens_at TIMESTAMPTZ NOT NULL,
      betting_closes_at TIMESTAMPTZ NOT NULL,
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      bet_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      payout INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS balance_adjustments (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_rate_limits (
      scope TEXT NOT NULL CHECK (scope IN ('ACCOUNT_IP', 'ACCOUNT', 'IP')),
      key_hash TEXT NOT NULL,
      failures INTEGER NOT NULL CHECK (failures > 0),
      window_started_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope, key_hash)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      actor_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER,
      response_json JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (actor_id, scope, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS financial_ledger_entries (
      id TEXT PRIMARY KEY,
      entry_sequence BIGSERIAL NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      source TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_before INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT financial_ledger_balance_transition
        CHECK (balance_before >= 0 AND balance_after >= 0 AND balance_after = balance_before + delta),
      CONSTRAINT financial_ledger_actor
        CHECK (
          (actor_type = 'SYSTEM' AND actor_id IS NULL) OR
          (actor_type IN ('ADMIN', 'PLAYER') AND actor_id IS NOT NULL)
        ),
      CONSTRAINT financial_ledger_source_reference
        CHECK (
          (source = 'LEGACY_OPENING_BALANCE' AND actor_type = 'SYSTEM' AND reference_type = 'USER') OR
          (source = 'INITIAL_FUNDING' AND actor_type IN ('SYSTEM', 'ADMIN') AND reference_type = 'USER') OR
          (source = 'ADMIN_ADJUSTMENT' AND actor_type = 'ADMIN' AND reference_type = 'BALANCE_ADJUSTMENT') OR
          (source = 'BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BET') OR
          (source = 'SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'ROUND')
        ),
      CONSTRAINT financial_ledger_source_reference_unique
        UNIQUE (user_id, source, reference_type, reference_id)
    );

    CREATE TABLE IF NOT EXISTS service_heartbeats (
      service_name TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      last_seen_at TIMESTAMPTZ NOT NULL,
      last_healthy_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_commitments (
      shoe_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES game_tables(id),
      audit_version INTEGER NOT NULL,
      shuffle_algorithm TEXT NOT NULL,
      deal_algorithm TEXT NOT NULL,
      deck_count INTEGER NOT NULL CHECK (deck_count > 0),
      commitment TEXT NOT NULL CHECK (commitment ~ '^[0-9a-f]{64}$'),
      cut_card_remaining INTEGER NOT NULL CHECK (cut_card_remaining >= 0),
      committed_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_secrets (
      shoe_id TEXT PRIMARY KEY REFERENCES shoe_commitments(shoe_id),
      seed_hex TEXT NOT NULL CHECK (seed_hex ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_reveals (
      shoe_id TEXT PRIMARY KEY REFERENCES shoe_commitments(shoe_id),
      seed_hex TEXT NOT NULL CHECK (seed_hex ~ '^[0-9a-f]{64}$'),
      reveal_reason TEXT NOT NULL,
      revealed_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_deal_audits (
      round_id TEXT PRIMARY KEY,
      shoe_id TEXT NOT NULL REFERENCES shoe_commitments(shoe_id),
      deal_index INTEGER NOT NULL CHECK (deal_index >= 0),
      dealt_cards JSONB NOT NULL,
      round_result JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL,
      UNIQUE (shoe_id, deal_index)
    );

    CREATE INDEX IF NOT EXISTS idx_shoe_commitments_table_created
      ON shoe_commitments (table_id, committed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shoe_deal_audits_shoe_index
      ON shoe_deal_audits (shoe_id, deal_index ASC);

    CREATE OR REPLACE FUNCTION reject_shoe_audit_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'shoe audit records are append-only';
    END;
    $$;

    CREATE OR REPLACE FUNCTION reject_deal_after_shoe_reveal()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM 1 FROM shoe_commitments WHERE shoe_id = NEW.shoe_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'shoe commitment does not exist';
      END IF;
      IF EXISTS (SELECT 1 FROM shoe_reveals WHERE shoe_id = NEW.shoe_id) THEN
        RAISE EXCEPTION 'cannot append deals after shoe reveal';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION serialize_shoe_reveal()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM 1 FROM shoe_commitments WHERE shoe_id = NEW.shoe_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'shoe commitment does not exist';
      END IF;
      RETURN NEW;
    END;
    $$;

    DO $$
    DECLARE
      audit_table TEXT;
      trigger_name TEXT;
    BEGIN
      FOREACH audit_table IN ARRAY ARRAY['shoe_commitments', 'shoe_reveals', 'shoe_deal_audits']
      LOOP
        trigger_name := 'prevent_mutation_' || audit_table;
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgname = trigger_name
            AND tgrelid = audit_table::regclass
            AND NOT tgisinternal
        ) THEN
          EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_shoe_audit_mutation()',
            trigger_name,
            audit_table
          );
        END IF;
      END LOOP;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'prevent_update_shoe_secrets'
          AND tgrelid = 'shoe_secrets'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER prevent_update_shoe_secrets
          BEFORE UPDATE ON shoe_secrets
          FOR EACH STATEMENT EXECUTE FUNCTION reject_shoe_audit_mutation();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'prevent_deal_after_shoe_reveal'
          AND tgrelid = 'shoe_deal_audits'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER prevent_deal_after_shoe_reveal
          BEFORE INSERT ON shoe_deal_audits
          FOR EACH ROW EXECUTE FUNCTION reject_deal_after_shoe_reveal();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'serialize_shoe_reveal_insert'
          AND tgrelid = 'shoe_reveals'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER serialize_shoe_reveal_insert
          BEFORE INSERT ON shoe_reveals
          FOR EACH ROW EXECUTE FUNCTION serialize_shoe_reveal();
      END IF;
    END;
    $$;

    ALTER TABLE game_tables
      ADD COLUMN IF NOT EXISTS round_phase_offset_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE game_tables
      ADD COLUMN IF NOT EXISTS round_schedule_version INTEGER NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized
      ON users ((lower(username)));

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_balance_policy') THEN
        ALTER TABLE users ADD CONSTRAINT users_balance_policy
          CHECK (balance BETWEEN 0 AND ${MAX_ACCOUNT_BALANCE}) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_policy') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_policy CHECK (role IN ('ADMIN', 'PLAYER')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_tables_bet_policy') THEN
        ALTER TABLE game_tables ADD CONSTRAINT game_tables_bet_policy CHECK (
          min_bet > 0 AND min_bet <= max_bet AND
          min_bet % ${MONEY_DENOMINATION} = 0 AND max_bet % ${MONEY_DENOMINATION} = 0 AND
          max_bet <= ${MAX_ACCOUNT_BALANCE}
        ) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bets_amount_policy') THEN
        ALTER TABLE bets ADD CONSTRAINT bets_amount_policy CHECK (
          amount > 0 AND amount <= ${MAX_ACCOUNT_BALANCE} AND amount % ${MONEY_DENOMINATION} = 0 AND
          payout BETWEEN 0 AND ${MAX_ACCOUNT_BALANCE} AND
          bet_type IN ('PLAYER', 'BANKER', 'TIE', 'PLAYER_PAIR', 'BANKER_PAIR')
        ) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balance_adjustments_amount_policy') THEN
        ALTER TABLE balance_adjustments ADD CONSTRAINT balance_adjustments_amount_policy CHECK (
          amount <> 0 AND amount BETWEEN -${MAX_ACCOUNT_BALANCE} AND ${MAX_ACCOUNT_BALANCE} AND
          amount % ${MONEY_DENOMINATION} = 0
        ) NOT VALID;
      END IF;
    END $$;

    ${coreDatabaseIntegritySql}

    ALTER TABLE game_rounds
      ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

    CREATE INDEX IF NOT EXISTS idx_game_rounds_active
      ON game_rounds (table_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_game_rounds_settled
      ON game_rounds (table_id, status, settled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_game_rounds_shoe_settled
      ON game_rounds (table_id, shoe_id, status, settled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_user_round_created
      ON bets (user_id, round_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_bets_round_created
      ON bets (round_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_balance_adjustments_created
      ON balance_adjustments (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_rate_limits_expires
      ON login_rate_limits (expires_at ASC);
    CREATE INDEX IF NOT EXISTS idx_financial_ledger_user_sequence
      ON financial_ledger_entries (user_id, entry_sequence ASC);

    CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation()
    RETURNS trigger AS $financial_ledger_guard$
    BEGIN
      RAISE EXCEPTION 'financial_ledger_entries is append-only'
        USING ERRCODE = '55000';
    END;
    $financial_ledger_guard$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION reject_unjournaled_user_balance_update()
    RETURNS trigger AS $user_balance_guard$
    BEGIN
      IF NEW.balance IS DISTINCT FROM OLD.balance
         AND current_setting('baccarat.ledger_mutation', TRUE) IS DISTINCT FROM 'allowed' THEN
        RAISE EXCEPTION 'user balance updates must be journaled'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $user_balance_guard$ LANGUAGE plpgsql;

    DO $financial_ledger_triggers$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'financial_ledger_no_update_delete'
          AND tgrelid = 'financial_ledger_entries'::regclass
      ) THEN
        EXECUTE 'CREATE TRIGGER financial_ledger_no_update_delete
          BEFORE UPDATE OR DELETE ON financial_ledger_entries
          FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation()';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'financial_ledger_no_truncate'
          AND tgrelid = 'financial_ledger_entries'::regclass
      ) THEN
        EXECUTE 'CREATE TRIGGER financial_ledger_no_truncate
          BEFORE TRUNCATE ON financial_ledger_entries
          FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_ledger_mutation()';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'users_balance_requires_ledger'
          AND tgrelid = 'users'::regclass
      ) THEN
        EXECUTE 'CREATE TRIGGER users_balance_requires_ledger
          BEFORE UPDATE OF balance ON users
          FOR EACH ROW EXECUTE FUNCTION reject_unjournaled_user_balance_update()';
      END IF;
    END;
    $financial_ledger_triggers$;

    CREATE OR REPLACE VIEW financial_balance_reconciliation AS
    WITH ordered_entries AS (
      SELECT
        user_id,
        entry_sequence,
        delta,
        balance_before,
        balance_after,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY entry_sequence) AS entry_number,
        LAG(balance_after) OVER (PARTITION BY user_id ORDER BY entry_sequence) AS previous_balance_after
      FROM financial_ledger_entries
    ),
    ledger_rollup AS (
      SELECT
        user_id,
        COUNT(*)::bigint AS entry_count,
        SUM(delta)::bigint AS total_delta,
        (ARRAY_AGG(balance_after ORDER BY entry_sequence DESC))[1] AS ledger_balance,
        BOOL_AND(
          balance_after = balance_before + delta AND
          CASE
            WHEN entry_number = 1 THEN balance_before = 0
            ELSE balance_before = previous_balance_after
          END
        ) AS chain_consistent
      FROM ordered_entries
      GROUP BY user_id
    )
    SELECT
      users.id AS user_id,
      users.balance AS current_balance,
      COALESCE(ledger_rollup.ledger_balance, 0) AS ledger_balance,
      COALESCE(ledger_rollup.total_delta, 0)::bigint AS total_delta,
      COALESCE(ledger_rollup.entry_count, 0)::bigint AS entry_count,
      COALESCE(ledger_rollup.chain_consistent, FALSE) AS chain_consistent,
      (
        COALESCE(ledger_rollup.entry_count, 0) > 0 AND
        COALESCE(ledger_rollup.chain_consistent, FALSE) AND
        users.balance = COALESCE(ledger_rollup.ledger_balance, 0) AND
        COALESCE(ledger_rollup.total_delta, 0) = COALESCE(ledger_rollup.ledger_balance, 0)
      ) AS is_reconciled
    FROM users
    LEFT JOIN ledger_rollup ON ledger_rollup.user_id = users.id;
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
      ON auth_sessions (user_id, expires_at DESC)
      WHERE revoked_at IS NULL;
  `);

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

function mapUser(row: DbRow): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: String(row.role) as UserRole,
    isActive: row.is_active as boolean,
    balance: Number(row.balance),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapTable(row: DbRow): GameTableRecord {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    displayOrder: Number(row.display_order),
    roundDurationMs: Number(row.round_duration_ms),
    roundPhaseOffsetMs: Number(row.round_phase_offset_ms),
    roundScheduleVersion: Number(row.round_schedule_version),
    minBet: Number(row.min_bet),
    maxBet: Number(row.max_bet),
    createdAt: toIsoString(row.created_at),
  };
}

function mapRound(row: DbRow): GameRoundRecord {
  return {
    id: String(row.id),
    tableId: String(row.table_id),
    shoeId: String(row.shoe_id),
    playerCards: parseJsonValue<Card[]>(row.player_cards),
    bankerCards: parseJsonValue<Card[]>(row.banker_cards),
    playerTotal: Number(row.player_total),
    bankerTotal: Number(row.banker_total),
    winner: String(row.winner) as RoundWinner,
    playerPair: row.player_pair as boolean,
    bankerPair: row.banker_pair as boolean,
    status: String(row.status) as RoundStatus,
    cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : null,
    bettingOpensAt: toIsoString(row.betting_opens_at),
    bettingClosesAt: toIsoString(row.betting_closes_at),
    settledAt: row.settled_at ? toIsoString(row.settled_at) : null,
    createdAt: toIsoString(row.created_at),
  };
}

export async function findUserByUsername(username: string, executor: DbExecutor = pool) {
  const row = await queryRow(executor, "SELECT * FROM users WHERE lower(username) = $1", [normalizeUsername(username)]);
  return row ? mapUser(row) : null;
}

export async function listTables(executor: DbExecutor = pool) {
  const rows = await queryRows(executor, "SELECT * FROM game_tables ORDER BY display_order ASC, created_at ASC");
  return rows.map((row: DbRow) => mapTable(row));
}

export async function findTableById(tableId: string, executor: DbExecutor = pool) {
  const row = await queryRow(executor, "SELECT * FROM game_tables WHERE id = $1", [tableId]);
  return row ? mapTable(row) : null;
}

export async function findUserById(
  id: string,
  executor: DbExecutor = pool,
  options?: { forUpdate?: boolean },
) {
  const suffix = options?.forUpdate && isPoolClient(executor) ? " FOR UPDATE" : "";
  const row = await queryRow(executor, `SELECT * FROM users WHERE id = $1${suffix}`, [id]);
  return row ? mapUser(row) : null;
}

async function setUserBalance(userId: string, balance: number, executor: PoolClient) {
  const now = new Date().toISOString();
  await executor.query("SELECT set_config('baccarat.ledger_mutation', 'allowed', TRUE)");
  await executor.query("UPDATE users SET balance = $1, updated_at = $2 WHERE id = $3", [balance, now, userId]);
  await executor.query("SELECT set_config('baccarat.ledger_mutation', 'blocked', TRUE)");
  return requireRecord(await findUserById(userId, executor), "Updated user");
}

export async function applyBalanceMutation(
  input: {
    userId: string;
    delta: number;
    actorType: FinancialLedgerActorType;
    actorId?: string;
    source: FinancialLedgerSource;
    referenceType: FinancialLedgerReferenceType;
    referenceId: string;
    metadata?: Record<string, unknown>;
  },
  executor: PoolClient,
) {
  const user = await findUserById(input.userId, executor, { forUpdate: true });

  if (!user) {
    throw new Error("User not found during balance mutation");
  }

  const transition = calculateBalanceTransition(user.balance, input.delta);
  assertAccountBalance(transition.balanceAfter);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await executor.query(
    `INSERT INTO financial_ledger_entries (
      id, user_id, actor_type, actor_id, source, reference_type, reference_id,
      delta, balance_before, balance_after, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      id,
      user.id,
      input.actorType,
      input.actorId ?? null,
      input.source,
      input.referenceType,
      input.referenceId,
      transition.delta,
      transition.balanceBefore,
      transition.balanceAfter,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    ],
  );

  const updatedUser = await setUserBalance(user.id, transition.balanceAfter, executor);
  return {
    user: updatedUser,
    ledgerEntry: {
      id,
      userId: user.id,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      source: input.source,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      ...transition,
      metadata: input.metadata ?? {},
      createdAt,
    },
  };
}

function mapBalanceReconciliation(row: DbRow) {
  return {
    userId: String(row.user_id),
    currentBalance: Number(row.current_balance),
    ledgerBalance: Number(row.ledger_balance),
    totalDelta: Number(row.total_delta),
    entryCount: Number(row.entry_count),
    chainConsistent: row.chain_consistent as boolean,
    isReconciled: row.is_reconciled as boolean,
  };
}

export async function reconcileUserBalance(userId: string, executor: DbExecutor = pool) {
  const row = await queryRow(
    executor,
    "SELECT * FROM financial_balance_reconciliation WHERE user_id = $1",
    [userId],
  );
  return row ? mapBalanceReconciliation(row) : null;
}

export async function reconcileAllUserBalances(executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    "SELECT * FROM financial_balance_reconciliation ORDER BY user_id",
  );
  return rows.map((row: DbRow) => mapBalanceReconciliation(row));
}

export async function createPlayer(
  input: { username: string; passwordHash: string; balance: number; actorId: string },
): Promise<UserRecord> {
  const username = usernameSchema.parse(input.username);
  assertPasswordHash(input.passwordHash);
  assertAccountBalance(input.balance);
  if (input.balance % MONEY_DENOMINATION !== 0) {
    throw new RangeError("Initial balance violates account policy");
  }

  return withTransaction(async (client) => {
    const id = randomUUID();
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO users (id, username, password_hash, role, is_active, balance, created_at, updated_at)
       VALUES ($1, $2, $3, 'PLAYER', TRUE, 0, $4, $5)`,
      [id, username, input.passwordHash, now, now],
    );

    const { user } = await applyBalanceMutation(
      {
        userId: id,
        delta: input.balance,
        actorType: "ADMIN",
        actorId: input.actorId,
        source: "INITIAL_FUNDING",
        referenceType: "USER",
        referenceId: id,
      },
      client,
    );

    return user;
  });
}

export async function setUserActive(userId: string, isActive: boolean, executor: DbExecutor = pool) {
  const now = new Date().toISOString();
  await executor.query(
    `UPDATE users SET
       is_active = $1,
       updated_at = $2
     WHERE id = $3`,
    [isActive, now, userId],
  );
  return requireRecord(await findUserById(userId, executor), "Updated user");
}

export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
  executor: DbExecutor = pool,
) {
  assertPasswordHash(passwordHash);
  const now = new Date().toISOString();
  await executor.query(
    "UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3",
    [passwordHash, now, userId],
  );
  return requireRecord(await findUserById(userId, executor), "Updated user");
}

export type IdempotencyClaim<T> =
  | { kind: "claimed" }
  | { kind: "conflict" }
  | { kind: "replay"; statusCode: number; response: T };

export async function claimIdempotencyKey<T>(
  input: { actorId: string; scope: string; key: string; requestHash: string },
  executor: DbExecutor,
): Promise<IdempotencyClaim<T>> {
  const createdAt = new Date().toISOString();
  const inserted = await queryRow(
    executor,
    `INSERT INTO idempotency_keys (actor_id, scope, idempotency_key, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (actor_id, scope, idempotency_key) DO NOTHING
     RETURNING actor_id`,
    [input.actorId, input.scope, input.key, input.requestHash, createdAt],
  );

  if (inserted) {
    return { kind: "claimed" };
  }

  const existing = await queryRow(
    executor,
    `SELECT request_hash, status_code, response_json
     FROM idempotency_keys
     WHERE actor_id = $1 AND scope = $2 AND idempotency_key = $3
     FOR UPDATE`,
    [input.actorId, input.scope, input.key],
  );

  if (!existing) {
    throw new Error("Idempotency key disappeared during conflict resolution");
  }

  if (String(existing.request_hash) !== input.requestHash) {
    return { kind: "conflict" };
  }

  if (existing.status_code === null || existing.status_code === undefined || existing.response_json === null) {
    throw new Error("Idempotency key was committed without a response");
  }

  return {
    kind: "replay",
    statusCode: Number(existing.status_code),
    response: parseJsonValue<T>(existing.response_json),
  };
}

export async function completeIdempotencyKey(
  input: {
    actorId: string;
    scope: string;
    key: string;
    requestHash: string;
    statusCode: number;
    response: unknown;
  },
  executor: DbExecutor,
) {
  const completedAt = new Date().toISOString();
  const result = await executor.query(
    `UPDATE idempotency_keys
     SET status_code = $1, response_json = $2::jsonb, completed_at = $3
     WHERE actor_id = $4 AND scope = $5 AND idempotency_key = $6
       AND request_hash = $7 AND response_json IS NULL`,
    [
      input.statusCode,
      JSON.stringify(input.response),
      completedAt,
      input.actorId,
      input.scope,
      input.key,
      input.requestHash,
    ],
  );

  if (result.rowCount !== 1) {
    throw new Error("Idempotency response could not be recorded");
  }
}

export type ServiceHeartbeat = {
  serviceName: string;
  instanceId: string;
  status: "healthy" | "degraded";
  detail: string | null;
  lastSeenAt: string;
  lastHealthyAt: string | null;
};

export async function recordServiceHeartbeat(
  input: {
    serviceName: string;
    instanceId: string;
    healthy: boolean;
    detail?: string;
  },
  executor: DbExecutor = pool,
) {
  const now = new Date().toISOString();
  await executor.query(
    `INSERT INTO service_heartbeats (
      service_name, instance_id, status, detail, last_seen_at, last_healthy_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (service_name) DO UPDATE SET
      instance_id = EXCLUDED.instance_id,
      status = EXCLUDED.status,
      detail = EXCLUDED.detail,
      last_seen_at = EXCLUDED.last_seen_at,
      last_healthy_at = CASE
        WHEN EXCLUDED.status = 'healthy' THEN EXCLUDED.last_seen_at
        ELSE service_heartbeats.last_healthy_at
      END`,
    [
      input.serviceName,
      input.instanceId,
      input.healthy ? "healthy" : "degraded",
      input.detail?.slice(0, 500) ?? null,
      now,
      input.healthy ? now : null,
    ],
  );
}

export async function getServiceHeartbeat(serviceName: string, executor: DbExecutor = pool) {
  const row = await queryRow(executor, "SELECT * FROM service_heartbeats WHERE service_name = $1", [serviceName]);
  if (!row) {
    return null;
  }

  return {
    serviceName: String(row.service_name),
    instanceId: String(row.instance_id),
    status: String(row.status) as ServiceHeartbeat["status"],
    detail: row.detail === null ? null : String(row.detail),
    lastSeenAt: toIsoString(row.last_seen_at),
    lastHealthyAt: row.last_healthy_at ? toIsoString(row.last_healthy_at) : null,
  } satisfies ServiceHeartbeat;
}

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

export async function setTableRoundScheduleVersion(
  tableId: string,
  version: number,
  executor: DbExecutor = pool,
) {
  await executor.query("UPDATE game_tables SET round_schedule_version = $1 WHERE id = $2", [version, tableId]);
}

export async function createRound(
  input: {
    tableId: string;
    shoeId: string;
    status: RoundStatus;
    bettingOpensAt: string;
    bettingClosesAt: string;
  },
  executor: DbExecutor = pool,
) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  assertValidRoundWindow(input, createdAt);

  await executor.query(
    `INSERT INTO game_rounds (
      id, table_id, player_cards, banker_cards, player_total, banker_total, winner, status,
      shoe_id, player_pair, banker_pair, betting_opens_at, betting_closes_at, settled_at, created_at
    ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      input.tableId,
      JSON.stringify([]),
      JSON.stringify([]),
      0,
      0,
      "TIE",
      input.status,
      input.shoeId,
      false,
      false,
      input.bettingOpensAt,
      input.bettingClosesAt,
      null,
      createdAt,
    ],
  );

  return requireRecord(await findRoundById(id, executor), "Created round");
}

export async function createBet(
  input: {
    userId: string;
    roundId: string;
    betType: BetType;
    amount: number;
  },
  executor: DbExecutor = pool,
) {
  if (
    !betTypes.includes(input.betType) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    input.amount > MAX_ACCOUNT_BALANCE ||
    input.amount % MONEY_DENOMINATION !== 0
  ) {
    throw new RangeError("Bet amount violates money policy");
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await executor.query(
    "INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, input.userId, input.roundId, input.betType, input.amount, 0, createdAt],
  );

  return { id, ...input, payout: 0, createdAt };
}

export async function listUserHistory(
  userId: string,
  options: { limit?: number; cursor?: HistoryCursor | null } = {},
  executor: DbExecutor = pool,
) {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("History page limit must be between 1 and 50");
  }
  const cursor = options.cursor ?? null;
  const rows = await queryRows(
    executor,
    `SELECT
      g.id AS round_id,
      g.table_id,
      g.winner,
      g.player_cards,
      g.banker_cards,
      g.player_total,
      g.banker_total,
      g.player_pair,
      g.banker_pair,
      g.settled_at,
      g.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'id', b.id,
            'betType', b.bet_type,
            'amount', b.amount,
            'payout', b.payout,
            'createdAt', b.created_at
          ) ORDER BY b.created_at ASC
        ),
        '[]'::json
      ) AS bets
    FROM game_rounds g
    JOIN bets b ON b.round_id = g.id AND b.user_id = $1
    WHERE g.status = 'SETTLED'
      AND g.settled_at IS NOT NULL
      AND (
        $2::timestamptz IS NULL OR
        (g.settled_at, g.created_at, g.id) < ($2::timestamptz, $3::timestamptz, $4::text)
      )
    GROUP BY g.id
    ORDER BY g.settled_at DESC, g.created_at DESC, g.id DESC
    LIMIT $5`,
    [
      userId,
      cursor?.settledAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.roundId ?? null,
      limit + 1,
    ],
  );

  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row: DbRow) => {
    const bets = parseJsonValue<{ id: string; betType: BetType; amount: number; payout: number; createdAt: string }[]>(row.bets);
    const totalAmount = bets.reduce((sum: number, bet) => sum + bet.amount, 0);
    const totalPayout = bets.reduce((sum: number, bet) => sum + bet.payout, 0);

    return {
      id: String(row.round_id),
      createdAt: toIsoString(row.settled_at),
      totalAmount,
      totalPayout,
      bets,
      round: {
        id: String(row.round_id),
        tableId: String(row.table_id),
        winner: String(row.winner) as RoundWinner,
        playerCards: parseJsonValue<Card[]>(row.player_cards),
        bankerCards: parseJsonValue<Card[]>(row.banker_cards),
        playerTotal: Number(row.player_total),
        bankerTotal: Number(row.banker_total),
        playerPair: row.player_pair as boolean,
        bankerPair: row.banker_pair as boolean,
      },
    };
  });

  const lastRow = pageRows.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && lastRow
      ? encodeHistoryCursor({
          settledAt: toIsoString(lastRow.settled_at),
          createdAt: toIsoString(lastRow.created_at),
          roundId: String(lastRow.round_id),
        })
      : null,
  };
}

export async function getUserDailyProfit(
  userId: string,
  window: { start: Date; end: Date },
  executor: DbExecutor = pool,
) {
  const row = await queryRow(
    executor,
    `SELECT
       COALESCE(SUM(b.amount), 0) AS total_bet,
       COALESCE(SUM(b.payout), 0) AS total_payout
     FROM bets b
     JOIN game_rounds g ON g.id = b.round_id
     WHERE b.user_id = $1
       AND g.status = 'SETTLED'
       AND g.settled_at >= $2
       AND g.settled_at < $3`,
    [userId, window.start.toISOString(), window.end.toISOString()],
  );
  const totalBet = Number(row?.total_bet ?? 0);
  const totalPayout = Number(row?.total_payout ?? 0);

  return {
    totalBet,
    totalPayout,
    netProfit: totalPayout - totalBet,
  };
}

export async function listRoundBets(roundId: string, executor: DbExecutor = pool) {
  const rows = await queryRows(executor, "SELECT * FROM bets WHERE round_id = $1 ORDER BY created_at ASC", [roundId]);

  return rows.map((row: DbRow) => ({
    id: String(row.id),
    userId: String(row.user_id),
    roundId: String(row.round_id),
    betType: String(row.bet_type) as BetType,
    amount: Number(row.amount),
    payout: Number(row.payout),
    createdAt: toIsoString(row.created_at),
  }));
}

export async function listRoundBetsDetailed(roundId: string, executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    `SELECT
      b.id,
      b.user_id,
      u.username,
      b.round_id,
      b.bet_type,
      b.amount,
      b.payout,
      b.created_at
    FROM bets b
    JOIN users u ON u.id = b.user_id
    WHERE b.round_id = $1
    ORDER BY b.created_at ASC`,
    [roundId],
  );

  return rows.map((row: DbRow) => ({
    id: String(row.id),
    userId: String(row.user_id),
    username: String(row.username),
    roundId: String(row.round_id),
    betType: String(row.bet_type) as BetType,
    amount: Number(row.amount),
    payout: Number(row.payout),
    createdAt: toIsoString(row.created_at),
  }));
}

export async function listUserRoundBets(userId: string, roundId: string, executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    "SELECT id, bet_type, amount, payout, created_at FROM bets WHERE user_id = $1 AND round_id = $2 ORDER BY created_at ASC",
    [userId, roundId],
  );

  return rows.map((row: DbRow) => ({
    id: String(row.id),
    betType: String(row.bet_type) as BetType,
    amount: Number(row.amount),
    payout: Number(row.payout),
    createdAt: toIsoString(row.created_at),
  }));
}

export async function updateBetPayouts(
  payouts: { betId: string; payout: number }[],
  executor: DbExecutor = pool,
) {
  if (payouts.length === 0) {
    return;
  }

  if (payouts.some(({ payout }) => !Number.isSafeInteger(payout) || payout < 0 || payout > MAX_ACCOUNT_BALANCE)) {
    throw new RangeError("Bet payout violates money policy");
  }

  for (const batch of chunkItems(payouts)) {
    const values: unknown[] = [];
    const rows = batch.map((item, index) => {
      const offset = index * 2;
      values.push(item.betId, item.payout);
      return `($${offset + 1}::text, $${offset + 2}::integer)`;
    });
    await executor.query(
      `UPDATE bets AS bet
       SET payout = value.payout
       FROM (VALUES ${rows.join(", ")}) AS value(id, payout)
       WHERE bet.id = value.id`,
      values,
    );
  }
}

export async function getUserUnsettledMaximumPayout(userId: string, executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    `SELECT b.bet_type, b.amount
     FROM bets b
     JOIN game_rounds g ON g.id = b.round_id
     WHERE b.user_id = $1 AND g.status IN ('OPEN', 'LOCKED')`,
    [userId],
  );
  const maximumPayout = rows.reduce((sum: number, row: DbRow) => {
    const betType = String(row.bet_type) as BetType;
    const amount = Number(row.amount);
    if (!betTypes.includes(betType)) {
      throw new RangeError("Unsettled bet type violates domain policy");
    }
    return sum + getMaximumPayout(betType, amount);
  }, 0);
  if (!Number.isSafeInteger(maximumPayout)) {
    throw new RangeError("Unsettled payout exposure is outside the supported range");
  }
  return maximumPayout;
}

export async function findRoundById(
  id: string,
  executor: DbExecutor = pool,
  options?: { forUpdate?: boolean },
) {
  const suffix = options?.forUpdate && isPoolClient(executor) ? " FOR UPDATE" : "";
  const row = await queryRow(executor, `SELECT * FROM game_rounds WHERE id = $1${suffix}`, [id]);
  return row ? mapRound(row) : null;
}

export async function getActiveRound(
  tableId: string,
  executor: DbExecutor = pool,
  options?: { forUpdate?: boolean },
) {
  const suffix = options?.forUpdate && isPoolClient(executor) ? " FOR UPDATE" : "";
  const row = await queryRow(
    executor,
    `SELECT * FROM game_rounds WHERE table_id = $1 AND status IN ('OPEN', 'LOCKED') ORDER BY created_at DESC LIMIT 1${suffix}`,
    [tableId],
  );

  return row ? mapRound(row) : null;
}

export async function listRecentSettledRounds(tableId: string, limit = 8, executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    "SELECT * FROM game_rounds WHERE table_id = $1 AND status = 'SETTLED' ORDER BY settled_at DESC LIMIT $2",
    [tableId, limit],
  );
  return rows.map((row: DbRow) => mapRound(row));
}

export async function listRecentSettledRoundsByShoe(
  tableId: string,
  shoeId: string,
  limit = 8,
  executor: DbExecutor = pool,
) {
  if (!shoeId) {
    return [] as GameRoundRecord[];
  }

  const rows = await queryRows(
    executor,
    "SELECT * FROM game_rounds WHERE table_id = $1 AND shoe_id = $2 AND status = 'SETTLED' ORDER BY settled_at DESC LIMIT $3",
    [tableId, shoeId, limit],
  );
  return rows.map((row: DbRow) => mapRound(row));
}

export async function updateRoundStatus(roundId: string, status: RoundStatus, executor: DbExecutor = pool) {
  await executor.query("UPDATE game_rounds SET status = $1 WHERE id = $2", [status, roundId]);
  return requireRecord(await findRoundById(roundId, executor), "Updated round");
}

export async function cancelRoundAndRefundBets(
  roundId: string,
  reason: string,
  executor: DbExecutor = pool,
): Promise<string[]> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => cancelRoundAndRefundBets(roundId, reason, client));
  }

  const round = await findRoundById(roundId, executor, { forUpdate: true });
  if (!round) throw new Error(`Cannot cancel missing round ${roundId}`);
  if (round.status === "CANCELLED") return [] as string[];
  if (round.status === "SETTLED") throw new Error(`Cannot cancel settled round ${roundId}`);

  const refundRows = await queryRows(
    executor,
    `SELECT user_id, SUM(amount)::bigint AS refund
     FROM bets
     WHERE round_id = $1
     GROUP BY user_id
     ORDER BY user_id ASC`,
    [roundId],
  );

  for (const row of refundRows) {
    const userId = String(row.user_id);
    const refund = Number(row.refund);
    await applyBalanceMutation(
      {
        userId,
        delta: refund,
        actorType: "SYSTEM",
        source: "SETTLEMENT_CREDIT",
        referenceType: "ROUND",
        referenceId: roundId,
        metadata: { cancellationReason: reason, refund: true },
      },
      executor,
    );
  }

  await executor.query("UPDATE bets SET payout = amount WHERE round_id = $1", [roundId]);
  await executor.query(
    `UPDATE game_rounds
     SET status = 'CANCELLED', cancellation_reason = $1, settled_at = $2
     WHERE id = $3`,
    [reason, new Date().toISOString(), roundId],
  );

  return refundRows.map((row) => String(row.user_id));
}

export async function settleRound(
  roundId: string,
  result: {
    playerCards: Card[];
    bankerCards: Card[];
    playerTotal: number;
    bankerTotal: number;
    winner: RoundWinner;
    playerPair: boolean;
    bankerPair: boolean;
  },
  executor: DbExecutor = pool,
) {
  const settledAt = new Date().toISOString();

  await executor.query(
    `UPDATE game_rounds
     SET player_cards = $1::jsonb,
         banker_cards = $2::jsonb,
         player_total = $3,
         banker_total = $4,
         winner = $5,
         status = 'SETTLED',
         settled_at = $6,
         player_pair = $7,
         banker_pair = $8
     WHERE id = $9`,
    [
      JSON.stringify(result.playerCards),
      JSON.stringify(result.bankerCards),
      result.playerTotal,
      result.bankerTotal,
      result.winner,
      settledAt,
      result.playerPair,
      result.bankerPair,
      roundId,
    ],
  );

  return requireRecord(await findRoundById(roundId, executor), "Settled round");
}

export async function purgeSettledRoundsBefore(
  cutoffIso: string,
  executor: DbExecutor = pool,
): Promise<{ deletedRounds: number; deletedBets: number }> {
  if (isPoolClient(executor)) {
    const deletedBets = await executor.query(
      `DELETE FROM bets
       WHERE round_id IN (
         SELECT id FROM game_rounds
         WHERE status IN ('SETTLED', 'CANCELLED')
           AND settled_at IS NOT NULL
           AND settled_at < $1
       )`,
      [cutoffIso],
    );
    const deletedRounds = await executor.query(
      "DELETE FROM game_rounds WHERE status IN ('SETTLED', 'CANCELLED') AND settled_at IS NOT NULL AND settled_at < $1",
      [cutoffIso],
    );

    return { deletedRounds: deletedRounds.rowCount ?? 0, deletedBets: deletedBets.rowCount ?? 0 };
  }

  return withTransaction((client) => purgeSettledRoundsBefore(cutoffIso, client));
}
export async function createBalanceAdjustment(
  input: {
    adminId: string;
    userId: string;
    amount: number;
    note?: string;
  },
  executor: DbExecutor = pool,
) {
  if (
    !Number.isSafeInteger(input.amount) ||
    input.amount === 0 ||
    Math.abs(input.amount) > MAX_ACCOUNT_BALANCE ||
    input.amount % MONEY_DENOMINATION !== 0
  ) {
    throw new RangeError("Balance adjustment violates money policy");
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await executor.query(
    "INSERT INTO balance_adjustments (id, admin_id, user_id, amount, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, input.adminId, input.userId, input.amount, input.note ?? null, createdAt],
  );

  return { id, ...input, createdAt };
}

function mapShoeCommitment(row: DbRow): ShoeCommitmentRecord {
  return {
    version: Number(row.audit_version),
    shoeId: String(row.shoe_id),
    tableId: String(row.table_id),
    shuffleAlgorithm: String(row.shuffle_algorithm),
    dealAlgorithm: String(row.deal_algorithm),
    deckCount: Number(row.deck_count),
    commitment: String(row.commitment),
    cutCardRemaining: Number(row.cut_card_remaining),
    committedAt: toIsoString(row.committed_at),
  };
}

function publicShoeCommitment(commitment: ShoeCommitmentRecord | null) {
  if (!commitment) return null;
  return {
    version: commitment.version,
    shoeId: commitment.shoeId,
    shuffleAlgorithm: commitment.shuffleAlgorithm,
    dealAlgorithm: commitment.dealAlgorithm,
    deckCount: commitment.deckCount,
    commitment: commitment.commitment,
    committedAt: commitment.committedAt,
  };
}

function mapShoeDealAudit(row: DbRow): ShoeDealAuditRecord {
  return {
    dealIndex: Number(row.deal_index),
    roundId: String(row.round_id),
    dealtCards: parseJsonValue<Card[]>(row.dealt_cards),
    result: parseJsonValue<AuditedRoundResult>(row.round_result),
    recordedAt: toIsoString(row.recorded_at),
  };
}

export async function getShoeCommitment(shoeId: string, executor: DbExecutor = pool) {
  if (!shoeId) return null;
  const row = await queryRow(executor, "SELECT * FROM shoe_commitments WHERE shoe_id = $1", [shoeId]);
  return row ? mapShoeCommitment(row) : null;
}

async function getShoeCommitments(shoeIds: string[], executor: DbExecutor = pool) {
  if (shoeIds.length === 0) return new Map<string, ShoeCommitmentRecord>();
  const rows = await queryRows(executor, "SELECT * FROM shoe_commitments WHERE shoe_id = ANY($1)", [shoeIds]);
  return new Map(rows.map((row: DbRow) => {
    const commitment = mapShoeCommitment(row);
    return [commitment.shoeId, commitment] as const;
  }));
}

async function lockShoeLifecycle(shoeId: string, executor: PoolClient) {
  return queryRow(
    executor,
    `SELECT c.*, s.seed_hex AS active_seed, r.shoe_id AS revealed_shoe_id
     FROM shoe_commitments c
     LEFT JOIN shoe_secrets s ON s.shoe_id = c.shoe_id
     LEFT JOIN shoe_reveals r ON r.shoe_id = c.shoe_id
     WHERE c.shoe_id = $1
     FOR UPDATE OF c`,
    [shoeId],
  );
}

export async function validateActiveShoeAudit(
  shoeId: string,
  tableId: string,
  executor: DbExecutor = pool,
): Promise<{ valid: boolean; reason: string | null }> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => validateActiveShoeAudit(shoeId, tableId, client));
  }

  const row = await lockShoeLifecycle(shoeId, executor);
  if (!row) return { valid: false, reason: "SHOE_COMMITMENT_MISSING" };
  if (String(row.table_id) !== tableId) return { valid: false, reason: "SHOE_TABLE_MISMATCH" };
  if (row.revealed_shoe_id) return { valid: false, reason: "SHOE_ALREADY_REVEALED" };
  if (!row.active_seed) return { valid: false, reason: "SHOE_ACTIVE_SECRET_MISSING" };
  if (
    Number(row.audit_version) !== SHOE_AUDIT_VERSION ||
    String(row.shuffle_algorithm) !== SHOE_SHUFFLE_ALGORITHM ||
    String(row.deal_algorithm) !== SHOE_DEAL_ALGORITHM ||
    Number(row.deck_count) !== SHOE_DECK_COUNT
  ) {
    return { valid: false, reason: "SHOE_AUDIT_VERSION_MISMATCH" };
  }

  try {
    const expectedCommitment = createShoeCommitment({
      shoeId,
      tableId,
      seed: String(row.active_seed),
      deckCount: Number(row.deck_count),
    });
    if (expectedCommitment !== String(row.commitment)) {
      return { valid: false, reason: "SHOE_COMMITMENT_INVALID" };
    }
    if (createShoeFromSeed(String(row.active_seed), Number(row.deck_count)).shoe.cutCardRemaining !== Number(row.cut_card_remaining)) {
      return { valid: false, reason: "SHOE_CUT_CARD_INVALID" };
    }
  } catch {
    return { valid: false, reason: "SHOE_COMMITMENT_INVALID" };
  }

  return { valid: true, reason: null };
}

export async function getShoeAuditBundle(shoeId: string, executor: DbExecutor = pool): Promise<ShoeAuditBundle | null> {
  const row = await queryRow(
    executor,
    `SELECT c.*, r.seed_hex, r.reveal_reason, r.revealed_at
     FROM shoe_commitments c
     LEFT JOIN shoe_reveals r ON r.shoe_id = c.shoe_id
     WHERE c.shoe_id = $1`,
    [shoeId],
  );
  if (!row) return null;

  const dealRows = await queryRows(
    executor,
    "SELECT * FROM shoe_deal_audits WHERE shoe_id = $1 ORDER BY deal_index ASC",
    [shoeId],
  );

  return {
    ...mapShoeCommitment(row),
    reveal: row.seed_hex
      ? {
          seed: String(row.seed_hex),
          reason: String(row.reveal_reason),
          revealedAt: toIsoString(row.revealed_at),
        }
      : null,
    deals: dealRows.map((dealRow: DbRow) => mapShoeDealAudit(dealRow)),
  };
}

export async function recordShoeDealAudit(
  input: {
    shoeId: string;
    roundId: string;
    dealtCards: Card[];
    result: AuditedRoundResult;
  },
  executor: DbExecutor = pool,
): Promise<ShoeDealAuditRecord> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => recordShoeDealAudit(input, client));
  }

  const lifecycle = await lockShoeLifecycle(input.shoeId, executor);
  if (!lifecycle) throw new Error(`Cannot audit uncommitted shoe ${input.shoeId}`);
  if (lifecycle.revealed_shoe_id) throw new Error(`Cannot append deal after shoe ${input.shoeId} reveal`);
  if (!lifecycle.active_seed) throw new Error(`Cannot audit shoe ${input.shoeId}: active seed is missing`);

  const indexRow = await queryRow(
    executor,
    "SELECT COALESCE(MAX(deal_index), -1) + 1 AS next_index FROM shoe_deal_audits WHERE shoe_id = $1",
    [input.shoeId],
  );
  const dealIndex = Number(indexRow?.next_index ?? 0);
  const recordedAt = new Date().toISOString();

  await executor.query(
    `INSERT INTO shoe_deal_audits (round_id, shoe_id, deal_index, dealt_cards, round_result, recorded_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      input.roundId,
      input.shoeId,
      dealIndex,
      JSON.stringify(input.dealtCards),
      JSON.stringify(input.result),
      recordedAt,
    ],
  );

  return { dealIndex, ...input, recordedAt };
}

async function revealShoeAudit(shoeId: string, reason: string, executor: DbExecutor): Promise<void> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => revealShoeAudit(shoeId, reason, client));
  }

  const lifecycle = await lockShoeLifecycle(shoeId, executor);
  if (!lifecycle) return;
  if (lifecycle.revealed_shoe_id) {
    await executor.query("DELETE FROM shoe_secrets WHERE shoe_id = $1", [shoeId]);
    return;
  }
  if (!lifecycle.active_seed) {
    // The lost seed cannot be truthfully revealed. Leave the commitment as an
    // unrevealed cancelled proof and rotate the table to a fresh commitment.
    return;
  }

  const revealedAt = new Date().toISOString();
  await executor.query(
    `INSERT INTO shoe_reveals (shoe_id, seed_hex, reveal_reason, revealed_at)
     VALUES ($1, $2, $3, $4)`,
    [shoeId, String(lifecycle.active_seed), reason, revealedAt],
  );

  await executor.query("DELETE FROM shoe_secrets WHERE shoe_id = $1", [shoeId]);
}

function normalizeLegacyShoeState(cards: Card[]): TableShoeState {
  const cutCardReached = cards.length <= 14;

  return {
    cards,
    cutCardRemaining: Math.min(14, cards.length),
    cutCardReached,
    lastHandPending: cutCardReached,
  };
}

export async function getTableShoe(
  tableId: string,
  executor: DbExecutor = pool,
  options?: { forUpdate?: boolean },
): Promise<PersistedTableShoe | null> {
  const suffix = options?.forUpdate && isPoolClient(executor) ? " FOR UPDATE" : "";
  const row = await queryRow(executor, `SELECT current_shoe_id, shoe_state FROM game_tables WHERE id = $1${suffix}`, [tableId]);

  if (!row) {
    return null;
  }

  const shoeId = String(row.current_shoe_id);
  const parsed = parseJsonValue<Partial<TableShoeState> | Card[]>(row.shoe_state);

  if (Array.isArray(parsed)) {
    return {
      shoeId,
      ...normalizeLegacyShoeState(parsed),
    };
  }

  const cards = Array.isArray(parsed.cards) ? (parsed.cards) : [];
  return {
    shoeId,
    cards,
    cutCardRemaining:
      typeof parsed.cutCardRemaining === "number" && Number.isFinite(parsed.cutCardRemaining)
        ? parsed.cutCardRemaining
        : Math.min(14, cards.length),
    cutCardReached: Boolean(parsed.cutCardReached),
    lastHandPending: Boolean(parsed.lastHandPending),
  };
}

export async function replaceTableShoe(
  tableId: string,
  executor: DbExecutor = pool,
  revealReason = "ROTATED",
): Promise<PersistedTableShoe> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => replaceTableShoe(tableId, client, revealReason));
  }

  const currentShoe = await getTableShoe(tableId, executor, { forUpdate: true });
  if (currentShoe?.shoeId) {
    await revealShoeAudit(currentShoe.shoeId, revealReason, executor);
  }

  const shoeId = randomUUID();
  const seed = generateShoeSeed();
  const createdAt = new Date().toISOString();
  const nextShoe = createShoeFromSeed(seed, SHOE_DECK_COUNT).shoe;
  const commitment = createShoeCommitment({ shoeId, tableId, seed, deckCount: SHOE_DECK_COUNT });

  await executor.query(
    `INSERT INTO shoe_commitments (
       shoe_id, table_id, audit_version, shuffle_algorithm, deal_algorithm,
       deck_count, commitment, cut_card_remaining, committed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      shoeId,
      tableId,
      SHOE_AUDIT_VERSION,
      SHOE_SHUFFLE_ALGORITHM,
      SHOE_DEAL_ALGORITHM,
      SHOE_DECK_COUNT,
      commitment,
      nextShoe.cutCardRemaining,
      createdAt,
    ],
  );
  await executor.query(
    "INSERT INTO shoe_secrets (shoe_id, seed_hex, created_at) VALUES ($1, $2, $3)",
    [shoeId, seed, createdAt],
  );
  await executor.query("UPDATE game_tables SET current_shoe_id = $1, shoe_state = $2::jsonb WHERE id = $3", [
    shoeId,
    JSON.stringify({
      cards: nextShoe.cards,
      cutCardRemaining: nextShoe.cutCardRemaining,
      cutCardReached: nextShoe.cutCardReached,
      lastHandPending: nextShoe.lastHandPending,
    }),
    tableId,
  ]);
  return { shoeId, ...nextShoe };
}

export async function saveTableShoe(tableId: string, shoeId: string, shoe: TableShoeState, executor: DbExecutor = pool) {
  await executor.query("UPDATE game_tables SET current_shoe_id = $1, shoe_state = $2::jsonb WHERE id = $3", [
    shoeId,
    JSON.stringify({
      cards: shoe.cards,
      cutCardRemaining: shoe.cutCardRemaining,
      cutCardReached: shoe.cutCardReached,
      lastHandPending: shoe.lastHandPending,
    }),
    tableId,
  ]);
  return {
    shoeId,
    ...shoe,
  };
}

export async function ensureTableShoe(
  tableId: string,
  executor: DbExecutor = pool,
): Promise<PersistedTableShoe> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => ensureTableShoe(tableId, client));
  }

  const currentShoe = await getTableShoe(tableId, executor, { forUpdate: true });

  const commitment = currentShoe?.shoeId ? await getShoeCommitment(currentShoe.shoeId, executor) : null;

  if (currentShoe?.shoeId && commitment) {
    const validation = await validateActiveShoeAudit(currentShoe.shoeId, tableId, executor);
    if (!validation.valid) {
      return replaceTableShoe(tableId, executor, validation.reason ?? "SHOE_AUDIT_INVALID");
    }
  }

  if (!currentShoe || !currentShoe.shoeId || currentShoe.cards.length < 6 || !commitment) {
    return replaceTableShoe(
      tableId,
      executor,
      commitment ? "INSUFFICIENT_CARDS" : "LEGACY_UPGRADE",
    );
  }

  return currentShoe;
}

async function migrateTableShoeAtStartup(tableId: string, executor: PoolClient) {
  const activeRound = await getActiveRound(tableId, executor, { forUpdate: true });
  const currentShoe = await getTableShoe(tableId, executor, { forUpdate: true });
  const commitment = currentShoe?.shoeId ? await getShoeCommitment(currentShoe.shoeId, executor) : null;

  if (commitment && currentShoe) {
    const validation = await validateActiveShoeAudit(currentShoe.shoeId, tableId, executor);
    if (!validation.valid) {
      if (activeRound) {
        await cancelRoundAndRefundBets(activeRound.id, validation.reason ?? "SHOE_AUDIT_INVALID", executor);
      }
      return {
        shoe: await replaceTableShoe(tableId, executor, validation.reason ?? "SHOE_AUDIT_INVALID"),
        fatalReason: null,
      };
    }
  }

  const requiresRotation = !currentShoe || !currentShoe.shoeId || !commitment || currentShoe.cards.length < 6;
  if (
    activeRound &&
    (requiresRotation || !currentShoe || activeRound.shoeId !== currentShoe.shoeId)
  ) {
    const cancellationReason = !commitment
      ? "LEGACY_SHOE_UNAUDITED"
      : currentShoe && currentShoe.cards.length < 6
        ? "INSUFFICIENT_COMMITTED_CARDS"
        : "SHOE_BINDING_INVALID";
    await cancelRoundAndRefundBets(activeRound.id, cancellationReason, executor);
  }

  if (requiresRotation) {
    return {
      shoe: await replaceTableShoe(
        tableId,
        executor,
        commitment ? "INSUFFICIENT_CARDS_CANCELLED" : "LEGACY_UPGRADE",
      ),
      fatalReason: null,
    };
  }

  return { shoe: currentShoe, fatalReason: null };
}

export async function listAdjustments(executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    `SELECT
      ba.id,
      ba.amount,
      ba.note,
      ba.created_at,
      a.username AS admin_username,
      u.username AS user_username
    FROM balance_adjustments ba
    JOIN users a ON a.id = ba.admin_id
    JOIN users u ON u.id = ba.user_id
    ORDER BY ba.created_at DESC
    LIMIT 20`,
  );

  return rows.map((row: DbRow) => ({
    id: String(row.id),
    amount: Number(row.amount),
    note: row.note ? String(row.note) : undefined,
    createdAt: toIsoString(row.created_at),
    admin: { username: String(row.admin_username) },
    user: { username: String(row.user_username) },
  }));
}

export async function buildLobbyTables(executor: DbExecutor = pool) {
  const tables = await listTables(executor);

  if (tables.length === 0) return [];

  const tableIds = tables.map((t) => t.id);

  const [allActiveRows, allRecentRows] = await Promise.all([
    queryRows(
      executor,
      `SELECT * FROM game_rounds WHERE table_id = ANY($1) AND status IN ('OPEN', 'LOCKED') ORDER BY created_at DESC`,
      [tableIds],
    ),
    queryRows(
      executor,
      `SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY table_id ORDER BY settled_at DESC) AS rn
        FROM game_rounds WHERE table_id = ANY($1) AND status = 'SETTLED'
      ) sub WHERE rn <= 30`,
      [tableIds],
    ),
  ]);

  const activeByTable = new Map<string, GameRoundRecord>();
  for (const row of allActiveRows) {
    const round = mapRound(row);
    if (!activeByTable.has(round.tableId)) {
      activeByTable.set(round.tableId, round);
    }
  }

  const recentByTable = new Map<string, GameRoundRecord[]>();
  for (const row of allRecentRows) {
    const round = mapRound(row);
    const list = recentByTable.get(round.tableId) ?? [];
    list.push(round);
    recentByTable.set(round.tableId, list);
  }

  const roadShoeQueries: Promise<{ tableId: string; rounds: GameRoundRecord[] }>[] = [];
  for (const table of tables) {
    const active = activeByTable.get(table.id);
    if (active?.shoeId) {
      roadShoeQueries.push(
        listRecentSettledRoundsByShoe(table.id, active.shoeId, 200, executor)
          .then((rounds) => ({ tableId: table.id, rounds })),
      );
    }
  }
  const roadResults = await Promise.all(roadShoeQueries);
  const roadByTable = new Map(roadResults.map((r) => [r.tableId, r.rounds]));
  const commitments = await getShoeCommitments(
    Array.from(activeByTable.values(), (round) => round.shoeId).filter(Boolean),
    executor,
  );

  return tables.map((table) => {
    const recentRounds = recentByTable.get(table.id) ?? [];
    const activeRound = activeByTable.get(table.id) ?? null;
    const previousRound = recentRounds[0] ?? null;
    const roadRounds = roadByTable.get(table.id) ?? [];

    return {
      table,
      activeRound,
      previousRound,
      recentRounds: recentRounds.slice(0, 6),
      roadRounds,
      shoeAudit: publicShoeCommitment(activeRound ? commitments.get(activeRound.shoeId) ?? null : null),
    };
  });
}

export async function buildTablePublicState(tableId: string, executor: DbExecutor = pool) {
  const table = await findTableById(tableId, executor);

  if (!table) {
    return null;
  }

  const activeRound = await getActiveRound(table.id, executor);
  const recentRounds = await listRecentSettledRounds(table.id, 24, executor);
  const previousRound = recentRounds[0] ?? null;
  const roadRounds = activeRound ? await listRecentSettledRoundsByShoe(table.id, activeRound.shoeId, 200, executor) : [];
  const shoe = await getTableShoe(table.id, executor);
  const shoeCommitment = await getShoeCommitment(activeRound?.shoeId ?? shoe?.shoeId ?? "", executor);

  if (!activeRound) {
    return {
      table,
      round: null,
      previousRound,
      presentation: null,
      recentRounds,
      roadRounds,
      shoeStatus: {
        isLastHand: Boolean(shoe?.lastHandPending),
        cutCardReached: Boolean(shoe?.cutCardReached),
      },
      shoeAudit: publicShoeCommitment(shoeCommitment),
      serverTime: new Date().toISOString(),
    };
  }

  return {
    table,
    round: activeRound,
    previousRound,
    presentation: previousRound?.settledAt
      ? {
          startsAt: previousRound.settledAt,
          endsAt: activeRound.bettingOpensAt,
        }
      : null,
    recentRounds,
    roadRounds,
    shoeStatus: {
      isLastHand: Boolean(shoe?.lastHandPending),
      cutCardReached: Boolean(shoe?.cutCardReached),
    },
    shoeAudit: publicShoeCommitment(shoeCommitment),
    serverTime: new Date().toISOString(),
  };
}

export async function buildTableUserState(userId: string, tableId: string, executor: DbExecutor = pool) {
  const [user, activeRound] = await Promise.all([
    findUserById(userId, executor),
    getActiveRound(tableId, executor),
  ]);
  const roundId = activeRound?.id ?? "";
  const myBets = roundId ? await listUserRoundBets(userId, roundId, executor) : [];

  return {
    tableId,
    currentRoundId: roundId,
    myBets,
    balance: user?.balance ?? 0,
    isActive: user?.isActive ?? false,
    serverTime: new Date().toISOString(),
  };
}

export async function buildUserLiveState(userId: string, executor: DbExecutor = pool) {
  const user = await findUserById(userId, executor);

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    balance: user.balance,
    serverTime: new Date().toISOString(),
  };
}

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
                 round_phase_offset_ms = $5, min_bet = $6, max_bet = $7
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
