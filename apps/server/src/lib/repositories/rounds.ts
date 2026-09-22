import { fromMinorUnits, toMinorUnits, sumMoney, isMoney, minorUnitsToDecimal } from "@baccarat/contracts";
import { randomUUID } from "node:crypto";
import { betTypes, type BetType, type GameRoundRecord, type RoundStatus, type RoundWinner } from "../../types/domain.js";
import type { Card } from "../baccarat.js";
import { chunkItems } from "../batch.js";
import { getMaximumPayout, MAX_ACCOUNT_BALANCE, MONEY_DENOMINATION } from "../account-policy.js";
import { encodeHistoryCursor, type HistoryCursor } from "../history-pagination.js";
import { assertValidRoundWindow } from "../round-schedule.js";
import { type DbExecutor, type DbRow, isPoolClient, parseJsonValue, pool, queryRow, queryRows, requireRecord, toIsoString } from "./client.js";
import { mapRound } from "./users.js";

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
    const totalAmount = sumMoney(bets.map((bet) => bet.amount));
    const totalPayout = sumMoney(bets.map((bet) => bet.payout));

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
    `SELECT COALESCE(SUM(amount), 0) AS total_bet, COALESCE(SUM(payout), 0) AS total_payout
     FROM (
       SELECT b.amount, b.payout FROM bets b JOIN game_rounds g ON g.id = b.round_id
       WHERE b.user_id = $1 AND g.status = 'SETTLED' AND g.settled_at >= $2 AND g.settled_at < $3
       UNION ALL
       SELECT amount, payout FROM mines_rounds
       WHERE user_id = $1 AND status <> 'ACTIVE' AND settled_at >= $2 AND settled_at < $3
       UNION ALL
       SELECT total_bet AS amount, payout FROM blackjack_rounds
       WHERE user_id = $1 AND status = 'SETTLED' AND settled_at >= $2 AND settled_at < $3
       UNION ALL
       SELECT amount, payout FROM hilo_rounds
       WHERE user_id = $1 AND status <> 'ACTIVE' AND settled_at >= $2 AND settled_at < $3
       UNION ALL
       SELECT amount, payout FROM plinko_rounds
       WHERE user_id = $1 AND settled_at >= $2 AND settled_at < $3
     ) AS settled_bets`,
    [userId, window.start.toISOString(), window.end.toISOString()],
  );
  const totalBet = fromMinorUnits(toMinorUnits(String(row?.total_bet ?? 0)));
  const totalPayout = fromMinorUnits(toMinorUnits(String(row?.total_payout ?? 0)));

  return {
    totalBet,
    totalPayout,
    netProfit: sumMoney([totalPayout, -totalBet]),
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

  if (payouts.some(({ payout }) => !isMoney(payout) || payout < 0 || payout > MAX_ACCOUNT_BALANCE)) {
    throw new RangeError("Bet payout violates money policy");
  }

  for (const batch of chunkItems(payouts)) {
    const values: unknown[] = [];
    const rows = batch.map((item, index) => {
      const offset = index * 2;
      values.push(item.betId, minorUnitsToDecimal(toMinorUnits(item.payout)));
      return `($${offset + 1}::text, $${offset + 2}::numeric(20,2))`;
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
  const mines = await queryRow(executor, "SELECT COALESCE(SUM(maximum_payout), 0) AS exposure FROM mines_rounds WHERE user_id = $1 AND status = 'ACTIVE'", [userId]);
  const hilo = await queryRow(executor, "SELECT COALESCE(SUM(maximum_payout), 0) AS exposure FROM hilo_rounds WHERE user_id = $1 AND status = 'ACTIVE'", [userId]);
  const blackjack = await queryRow(executor, "SELECT COALESCE(SUM(maximum_payout), 0) AS exposure FROM blackjack_rounds WHERE user_id = $1 AND status = 'ACTIVE'", [userId]);
  return fromMinorUnits(toMinorUnits(String(blackjack?.exposure ?? 0)) + toMinorUnits(maximumPayout) + toMinorUnits(String(mines?.exposure ?? 0)) + toMinorUnits(String(hilo?.exposure ?? 0)));
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
