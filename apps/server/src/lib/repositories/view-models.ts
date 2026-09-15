import type { GameRoundRecord } from "../../types/domain.js";
import { type DbExecutor, type DbRow, pool, queryRows, toIsoString } from "./client.js";
import { findTableById, findUserById, listTables, mapRound } from "./users.js";
import { getActiveRound, listRecentSettledRounds, listRecentSettledRoundsByShoe, listUserRoundBets } from "./rounds.js";
import {
  getShoeCommitment,
  getShoeCommitments,
  getTableShoe,
  publicShoeCommitment,
} from "./shoes.js";

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
    walletVersion: user?.walletVersion ?? 0,
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
    walletVersion: user.walletVersion,
    serverTime: new Date().toISOString(),
  };
}
