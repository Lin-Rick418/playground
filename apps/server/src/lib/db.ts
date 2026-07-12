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
import { createMassachusettsShoeState, type Card, type TableShoeState } from "./baccarat.js";

type DbExecutor = Pool | PoolClient;
type DbRow = Record<string, unknown>;

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

  return String(value ?? "");
}

function toBoolean(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
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
    isActive: toBoolean(row.is_active),
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
    minBet: Number(row.min_bet),
    maxBet: Number(row.max_bet),
    createdAt: toIsoString(row.created_at),
  };
}

function mapRound(row: DbRow): GameRoundRecord {
  return {
    id: String(row.id),
    tableId: String(row.table_id),
    shoeId: String(row.shoe_id ?? ""),
    playerCards: parseJsonValue<{ rank: string; suit: string }[]>(row.player_cards, []),
    bankerCards: parseJsonValue<{ rank: string; suit: string }[]>(row.banker_cards, []),
    playerTotal: Number(row.player_total),
    bankerTotal: Number(row.banker_total),
    winner: String(row.winner) as RoundWinner,
    playerPair: toBoolean(row.player_pair),
    bankerPair: toBoolean(row.banker_pair),
    status: String(row.status) as RoundStatus,
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
    isActive: toBoolean(row.is_active),
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

  return findUserById(id, executor);
}

export async function setUserActive(userId: string, isActive: boolean, executor: DbExecutor = pool) {
  const now = new Date().toISOString();
  await executor.query("UPDATE users SET is_active = $1, updated_at = $2 WHERE id = $3", [isActive, now, userId]);
  return findUserById(userId, executor);
}

export async function updateUserBalance(userId: string, balance: number, executor: DbExecutor = pool) {
  const now = new Date().toISOString();
  await executor.query("UPDATE users SET balance = $1, updated_at = $2 WHERE id = $3", [balance, now, userId]);
  return findUserById(userId, executor);
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

  return findRoundById(id, executor);
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
    const bets = parseJsonValue<{ id: string; betType: BetType; amount: number; payout: number; createdAt: string }[]>(row.bets, []);
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
        playerCards: parseJsonValue<{ rank: string; suit: string }[]>(row.player_cards, []),
        bankerCards: parseJsonValue<{ rank: string; suit: string }[]>(row.banker_cards, []),
        playerTotal: Number(row.player_total),
        bankerTotal: Number(row.banker_total),
        playerPair: toBoolean(row.player_pair),
        bankerPair: toBoolean(row.banker_pair),
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
  return findRoundById(roundId, executor);
}

export async function settleRound(
  roundId: string,
  result: {
    playerCards: unknown;
    bankerCards: unknown;
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

  return findRoundById(roundId, executor);
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
         WHERE status = 'SETTLED'
           AND settled_at IS NOT NULL
           AND settled_at < $1
       )`,
      [cutoffIso],
    );
    const deletedRounds = await executor.query(
      "DELETE FROM game_rounds WHERE status = 'SETTLED' AND settled_at IS NOT NULL AND settled_at < $1",
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

function createShuffledShoeState() {
  return {
    shoeId: randomUUID(),
    ...createMassachusettsShoeState(),
  };
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
) {
  const suffix = options?.forUpdate && isPoolClient(executor) ? " FOR UPDATE" : "";
  const row = await queryRow(executor, `SELECT current_shoe_id, shoe_state FROM game_tables WHERE id = $1${suffix}`, [tableId]);

  if (!row) {
    return null;
  }

  const shoeId = String(row.current_shoe_id ?? "");
  const parsed = parseJsonValue<Partial<TableShoeState> | Card[]>(row.shoe_state, []);

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

export async function replaceTableShoe(tableId: string, executor: DbExecutor = pool) {
  const nextShoe = createShuffledShoeState();
  await executor.query("UPDATE game_tables SET current_shoe_id = $1, shoe_state = $2::jsonb WHERE id = $3", [
    nextShoe.shoeId,
    JSON.stringify({
      cards: nextShoe.cards,
      cutCardRemaining: nextShoe.cutCardRemaining,
      cutCardReached: nextShoe.cutCardReached,
      lastHandPending: nextShoe.lastHandPending,
    }),
    tableId,
  ]);
  return nextShoe;
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

export async function ensureTableShoe(tableId: string, executor: DbExecutor = pool) {
  const currentShoe = await getTableShoe(tableId, executor, isPoolClient(executor) ? { forUpdate: true } : undefined);

  if (!currentShoe || !currentShoe.shoeId || currentShoe.cards.length === 0) {
    return replaceTableShoe(tableId, executor);
  }

  return currentShoe;
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
    { code: "A01", name: "極速廳 A01", displayOrder: 1, roundDurationMs: 15000, minBet: 100, maxBet: 10000 },
    { code: "A02", name: "極速廳 A02", displayOrder: 2, roundDurationMs: 15000, minBet: 100, maxBet: 10000 },
    { code: "C01", name: "經典廳 C01", displayOrder: 3, roundDurationMs: 30000, minBet: 100, maxBet: 10000 },
    { code: "H01", name: "高額廳 H01", displayOrder: 4, roundDurationMs: 30000, minBet: 1000, maxBet: 50000 },
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
             SET code = $1, name = $2, display_order = $3, round_duration_ms = $4, min_bet = $5, max_bet = $6
             WHERE id = $7`,
            [table.code, table.name, table.displayOrder, table.roundDurationMs, table.minBet, table.maxBet, String(existingByOrder.id)],
          );
          continue;
        }

        await tx.query(
          `INSERT INTO game_tables (id, code, name, display_order, round_duration_ms, min_bet, max_bet, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [randomUUID(), table.code, table.name, table.displayOrder, table.roundDurationMs, table.minBet, table.maxBet, now],
        );
      }
    });

    const tables = await listTables(client);

    for (const table of tables) {
      const currentShoe = await getTableShoe(table.id, client);
      const ensuredShoe =
        !currentShoe || !currentShoe.shoeId || currentShoe.cards.length === 0 ? await replaceTableShoe(table.id, client) : currentShoe;

      await client.query("UPDATE game_rounds SET shoe_id = $1 WHERE table_id = $2 AND shoe_id = ''", [ensuredShoe.shoeId, table.id]);
    }
  });
}
