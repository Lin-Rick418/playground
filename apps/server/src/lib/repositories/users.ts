import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { GameRoundRecord, GameTableRecord, RoundStatus, RoundWinner, UserRecord, UserRole } from "../../types/domain.js";
import type { Card } from "../baccarat.js";
import { calculateBalanceTransition, type FinancialLedgerActorType, type FinancialLedgerReferenceType, type FinancialLedgerSource } from "../financial-ledger.js";
import { assertAccountBalance, MONEY_DENOMINATION, normalizeUsername, usernameSchema } from "../account-policy.js";
import { assertPasswordHash, type DbExecutor, type DbRow, isPoolClient, parseJsonValue, pool, queryRow, queryRows, requireRecord, toIsoString, withTransaction } from "./client.js";

export function mapUser(row: DbRow): UserRecord {
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

export function mapTable(row: DbRow): GameTableRecord {
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

export function mapRound(row: DbRow): GameRoundRecord {
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
