import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
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

const dbPath = resolve(process.cwd(), "data", "baccarat.sqlite");

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS game_tables (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    round_duration_ms INTEGER NOT NULL DEFAULT 30000,
    min_bet INTEGER NOT NULL DEFAULT 100,
    max_bet INTEGER NOT NULL DEFAULT 10000,
    current_shoe_id TEXT NOT NULL DEFAULT '',
    shoe_state TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_rounds (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL DEFAULT '',
    shoe_id TEXT NOT NULL DEFAULT '',
    player_cards TEXT NOT NULL,
    banker_cards TEXT NOT NULL,
    player_total INTEGER NOT NULL,
    banker_total INTEGER NOT NULL,
    winner TEXT NOT NULL,
    player_pair INTEGER NOT NULL DEFAULT 0,
    banker_pair INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'SETTLED',
    betting_opens_at TEXT NOT NULL DEFAULT '',
    betting_closes_at TEXT NOT NULL DEFAULT '',
    settled_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    bet_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payout INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(round_id) REFERENCES game_rounds(id)
  );

  CREATE TABLE IF NOT EXISTS balance_adjustments (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(admin_id) REFERENCES users(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
  const exists = columns.some((item) => String(item.name) === column);

  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("game_rounds", "status", "TEXT NOT NULL DEFAULT 'SETTLED'");
ensureColumn("game_rounds", "betting_opens_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("game_rounds", "betting_closes_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("game_rounds", "settled_at", "TEXT");
ensureColumn("game_rounds", "table_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("game_rounds", "shoe_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("game_rounds", "player_pair", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("game_rounds", "banker_pair", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "is_active", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("game_tables", "round_duration_ms", "INTEGER NOT NULL DEFAULT 30000");
ensureColumn("game_tables", "min_bet", "INTEGER NOT NULL DEFAULT 100");
ensureColumn("game_tables", "max_bet", "INTEGER NOT NULL DEFAULT 10000");
ensureColumn("game_tables", "current_shoe_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("game_tables", "shoe_state", "TEXT NOT NULL DEFAULT '[]'");

db.exec(`
  UPDATE game_rounds
  SET
    status = 'SETTLED',
    betting_opens_at = CASE WHEN betting_opens_at = '' THEN created_at ELSE betting_opens_at END,
    betting_closes_at = CASE WHEN betting_closes_at = '' THEN created_at ELSE betting_closes_at END,
    settled_at = COALESCE(settled_at, created_at)
  WHERE status IS NULL OR status = '' OR settled_at IS NULL;
`);

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: String(row.role) as UserRole,
    isActive: Boolean(row.is_active),
    balance: Number(row.balance),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

type DbRow = Record<string, unknown>;

function mapTable(row: DbRow): GameTableRecord {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    displayOrder: Number(row.display_order),
    roundDurationMs: Number(row.round_duration_ms),
    minBet: Number(row.min_bet),
    maxBet: Number(row.max_bet),
    createdAt: String(row.created_at),
  };
}

function mapRound(row: DbRow): GameRoundRecord {
  return {
    id: String(row.id),
    tableId: String(row.table_id),
    shoeId: String(row.shoe_id ?? ""),
    playerCards: JSON.parse(String(row.player_cards)),
    bankerCards: JSON.parse(String(row.banker_cards)),
    playerTotal: Number(row.player_total),
    bankerTotal: Number(row.banker_total),
    winner: String(row.winner) as RoundWinner,
    playerPair: Boolean(row.player_pair),
    bankerPair: Boolean(row.banker_pair),
    status: String(row.status) as RoundStatus,
    bettingOpensAt: String(row.betting_opens_at),
    bettingClosesAt: String(row.betting_closes_at),
    settledAt: row.settled_at ? String(row.settled_at) : null,
    createdAt: String(row.created_at),
  };
}

export function findUserByUsername(username: string) {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Record<string, unknown> | undefined;
  return row ? mapUser(row) : null;
}

export function listTables() {
  return (db.prepare("SELECT * FROM game_tables ORDER BY display_order ASC, created_at ASC").all() as DbRow[]).map((row) =>
    mapTable(row),
  );
}

export function findTableById(tableId: string) {
  const row = db.prepare("SELECT * FROM game_tables WHERE id = ?").get(tableId) as DbRow | undefined;
  return row ? mapTable(row) : null;
}

export function findUserById(id: string) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapUser(row) : null;
}

export function listUsers() {
  return (db
    .prepare("SELECT id, username, role, is_active, balance, created_at FROM users ORDER BY created_at ASC")
    .all() as DbRow[])
    .map((row: DbRow) => ({
      id: String(row.id),
      username: String(row.username),
      role: String(row.role) as UserRole,
      isActive: Boolean(row.is_active),
      balance: Number(row.balance),
      createdAt: String(row.created_at),
    }));
}

export function createPlayer(input: { username: string; passwordHash: string; balance: number }) {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, is_active, balance, created_at, updated_at)
     VALUES (?, ?, ?, 'PLAYER', 1, ?, ?, ?)`,
  ).run(id, input.username, input.passwordHash, input.balance, now, now);

  return findUserById(id);
}

export function setUserActive(userId: string, isActive: boolean) {
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?").run(isActive ? 1 : 0, now, userId);
  return findUserById(userId);
}

export function updateUserBalance(userId: string, balance: number) {
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?").run(balance, now, userId);
  return findUserById(userId);
}

export function createRound(input: {
  tableId: string;
  shoeId: string;
  status: RoundStatus;
  bettingOpensAt: string;
  bettingClosesAt: string;
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO game_rounds (
      id, table_id, player_cards, banker_cards, player_total, banker_total, winner, status,
      shoe_id, player_pair, banker_pair, betting_opens_at, betting_closes_at, settled_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.tableId,
    JSON.stringify([]),
    JSON.stringify([]),
    0,
    0,
    "TIE",
    input.status,
    input.shoeId,
    0,
    0,
    input.bettingOpensAt,
    input.bettingClosesAt,
    null,
    createdAt,
  );

  return findRoundById(id)!;
}

export function createBet(input: {
  userId: string;
  roundId: string;
  betType: BetType;
  amount: number;
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    "INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.userId, input.roundId, input.betType, input.amount, 0, createdAt);

  return { id, ...input, createdAt };
}

export function listUserHistory(userId: string) {
  const rounds = (db
    .prepare(
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
        g.settled_at
      FROM game_rounds g
      JOIN bets b ON b.round_id = g.id
      WHERE b.user_id = ?
        AND g.status = 'SETTLED'
      GROUP BY g.id
      ORDER BY g.settled_at DESC, g.created_at DESC
      LIMIT 20`,
    )
    .all(userId) as DbRow[]);

  return rounds.map((row: DbRow) => {
    const bets = listUserRoundBets(userId, String(row.round_id));
    const totalAmount = bets.reduce((sum, bet) => sum + bet.amount, 0);
    const totalPayout = bets.reduce((sum, bet) => sum + bet.payout, 0);

    return {
      id: String(row.round_id),
      createdAt: String(row.settled_at),
      totalAmount,
      totalPayout,
      bets,
      round: {
        id: String(row.round_id),
        tableId: String(row.table_id),
        winner: String(row.winner) as RoundWinner,
        playerCards: JSON.parse(String(row.player_cards)),
        bankerCards: JSON.parse(String(row.banker_cards)),
        playerTotal: Number(row.player_total),
        bankerTotal: Number(row.banker_total),
        playerPair: Boolean(row.player_pair),
        bankerPair: Boolean(row.banker_pair),
      },
    };
  });
}

export function listRoundBets(roundId: string) {
  return (db.prepare("SELECT * FROM bets WHERE round_id = ? ORDER BY created_at ASC").all(roundId) as DbRow[]).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    roundId: String(row.round_id),
    betType: String(row.bet_type) as BetType,
    amount: Number(row.amount),
    payout: Number(row.payout),
    createdAt: String(row.created_at),
  }));
}

export function listRoundBetsDetailed(roundId: string) {
  return (db
    .prepare(
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
      WHERE b.round_id = ?
      ORDER BY b.created_at ASC`,
    )
    .all(roundId) as DbRow[])
    .map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      username: String(row.username),
      roundId: String(row.round_id),
      betType: String(row.bet_type) as BetType,
      amount: Number(row.amount),
      payout: Number(row.payout),
      createdAt: String(row.created_at),
    }));
}

export function listUserRoundBets(userId: string, roundId: string) {
  return (db
    .prepare("SELECT id, bet_type, amount, payout, created_at FROM bets WHERE user_id = ? AND round_id = ? ORDER BY created_at ASC")
    .all(userId, roundId) as DbRow[])
    .map((row) => ({
      id: String(row.id),
      betType: String(row.bet_type) as BetType,
      amount: Number(row.amount),
      payout: Number(row.payout),
      createdAt: String(row.created_at),
    }));
}

export function updateBetPayout(betId: string, payout: number) {
  db.prepare("UPDATE bets SET payout = ? WHERE id = ?").run(payout, betId);
}

export function findRoundById(id: string) {
  const row = db.prepare("SELECT * FROM game_rounds WHERE id = ?").get(id) as DbRow | undefined;
  return row ? mapRound(row) : null;
}

export function getActiveRound(tableId: string) {
  const row = db
    .prepare(
      "SELECT * FROM game_rounds WHERE table_id = ? AND status IN ('OPEN', 'LOCKED') ORDER BY created_at DESC LIMIT 1",
    )
    .get(tableId) as DbRow | undefined;

  return row ? mapRound(row) : null;
}

export function listRecentSettledRounds(tableId: string, limit = 8) {
  return (db
    .prepare("SELECT * FROM game_rounds WHERE table_id = ? AND status = 'SETTLED' ORDER BY settled_at DESC LIMIT ?")
    .all(tableId, limit) as DbRow[])
    .map((row) => mapRound(row));
}

export function listRecentSettledRoundsByShoe(tableId: string, shoeId: string, limit = 8) {
  if (!shoeId) {
    return [] as GameRoundRecord[];
  }

  return (db
    .prepare(
      "SELECT * FROM game_rounds WHERE table_id = ? AND shoe_id = ? AND status = 'SETTLED' ORDER BY settled_at DESC LIMIT ?",
    )
    .all(tableId, shoeId, limit) as DbRow[])
    .map((row) => mapRound(row));
}

export function updateRoundStatus(roundId: string, status: RoundStatus) {
  db.prepare("UPDATE game_rounds SET status = ? WHERE id = ?").run(status, roundId);
  return findRoundById(roundId);
}

export function settleRound(
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
) {
  const settledAt = new Date().toISOString();

  db.prepare(
    `UPDATE game_rounds
     SET player_cards = ?, banker_cards = ?, player_total = ?, banker_total = ?, winner = ?, status = 'SETTLED', settled_at = ?
     , player_pair = ?, banker_pair = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(result.playerCards),
    JSON.stringify(result.bankerCards),
    result.playerTotal,
    result.bankerTotal,
    result.winner,
    settledAt,
    result.playerPair ? 1 : 0,
    result.bankerPair ? 1 : 0,
    roundId,
  );

  return findRoundById(roundId)!;
}

export function purgeSettledRoundsBefore(cutoffIso: string) {
  const oldRoundIds = (
    db
      .prepare("SELECT id FROM game_rounds WHERE status = 'SETTLED' AND settled_at IS NOT NULL AND settled_at < ?")
      .all(cutoffIso) as DbRow[]
  ).map((row) => String(row.id));

  if (!oldRoundIds.length) {
    return { deletedRounds: 0, deletedBets: 0 };
  }

  const deleteBets = db.prepare("DELETE FROM bets WHERE round_id = ?");
  const deleteRounds = db.prepare("DELETE FROM game_rounds WHERE id = ?");
  const transaction = db.transaction((roundIds: string[]) => {
    let deletedBets = 0;
    let deletedRounds = 0;

    for (const roundId of roundIds) {
      deletedBets += deleteBets.run(roundId).changes;
      deletedRounds += deleteRounds.run(roundId).changes;
    }

    return { deletedRounds, deletedBets };
  });

  return transaction(oldRoundIds);
}

export function createBalanceAdjustment(input: {
  adminId: string;
  userId: string;
  amount: number;
  note?: string;
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    "INSERT INTO balance_adjustments (id, admin_id, user_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.adminId, input.userId, input.amount, input.note ?? null, createdAt);

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

export function getTableShoe(tableId: string) {
  const row = db.prepare("SELECT current_shoe_id, shoe_state FROM game_tables WHERE id = ?").get(tableId) as DbRow | undefined;

  if (!row) {
    return null;
  }

  const shoeId = String(row.current_shoe_id ?? "");
  const shoeState = String(row.shoe_state ?? "[]");
  const parsed = shoeState ? (JSON.parse(shoeState) as unknown) : [];

  if (Array.isArray(parsed)) {
    return {
      shoeId,
      ...normalizeLegacyShoeState(parsed as Card[]),
    };
  }

  const nextState = parsed as Partial<TableShoeState> | null;
  const cards = Array.isArray(nextState?.cards) ? (nextState.cards as Card[]) : [];

  return {
    shoeId,
    cards,
    cutCardRemaining:
      typeof nextState?.cutCardRemaining === "number" && Number.isFinite(nextState.cutCardRemaining)
        ? nextState.cutCardRemaining
        : Math.min(14, cards.length),
    cutCardReached: Boolean(nextState?.cutCardReached),
    lastHandPending: Boolean(nextState?.lastHandPending),
  };
}

export function replaceTableShoe(tableId: string) {
  const nextShoe = createShuffledShoeState();
  db.prepare("UPDATE game_tables SET current_shoe_id = ?, shoe_state = ? WHERE id = ?").run(
    nextShoe.shoeId,
    JSON.stringify({
      cards: nextShoe.cards,
      cutCardRemaining: nextShoe.cutCardRemaining,
      cutCardReached: nextShoe.cutCardReached,
      lastHandPending: nextShoe.lastHandPending,
    }),
    tableId,
  );
  return nextShoe;
}

export function saveTableShoe(tableId: string, shoeId: string, shoe: TableShoeState) {
  db.prepare("UPDATE game_tables SET current_shoe_id = ?, shoe_state = ? WHERE id = ?").run(
    shoeId,
    JSON.stringify({
      cards: shoe.cards,
      cutCardRemaining: shoe.cutCardRemaining,
      cutCardReached: shoe.cutCardReached,
      lastHandPending: shoe.lastHandPending,
    }),
    tableId,
  );
  return {
    shoeId,
    ...shoe,
  };
}

export function ensureTableShoe(tableId: string) {
  const currentShoe = getTableShoe(tableId);

  if (!currentShoe || !currentShoe.shoeId || currentShoe.cards.length === 0) {
    return replaceTableShoe(tableId);
  }

  return currentShoe;
}

export function listAdjustments() {
  return (db
    .prepare(
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
    )
    .all() as DbRow[])
    .map((row: DbRow) => ({
      id: String(row.id),
      amount: Number(row.amount),
      note: row.note ? String(row.note) : undefined,
      createdAt: String(row.created_at),
      admin: { username: String(row.admin_username) },
      user: { username: String(row.user_username) },
    }));
}

export async function ensureSeedData() {
  const configuredTables = [
    { code: "A01", name: "極速廳 A01", displayOrder: 1, roundDurationMs: 15000, minBet: 100, maxBet: 10000 },
    { code: "A02", name: "極速廳 A02", displayOrder: 2, roundDurationMs: 15000, minBet: 100, maxBet: 10000 },
    { code: "C01", name: "經典廳 C01", displayOrder: 3, roundDurationMs: 30000, minBet: 100, maxBet: 10000 },
    { code: "H01", name: "高額廳 H01", displayOrder: 4, roundDurationMs: 30000, minBet: 1000, maxBet: 50000 },
  ] as const;
  const admin = findUserByUsername("admin");
  const player = findUserByUsername("player1");
  const now = new Date().toISOString();

  if (!admin) {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), "admin", await bcrypt.hash("admin123", 10), "ADMIN", 0, now, now);
  }

  if (!player) {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), "player1", await bcrypt.hash("player123", 10), "PLAYER", 10000, now, now);
  }

  const syncTables = db.transaction(() => {
    for (const table of configuredTables) {
      const existingByOrder = db
        .prepare("SELECT id FROM game_tables WHERE display_order = ?")
        .get(table.displayOrder) as DbRow | undefined;

      if (existingByOrder) {
        db.prepare("UPDATE game_tables SET code = ? WHERE id = ?").run(`__TMP__${table.displayOrder}`, String(existingByOrder.id));
      }
    }

    for (const table of configuredTables) {
      const existingByOrder = db
        .prepare("SELECT id FROM game_tables WHERE display_order = ?")
        .get(table.displayOrder) as DbRow | undefined;

      if (existingByOrder) {
        db.prepare(
          `UPDATE game_tables
           SET code = ?, name = ?, display_order = ?, round_duration_ms = ?, min_bet = ?, max_bet = ?
           WHERE id = ?`,
        ).run(
          table.code,
          table.name,
          table.displayOrder,
          table.roundDurationMs,
          table.minBet,
          table.maxBet,
          String(existingByOrder.id),
        );
        continue;
      }

      db.prepare(
        `INSERT INTO game_tables (id, code, name, display_order, round_duration_ms, min_bet, max_bet, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), table.code, table.name, table.displayOrder, table.roundDurationMs, table.minBet, table.maxBet, now);
    }
  });

  syncTables();

  const tables = listTables();
  const primaryTable = tables[0];

  if (primaryTable) {
    db.prepare("UPDATE game_rounds SET table_id = ? WHERE table_id = ''").run(primaryTable.id);
  }

  const backfillShoes = db.transaction((tableRecords: GameTableRecord[]) => {
    for (const table of tableRecords) {
      const currentShoe = getTableShoe(table.id);
      const ensuredShoe = !currentShoe || !currentShoe.shoeId || currentShoe.cards.length === 0 ? replaceTableShoe(table.id) : currentShoe;

      db.prepare("UPDATE game_rounds SET shoe_id = ? WHERE table_id = ? AND shoe_id = ''").run(ensuredShoe.shoeId, table.id);
    }
  });

  backfillShoes(tables);
}
