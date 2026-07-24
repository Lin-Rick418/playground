import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import bcrypt from "bcryptjs";
import { createApp } from "../../src/app.js";
import { calculatePayout, type TableShoeState } from "../../src/lib/baccarat.js";
import { applyBalanceMutation, pool, replaceTableShoe, withTransaction } from "../../src/lib/db.js";
import { runMigrations } from "../../src/lib/migration-runner.js";
import { settleActiveRound } from "../../src/lib/round-manager.js";
import { runRetentionCleanup } from "../../src/lib/retention.js";
import { authRefreshRateLimitPolicy } from "../../src/lib/endpoint-rate-limit.js";

type TestUser = {
  id: string;
  username: string;
  password: string;
  role: "ADMIN" | "PLAYER";
  balance: number;
};

let server: Server;
let baseUrl: string;
const runId = randomUUID().slice(0, 8);
let nextDisplayOrder = 100;

function createTestApp() {
  return createApp();
}

async function insertUser(input: {
  username: string;
  password?: string;
  role?: TestUser["role"];
  balance?: number;
  isActive?: boolean;
}): Promise<TestUser> {
  const user: TestUser = {
    id: randomUUID(),
    username: input.username,
    password: input.password ?? "password123",
    role: input.role ?? "PLAYER",
    balance: input.balance ?? 0,
  };
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO users (
       id, username, password_hash, role, is_active, balance, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 0, $6, $6)`,
    [
      user.id,
      user.username,
      await bcrypt.hash(user.password, 4),
      user.role,
      input.isActive ?? true,
      now,
    ],
  );

  if (user.balance > 0) {
    await withTransaction(async (client) => {
      await applyBalanceMutation(
        {
          userId: user.id,
          delta: user.balance,
          actorType: "SYSTEM",
          source: "INITIAL_FUNDING",
          referenceType: "USER",
          referenceId: user.id,
          metadata: { integrationTest: true },
        },
        client,
      );
    });
  }

  return user;
}

async function insertTable(shoe?: { shoeId: string; state: TableShoeState }) {
  const tableId = randomUUID();
  const now = new Date().toISOString();

  await pool.query(
     `INSERT INTO game_tables (
       id, code, name, display_order, round_duration_ms, round_phase_offset_ms,
       round_schedule_version, min_bet, max_bet, current_shoe_id, shoe_state, created_at
     ) VALUES ($1, $2, $3, $4, 30000, 0, 1, 100, 5000, $5, $6::jsonb, $7)`,
    [
      tableId,
      `T-${tableId.slice(0, 8)}`,
      "Integration Table",
      nextDisplayOrder++,
      shoe?.shoeId ?? "",
      JSON.stringify(shoe?.state ?? {}),
      now,
    ],
  );

  return tableId;
}

async function insertRound(input: {
  tableId: string;
  shoeId?: string;
  status: "OPEN" | "LOCKED";
}) {
  const roundId = randomUUID();
  const now = Date.now();

  await pool.query(
    `INSERT INTO game_rounds (
       id, table_id, shoe_id, player_cards, banker_cards, player_total, banker_total,
       winner, player_pair, banker_pair, status, betting_opens_at, betting_closes_at,
       settled_at, created_at
     ) VALUES (
       $1, $2, $3, '[]'::jsonb, '[]'::jsonb, 0, 0,
       'TIE', FALSE, FALSE, $4, $5, $6, NULL, $7
     )`,
    [
      roundId,
      input.tableId,
      input.shoeId ?? "shoe-integration",
      input.status,
      new Date(now - 1_000).toISOString(),
      new Date(now + 60_000).toISOString(),
      new Date(now).toISOString(),
    ],
  );

  return roundId;
}

async function insertSettledHistoryRound(input: {
  tableId: string;
  userId: string;
  createdAt: Date;
  settledAt: Date;
}) {
  const roundId = randomUUID();
  const betId = randomUUID();
  await pool.query(
    `INSERT INTO game_rounds (
       id, table_id, shoe_id, player_cards, banker_cards, player_total, banker_total,
       winner, player_pair, banker_pair, status, betting_opens_at, betting_closes_at,
       settled_at, created_at
     ) VALUES (
       $1, $2, 'history-shoe', '[]'::jsonb, '[]'::jsonb, 0, 0,
       'TIE', FALSE, FALSE, 'SETTLED', $3, $4, $5, $3
     )`,
    [
      roundId,
      input.tableId,
      input.createdAt.toISOString(),
      new Date(input.createdAt.getTime() + 1_000).toISOString(),
      input.settledAt.toISOString(),
    ],
  );
  await pool.query(
    `INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at)
     VALUES ($1, $2, $3, 'TIE', 100, 0, $4)`,
    [betId, input.userId, roundId, input.createdAt.toISOString()],
  );
  return roundId;
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

async function login(user: TestUser) {
  const response = await request<{ token: string }>("/auth/login", {
    method: "POST",
    body: { username: user.username, password: user.password },
  });

  assert.equal(response.status, 200);
  assert.ok(response.body.token);
  return response.body.token;
}

before(async () => {
  await runMigrations(pool);
  server = createServer(createTestApp());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await pool.end();
});

test("HTTP auth accepts players and removes the admin surface", async () => {
  const admin = await insertUser({ username: `admin_ci_${runId}`, role: "ADMIN" });
  const player = await insertUser({ username: `player_ci_${runId}`, balance: 1_000 });
  const playerToken = await login(player);

  const adminLogin = await request<{ code: string; message: string }>("/auth/login", {
    method: "POST",
    body: { username: admin.username, password: admin.password },
  });
  assert.equal(adminLogin.status, 403);
  assert.equal(adminLogin.body.code, "FORBIDDEN");

  const unknownLogin = await request<{ message: string }>("/auth/login", {
    method: "POST",
    body: { username: `missing_${runId}`, password: "wrong" },
  });
  assert.equal(unknownLogin.status, 401);
  assert.equal(unknownLogin.body.message, "Invalid credentials");

  const me = await request<{ id: string; balance: number }>("/auth/me", {
    token: playerToken,
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.id, player.id);
  assert.equal(me.body.balance, 1_000);

  const removedAdminRoute = await request<{ code: string; message: string }>("/admin/users", {
    token: playerToken,
  });
  assert.equal(removedAdminRoute.status, 404);
  assert.equal(removedAdminRoute.body.code, "NOT_FOUND");
});

test("a later login replaces the player's earlier session", async () => {
  const player = await insertUser({ username: `session_${runId}` });
  const firstToken = await login(player);
  const secondToken = await login(player);

  const [firstSession, secondSession, activeSessions] = await Promise.all([
    request<{ code: string }>("/auth/me", { token: firstToken }),
    request<{ id: string }>("/auth/me", { token: secondToken }),
    pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [player.id],
    ),
  ]);

  assert.equal(firstSession.status, 401);
  assert.equal(firstSession.body.code, "INVALID_TOKEN");
  assert.equal(secondSession.status, 200);
  assert.equal(secondSession.body.id, player.id);
  assert.equal(activeSessions.rows[0]?.count, "1");
});

test("inactive tables are hidden from the lobby and direct table routes", async () => {
  const player = await insertUser({ username: `inactive_ci_${runId}` });
  const tableId = await insertTable();
  await pool.query("UPDATE game_tables SET is_active = FALSE WHERE id = $1", [tableId]);
  const token = await login(player);

  const lobby = await request<{ tables: Array<{ table: { id: string } }> }>("/game/lobby", { token });
  assert.equal(lobby.status, 200);
  assert.equal(lobby.body.tables.some(({ table }) => table.id === tableId), false);

  const state = await request<{ code: string }>(`/game/tables/${tableId}/state`, { token });
  assert.equal(state.status, 404);
  assert.equal(state.body.code, "NOT_FOUND");
});

test("bet placement debits exactly once and insufficient balance rolls back", async () => {
  const player = await insertUser({ username: `bettor_ci_${runId}`, balance: 1_000 });
  const tableId = await insertTable();
  await insertRound({ tableId, status: "OPEN" });
  const token = await login(player);
  const placedIdempotencyKey = randomUUID();
  const placedPayload = {
    bets: [
      { betType: "PLAYER", amount: 100 },
      { betType: "BANKER", amount: 200 },
    ],
  };

  const placed = await request<{ balance: number; bets: unknown[] }>(
    `/game/tables/${tableId}/bet`,
    {
      method: "POST",
      token,
      body: placedPayload,
      headers: { "idempotency-key": placedIdempotencyKey },
    },
  );
  assert.equal(placed.status, 200);
  assert.equal(placed.body.balance, 700);
  assert.equal(placed.body.bets.length, 2);

  const rejected = await request<{ code: string; message: string; requestId: string }>(`/game/tables/${tableId}/bet`, {
    method: "POST",
    token,
    body: { bets: [{ betType: "TIE", amount: 800 }] },
    headers: {
      "idempotency-key": randomUUID(),
      "x-request-id": "integration-insufficient-balance",
    },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "VALIDATION_ERROR");
  assert.equal(rejected.body.message, "Insufficient balance");
  assert.equal(rejected.body.requestId, "integration-insufficient-balance");

  const staleIdempotencyKey = randomUUID();
  const staleSessionId = randomUUID();
  const staleAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
  await pool.query(
    `INSERT INTO idempotency_keys (
       actor_id, scope, idempotency_key, request_hash, status_code,
       response_json, created_at, completed_at
     ) VALUES ($1, 'integration.stale', $2, 'stale-hash', 200, '{}'::jsonb, $3, $3)`,
    [player.id, staleIdempotencyKey, staleAt],
  );
  await pool.query(
    `INSERT INTO auth_sessions (
       id, user_id, refresh_token_hash, expires_at, revoked_at, created_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $4, $4, $4)`,
    [staleSessionId, player.id, `stale-${randomUUID()}`, staleAt],
  );

  const cleanup = await runRetentionCleanup({
    idempotencyRetentionDays: 7,
    authSessionRetentionDays: 30,
    batchSize: 1,
  });
  assert.ok(cleanup.idempotencyKeys >= 1);
  assert.ok(cleanup.authSessions >= 1);
  const staleRows = await pool.query<{ idempotency_count: string; session_count: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM idempotency_keys WHERE idempotency_key = $1) AS idempotency_count,
       (SELECT COUNT(*)::text FROM auth_sessions WHERE id = $2) AS session_count`,
    [staleIdempotencyKey, staleSessionId],
  );
  assert.deepEqual(staleRows.rows[0], { idempotency_count: "0", session_count: "0" });

  const replayed = await request<{ balance: number; bets: unknown[] }>(
    `/game/tables/${tableId}/bet`,
    {
      method: "POST",
      token,
      body: placedPayload,
      headers: { "idempotency-key": placedIdempotencyKey },
    },
  );
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.balance, 700);
  assert.equal(replayed.body.bets.length, 2);

  const persisted = await pool.query<{ balance: number; bet_count: string; staked: string }>(
    `SELECT u.balance, COUNT(b.id)::text AS bet_count,
            COALESCE(SUM(b.amount), 0)::text AS staked
     FROM users u
     LEFT JOIN bets b ON b.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [player.id],
  );
  assert.deepEqual(persisted.rows[0], {
    balance: 700,
    bet_count: "2",
    staked: "300",
  });
});

test("history cursor pagination returns every settled round once in stable order", async () => {
  const player = await insertUser({ username: `history_ci_${runId}` });
  const tableId = await insertTable();
  const token = await login(player);
  const baseTime = Date.now() - 300_000;

  for (let index = 0; index < 23; index += 1) {
    await insertSettledHistoryRound({
      tableId,
      userId: player.id,
      createdAt: new Date(baseTime + index * 1_000),
      settledAt: new Date(baseTime + 60_000 + Math.floor(index / 3) * 5_000),
    });
  }

  const receivedIds: string[] = [];
  let cursor: string | null = null;
  do {
    const suffix: string = cursor
      ? `?limit=7&cursor=${encodeURIComponent(cursor)}`
      : "?limit=7";
    const page: {
      status: number;
      body: {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
    } = await request<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
    }>(`/game/history${suffix}`, { token });
    assert.equal(page.status, 200);
    assert.ok(page.body.items.length > 0 && page.body.items.length <= 7);
    receivedIds.push(...page.body.items.map((item) => item.id));
    cursor = page.body.nextCursor;
  } while (cursor);

  const expected = await pool.query<{ id: string }>(
    `SELECT g.id
     FROM game_rounds g
     JOIN bets b ON b.round_id = g.id AND b.user_id = $1
     WHERE g.status = 'SETTLED'
     ORDER BY g.settled_at DESC, g.created_at DESC, g.id DESC`,
    [player.id],
  );
  assert.deepEqual(receivedIds, expected.rows.map(({ id }) => id));
  assert.equal(new Set(receivedIds).size, 23);

  const invalidLimit = await request<{ code: string }>("/game/history?limit=51", { token });
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.body.code, "VALIDATION_ERROR");
  const invalidCursor = await request<{ code: string }>("/game/history?cursor=bm90LWpzb24", { token });
  assert.equal(invalidCursor.status, 400);
  assert.equal(invalidCursor.body.code, "VALIDATION_ERROR");
});

test("settlement credits the calculated payout once and only once", async () => {
  const player = await insertUser({ username: `settlement_ci_${runId}`, balance: 1_000 });
  const tableId = await insertTable();
  const shoeId = (await replaceTableShoe(tableId)).shoeId;
  const roundId = await insertRound({ tableId, shoeId, status: "LOCKED" });
  const betId = randomUUID();

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO bets (id, user_id, round_id, bet_type, amount, payout, created_at)
       VALUES ($1, $2, $3, 'PLAYER', 100, 0, $4)`,
      [betId, player.id, roundId, new Date().toISOString()],
    );
    await applyBalanceMutation(
      {
        userId: player.id,
        delta: -100,
        actorType: "PLAYER",
        actorId: player.id,
        source: "BET_DEBIT",
        referenceType: "BET",
        referenceId: betId,
      },
      client,
    );
  });

  await settleActiveRound(roundId, tableId);

  const result = await pool.query<{
    balance: number;
    payout: number;
    status: string;
    winner: "PLAYER" | "BANKER" | "TIE";
    player_pair: boolean;
    banker_pair: boolean;
  }>(
    `SELECT u.balance, b.payout, g.status, g.winner, g.player_pair, g.banker_pair
     FROM users u
     JOIN bets b ON b.user_id = u.id
     JOIN game_rounds g ON g.id = b.round_id
     WHERE u.id = $1 AND b.id = $2`,
    [player.id, betId],
  );
  const row = result.rows[0];
  const expectedPayout = calculatePayout("PLAYER", 100, {
    winner: row.winner,
    playerPair: row.player_pair,
    bankerPair: row.banker_pair,
  });

  assert.equal(row.status, "SETTLED");
  assert.equal(row.payout, expectedPayout);
  assert.equal(row.balance, 900 + expectedPayout);

  await settleActiveRound(roundId, tableId);
  const afterRetry = await pool.query<{ balance: number; payout: number }>(
    `SELECT u.balance, b.payout
     FROM users u JOIN bets b ON b.user_id = u.id
     WHERE u.id = $1 AND b.id = $2`,
    [player.id, betId],
  );
  assert.deepEqual(afterRetry.rows[0], {
    balance: row.balance,
    payout: row.payout,
  });

  const token = await login(player);
  const history = await request<{
    items: Array<{ id: string; round: { id: string } }>;
    nextCursor: string | null;
  }>("/game/history", { token });
  assert.equal(history.status, 200);
  assert.equal(history.body.items.some((item) => item.id === roundId && item.round.id === roundId), true);

  const dailyProfit = await request<{
    formula: string;
    recognitionTime: string;
    totalBet: number;
    totalPayout: number;
    netProfit: number;
  }>("/game/daily-profit", { token });
  assert.equal(dailyProfit.status, 200);
  assert.equal(dailyProfit.body.formula, "TOTAL_PAYOUT_MINUS_TOTAL_BET");
  assert.equal(dailyProfit.body.recognitionTime, "ROUND_SETTLED_AT");
  assert.equal(dailyProfit.body.totalBet, 100);
  assert.equal(dailyProfit.body.totalPayout, expectedPayout);
  assert.equal(dailyProfit.body.netProfit, dailyProfit.body.totalPayout - dailyProfit.body.totalBet);

  const audit = await request<{ shoeId: string; commitment: string; reveal: unknown }>(
    `/game/shoes/${shoeId}/audit`,
    { token },
  );
  assert.equal(audit.status, 200);
  assert.equal(audit.body.shoeId, shoeId);
  assert.match(audit.body.commitment, /^[0-9a-f]{64}$/);
  assert.equal(audit.body.reveal, null);
});

test("change-password rate limits repeated wrong current-password attempts", async () => {
  const player = await insertUser({ username: `pwbrute_${runId}`, password: "CorrectHorse!2026" });
  const token = await login(player);
  const clientIp = "203.0.113.71";

  async function attempt(currentPassword: string) {
    return request<{ code: string }>("/auth/change-password", {
      method: "POST",
      token,
      headers: { "x-forwarded-for": clientIp },
      body: { currentPassword, newPassword: "AnotherStrong!2026" },
    });
  }

  // ACCOUNT_IP hard-blocks after 5 failures: the first four are plain 401s.
  for (let i = 0; i < 4; i += 1) {
    const rejected = await attempt("WrongGuess!2026");
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.code, "INVALID_CREDENTIALS");
  }

  const limited = await attempt("WrongGuess!2026");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");

  // Once blocked, even the correct current password is refused up front.
  const blockedWithCorrect = await attempt("CorrectHorse!2026");
  assert.equal(blockedWithCorrect.status, 429);
  assert.equal(blockedWithCorrect.body.code, "RATE_LIMITED");

  // A different client IP for the same account is not collaterally blocked
  // below the account-wide threshold.
  const otherIp = await request<{ code: string }>("/auth/change-password", {
    method: "POST",
    token,
    headers: { "x-forwarded-for": "203.0.113.99" },
    body: { currentPassword: "WrongGuess!2026", newPassword: "AnotherStrong!2026" },
  });
  assert.equal(otherIp.status, 401);
});

test("refresh rate limits unauthenticated floods per client IP", async () => {
  const clientIp = "203.0.113.72";

  async function refresh() {
    return request<{ code: string }>("/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": clientIp },
    });
  }

  for (let i = 0; i < authRefreshRateLimitPolicy.maxRequests; i += 1) {
    const response = await refresh();
    assert.equal(response.status, 401, `request ${i + 1} should pass the limiter`);
  }

  const limited = await refresh();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");

  // A different IP still has its own budget.
  const otherIp = await request<{ code: string }>("/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.98" },
  });
  assert.equal(otherIp.status, 401);
});
