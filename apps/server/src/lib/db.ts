import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool, PoolClient, type QueryResultRow } from "pg";
import { env } from "../config/env.js";
import type {
  BetType,
  GameRoundRecord,
  GameTableRecord,
  RoundStatus,
  RoundWinner,
  UserRecord,
  UserRole,
} from "../types/domain.js";
import { type Card, type TableShoeState } from "./baccarat.js";
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

type DbExecutor = Pool | PoolClient;
type DbRow = Record<string, unknown>;
type PersistedTableShoe = TableShoeState & { shoeId: string };

// DATABASE_SSL=true verifies the server certificate; use "no-verify" to opt
// out explicitly (e.g. self-signed certs), never as a silent default.
const sslConfig =
  env.databaseSsl === "true"
    ? { rejectUnauthorized: true }
    : env.databaseSsl === "no-verify"
      ? { rejectUnauthorized: false }
      : undefined;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: sslConfig,
});

pool.on("error", (error: Error) => {
  console.error("Postgres pool error", error);
});

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
  `);
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
  const row = await queryRow(executor, "SELECT * FROM users WHERE username = $1", [username]);
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

export async function listUsers(executor: DbExecutor = pool) {
  const rows = await queryRows(
    executor,
    "SELECT id, username, role, is_active, balance, created_at FROM users ORDER BY created_at ASC",
  );

  return rows.map((row: DbRow) => ({
    id: String(row.id),
    username: String(row.username),
    role: String(row.role) as UserRole,
    isActive: row.is_active as boolean,
    balance: Number(row.balance),
    createdAt: toIsoString(row.created_at),
  }));
}

export async function createPlayer(
  input: { username: string; passwordHash: string; balance: number },
  executor: DbExecutor = pool,
) {
  const id = randomUUID();
  const now = new Date().toISOString();

  await executor.query(
    `INSERT INTO users (id, username, password_hash, role, is_active, balance, created_at, updated_at)
     VALUES ($1, $2, $3, 'PLAYER', TRUE, $4, $5, $6)`,
    [id, input.username, input.passwordHash, input.balance, now, now],
  );

  return requireRecord(await findUserById(id, executor), "Created user");
}

export async function setUserActive(userId: string, isActive: boolean, executor: DbExecutor = pool) {
  const now = new Date().toISOString();
  await executor.query("UPDATE users SET is_active = $1, updated_at = $2 WHERE id = $3", [isActive, now, userId]);
  return requireRecord(await findUserById(userId, executor), "Updated user");
}

export async function updateUserBalance(userId: string, balance: number, executor: DbExecutor = pool) {
  const now = new Date().toISOString();
  await executor.query("UPDATE users SET balance = $1, updated_at = $2 WHERE id = $3", [balance, now, userId]);
  return requireRecord(await findUserById(userId, executor), "Updated user");
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
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await executor.query(
    "INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, input.userId, input.roundId, input.betType, input.amount, 0, createdAt],
  );

  return { id, ...input, payout: 0, createdAt };
}

export async function listUserHistory(userId: string, executor: DbExecutor = pool) {
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
    GROUP BY g.id
    ORDER BY g.settled_at DESC, g.created_at DESC
    LIMIT 20`,
    [userId],
  );

  return rows.map((row: DbRow) => {
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

export async function updateBetPayout(betId: string, payout: number, executor: DbExecutor = pool) {
  await executor.query("UPDATE bets SET payout = $1 WHERE id = $2", [payout, betId]);
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
    const user = await findUserById(userId, executor, { forUpdate: true });
    if (!user) throw new Error(`Cannot refund missing user ${userId}`);
    await updateUserBalance(userId, user.balance + refund, executor);
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

async function hasActiveShoeSecret(shoeId: string, executor: DbExecutor) {
  const row = await queryRow(
    executor,
    "SELECT EXISTS (SELECT 1 FROM shoe_secrets WHERE shoe_id = $1) AS present",
    [shoeId],
  );
  return Boolean(row?.present);
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
    throw new Error(`Cannot rotate committed shoe ${shoeId}: active seed is missing`);
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

  const cards = Array.isArray(parsed.cards) ? (parsed.cards as Card[]) : [];
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

  if (currentShoe?.shoeId && commitment && !(await hasActiveShoeSecret(currentShoe.shoeId, executor))) {
    throw new Error(`Cannot continue committed shoe ${currentShoe.shoeId}: active seed is missing`);
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
      return { shoe: currentShoe, fatalReason: validation.reason ?? "SHOE_AUDIT_INVALID" };
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
    const round = mapRound(row as DbRow);
    if (!activeByTable.has(round.tableId)) {
      activeByTable.set(round.tableId, round);
    }
  }

  const recentByTable = new Map<string, GameRoundRecord[]>();
  for (const row of allRecentRows) {
    const round = mapRound(row as DbRow);
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

async function seedDemoUsers(executor: DbExecutor) {
  const now = new Date().toISOString();

  await executor.query(
    `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (username) DO NOTHING`,
    [randomUUID(), "admin", await bcrypt.hash("admin123", 10), "ADMIN", 0, now, now],
  );

  await executor.query(
    `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (username) DO NOTHING`,
    [randomUUID(), "player1", await bcrypt.hash("player123", 10), "PLAYER", 10000, now, now],
  );
}

export async function ensureSeedData(options?: { seedDemoUsers?: boolean }) {
  const shouldSeedDemoUsers = options?.seedDemoUsers ?? !env.isProduction;
  const configuredTables = [
    { code: "A01", name: "極速廳 A01", displayOrder: 1, roundDurationMs: 15000, roundPhaseOffsetMs: 0, minBet: 100, maxBet: 10000 },
    { code: "A02", name: "極速廳 A02", displayOrder: 2, roundDurationMs: 15000, roundPhaseOffsetMs: 2000, minBet: 100, maxBet: 10000 },
    { code: "C01", name: "經典廳 C01", displayOrder: 3, roundDurationMs: 30000, roundPhaseOffsetMs: 4000, minBet: 100, maxBet: 10000 },
    { code: "H01", name: "高額廳 H01", displayOrder: 4, roundDurationMs: 30000, roundPhaseOffsetMs: 6000, minBet: 1000, maxBet: 50000 },
  ] as const;

  await withAdvisoryLock(INIT_LOCK_KEY, async (client) => {
    await initializeDatabase();

    if (shouldSeedDemoUsers) {
      await seedDemoUsers(client);
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
