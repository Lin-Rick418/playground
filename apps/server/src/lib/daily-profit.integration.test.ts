import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getBusinessDayWindow } from "./business-day.js";

const shouldRun = process.env.RUN_DAILY_PROFIT_INTEGRATION_TESTS === "true";

describe("daily profit PostgreSQL aggregation", { skip: !shouldRun }, () => {
  let database: typeof import("./db.js");
  const userId = "daily-profit-player";
  const tableId = "daily-profit-table";

  before(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(databaseUrl, "DATABASE_URL is required for the integration test");

    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    assert.match(
      databaseName,
      /^baccarat_daily_profit_test_[a-z0-9_]+$/,
      "Refusing to run against a database without the baccarat_daily_profit_test_ prefix",
    );

    database = await import("./db.js");

    const existingTables = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_class
       WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
         AND relkind = 'r'
         AND relname IN ('game_tables', 'users', 'game_rounds', 'bets', 'balance_adjustments')`,
    );
    assert.equal(existingTables.rows[0]?.count, "0", "Integration test database must start empty");

    await database.initializeDatabase();

    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    await database.pool.query(
      `INSERT INTO game_tables (id, code, name, display_order, min_bet, max_bet, created_at)
       VALUES ($1, 'D01', 'Daily profit table', 1, 100, 10000, $2)`,
      [tableId, createdAt],
    );
    await database.pool.query(
      `INSERT INTO users (id, username, password_hash, role, balance, created_at, updated_at)
       VALUES ($1, 'daily_profit_player', 'hash', 'PLAYER', 10000, $2, $2)`,
      [userId, createdAt],
    );
  });

  after(async () => {
    await database?.pool.end();
  });

  async function insertSettledBet(id: string, settledAt: Date, amount: number, payout: number) {
    const opensAt = new Date(settledAt.getTime() - 60_000);
    const closesAt = new Date(settledAt.getTime() - 1_000);

    await database.pool.query(
      `INSERT INTO game_rounds (
         id, table_id, player_total, banker_total, winner, status,
         betting_opens_at, betting_closes_at, settled_at, created_at
       ) VALUES ($1, $2, 1, 0, 'PLAYER', 'SETTLED', $3, $4, $5, $3)`,
      [id, tableId, opensAt, closesAt, settledAt],
    );
    await database.pool.query(
      `INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at)
       VALUES ($1, $2, $3, 'PLAYER', $4, $5, $6)`,
      [`bet-${id}`, userId, id, amount, payout, opensAt],
    );
  }

  it("aggregates every settled bet in [day start, next day start), independent of history LIMIT 20", async () => {
    const window = getBusinessDayWindow(new Date("2026-07-16T04:00:00.000Z"), "Asia/Taipei");

    for (let index = 0; index < 25; index += 1) {
      await insertSettledBet(`inside-${index}`, new Date(window.start.getTime() + index * 60_000), 100, 120);
    }

    await insertSettledBet("before-window", new Date(window.start.getTime() - 1), 1000, 9000);
    await insertSettledBet("at-window-end", window.end, 2000, 10000);

    const [profit, recentHistory] = await Promise.all([
      database.getUserDailyProfit(userId, window),
      database.listUserHistory(userId),
    ]);

    assert.equal(recentHistory.length, 20);
    assert.deepEqual(profit, {
      totalBet: 2500,
      totalPayout: 3000,
      netProfit: 500,
    });
  });
});
