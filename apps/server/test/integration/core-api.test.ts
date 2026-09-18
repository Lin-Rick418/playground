import { fingerprintIdempotencyRequest } from "../../src/lib/idempotency.js";
import { claimIdempotencyKey, completeIdempotencyKey } from "../../src/lib/repositories/idempotency-store.js";
import { hiloMutationResponseSchema, hiloCommandResultSchema, type HiloPreview, type HiloAction, type HiloRound, type HiloCommandResult } from "@baccarat/contracts";
import { mutateHilo, findHiloRound, hiloHistory } from "../../src/modules/hilo/service.js";
import { rank, payout as hiloPayout } from "../../src/modules/hilo/math.js";
import { mutateMines } from "../../src/modules/mines/service.js";
import { placePlinkoBet, publicPlinkoRound } from "../../src/modules/plinko/service.js";
import { getUserDailyProfit, getUserUnsettledMaximumPayout } from "../../src/lib/db.js";
import { plinkoCommandResultSchema, type PlinkoCommand, type PlinkoCommandResult } from "@baccarat/contracts";
import { WebSocket } from "ws";
import { once } from "node:events";
import { attachLiveWebSocketServer } from "../../src/lib/live-ws.js";
import { minesCommandResultSchema, type MinesCommand, type MinesCommandResult } from "@baccarat/contracts";
import { type PlinkoMutationResponse, type PlinkoConfig, type PlinkoRound, plinkoMutationResponseSchema } from "@baccarat/contracts";
import { getPlinkoTable, plinkoPayout, plinkoV1Tables, PLINKO_RULE_VERSION } from "../../src/modules/plinko/math.js";
import { plinkoRateLimitKey } from "../../src/modules/plinko/service.js";
import { migrationDefinitions } from "../../src/migrations/index.js";
import { type MinesRound, sumMoney } from "@baccarat/contracts";
import { env } from "../../src/config/env.js";
import { minesPayout } from "../../src/modules/mines/math.js";
import { reconcileUserBalance } from "../../src/lib/db.js";
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
import { assertCoreApiIntegrationDatabaseUrl } from "../../src/lib/integration-database-safety.js";

assertCoreApiIntegrationDatabaseUrl(process.env.DATABASE_URL);

type TestUser = {
  id: string;
  username: string;
  password: string;
  role: "ADMIN" | "PLAYER";
  balance: number;
};

let server: Server;
let baseUrl: string;
let stopLive: (() => Promise<void>) | undefined;
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

async function insertRound(input: { tableId: string; shoeId?: string; status: "OPEN" | "LOCKED" }) {
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
  const existingTables = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_class
     WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
       AND relkind = 'r'`,
  );
  assert.equal(
    existingTables.rows[0]?.count,
    "0",
    "Core API integration database must start empty",
  );
  await runMigrations(
    pool,
    migrationDefinitions.filter((migration) => migration.version < 10),
  );
  await pool.query(`INSERT INTO users(id,username,password_hash,role,is_active,balance,created_at,updated_at)
    VALUES ('legacy-money-test','legacy_money_test','unused','PLAYER',true,1000,NOW(),NOW());
    INSERT INTO financial_ledger_entries(id,user_id,actor_type,source,reference_type,reference_id,delta,balance_before,balance_after,created_at)
    VALUES ('legacy-money-entry','legacy-money-test','SYSTEM','LEGACY_OPENING_BALANCE','USER','legacy-money-test',1000,0,1000,NOW());`);
  await runMigrations(pool);
  server = createServer(createTestApp());
  stopLive = await attachLiveWebSocketServer(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await stopLive?.();
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

  const lobby = await request<{ tables: Array<{ table: { id: string } }> }>("/game/lobby", {
    token,
  });
  assert.equal(lobby.status, 200);
  assert.equal(
    lobby.body.tables.some(({ table }) => table.id === tableId),
    false,
  );

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

  const rejected = await request<{ code: string; message: string; requestId: string }>(
    `/game/tables/${tableId}/bet`,
    {
      method: "POST",
      token,
      body: { bets: [{ betType: "TIE", amount: 800 }] },
      headers: {
        "idempotency-key": randomUUID(),
        "x-request-id": "integration-insufficient-balance",
      },
    },
  );
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
    balance: "700.00",
    bet_count: "2",
    staked: "300.00",
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
    const suffix: string = cursor ? `?limit=7&cursor=${encodeURIComponent(cursor)}` : "?limit=7";
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
  assert.deepEqual(
    receivedIds,
    expected.rows.map(({ id }) => id),
  );
  assert.equal(new Set(receivedIds).size, 23);

  const invalidLimit = await request<{ code: string }>("/game/history?limit=51", { token });
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.body.code, "VALIDATION_ERROR");
  const invalidCursor = await request<{ code: string }>("/game/history?cursor=bm90LWpzb24", {
    token,
  });
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
  assert.equal(Number(row.payout), expectedPayout);
  assert.equal(Number(row.balance), 900 + expectedPayout);

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
  assert.equal(
    history.body.items.some((item) => item.id === roundId && item.round.id === roundId),
    true,
  );

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
  assert.equal(
    dailyProfit.body.netProfit,
    dailyProfit.body.totalPayout - dailyProfit.body.totalBet,
  );

  const audit = await request<{ shoeId: string; commitment: string; reveal: unknown }>(
    `/game/shoes/${shoeId}/audit`,
    { token },
  );
  assert.equal(audit.status, 200);
  assert.equal(audit.body.shoeId, shoeId);
  assert.match(audit.body.commitment, /^[0-9a-f]{64}$/);
  assert.equal(audit.body.reveal, null);
});

test("change-password accepts six-character alphanumeric passwords and revokes the previous session", async () => {
  const player = await insertUser({ username: `pwpolicy_${runId}`, password: "Previous!Secure2026" });
  const token = await login(player);
  for (const newPassword of ["ab123", "abcdef", "123456"]) {
    const rejected = await request<{ code: string }>("/auth/change-password", {
      method: "POST", token, body: { currentPassword: player.password, newPassword },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, "VALIDATION_ERROR");
  }
  const changed = await request<{ token: string }>("/auth/change-password", {
    method: "POST", token, body: { currentPassword: player.password, newPassword: "abc123" },
  });
  assert.equal(changed.status, 200);
  assert.equal((await request("/auth/me", { token: changed.body.token })).status, 200);
  assert.equal((await request("/auth/me", { token })).status, 401);
  const oldLogin = await request("/auth/login", {
    method: "POST", body: { username: player.username, password: player.password },
  });
  assert.equal(oldLogin.status, 401);
  await login({ ...player, password: "abc123" });
  const stored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id=$1", [player.id]);
  assert.equal(bcrypt.getRounds(stored.rows[0]!.password_hash), 12);
  assert.equal(await bcrypt.compare("abc123", stored.rows[0]!.password_hash), true);
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

type MinesMutation = { round: MinesRound; balance: number };
async function minesPost(token: string, path: string, body: unknown, key = randomUUID()) {
  return request<MinesMutation>(`/mines${path}`, {
    method: "POST",
    token,
    body,
    headers: { "idempotency-key": key },
  });
}
async function minesBoard(id: string): Promise<number[]> {
  return (await pool.query("SELECT mine_cells FROM mines_rounds WHERE id = $1", [id])).rows[0]
    .mine_cells;
}

test("Mines HTTP validation, private board, restore, fractional cashout and durable replay", async () => {
  const user = await insertUser({ username: `mines_basic_${runId}`, balance: 1000.75 });
  let token = await login(user);
  assert.equal((await request("/mines/config")).status, 401);
  const config = await request<{ maxBet: number }>("/mines/config", { token });
  assert.equal(config.body.maxBet, 5000);
  for (const mineCount of [1, 2])
    assert.equal((await minesPost(token, "/rounds", { amount: 100, mineCount })).status, 400);
  for (const amount of [0, 99, 150, 5100, 100.01])
    assert.equal((await minesPost(token, "/rounds", { amount, mineCount: 3 })).status, 400);
  assert.equal((await minesPost(token, "/rounds", { amount: 100, mineCount: 25 })).status, 400);
  assert.equal(
    (await request("/mines/rounds", { method: "POST", token, body: { amount: 100, mineCount: 3 } }))
      .status,
    400,
  );
  const key = randomUUID();
  const started = await minesPost(token, "/rounds", { amount: 100, mineCount: 3 }, key);
  assert.equal(started.status, 200);
  assert.equal(started.body.balance, 900.75);
  assert.equal(started.body.round.mineCells, null);
  const id = started.body.round.id;
  assert.equal((await minesPost(token, "/rounds", { amount: 200, mineCount: 3 }, key)).status, 409);
  assert.equal((await minesPost(token, `/rounds/${id}/cashout`, {})).status, 409);
  assert.equal((await minesPost(token, "/rounds", { amount: 100, mineCount: 3 })).status, 409);
  token = await login(user);
  const restored = await request<{ round: MinesRound }>("/mines/active", { token });
  assert.equal(restored.body.round.id, id);
  const board = await minesBoard(id);
  const cell = Array.from({ length: 25 }, (_, i) => i).find((i) => !board.includes(i))!;
  const revealKey = randomUUID();
  const revealed = await minesPost(token, `/rounds/${id}/reveal`, { cellIndex: cell }, revealKey);
  assert.equal(revealed.body.round.cashoutAmount, 107.95);
  assert.equal(revealed.body.round.mineCells, null);
  assert.deepEqual(
    await minesPost(token, `/rounds/${id}/reveal`, { cellIndex: cell }, revealKey),
    revealed,
  );
  assert.equal((await minesPost(token, `/rounds/${id}/reveal`, { cellIndex: cell })).status, 409);
  const paid = await minesPost(token, `/rounds/${id}/cashout`, {});
  assert.equal(paid.body.balance, 1008.7);
  assert.equal(paid.body.round.status, "CASHED_OUT");
  assert.equal(paid.body.round.payout, 107.95);
  assert.deepEqual(paid.body.round.mineCells, board);
  assert.equal((await minesPost(token, `/rounds/${id}/cashout`, {})).status, 409);
  await pool.query(
    "UPDATE idempotency_keys SET created_at=NOW()-interval '30 days' WHERE actor_id=$1 AND idempotency_key=$2",
    [user.id, key],
  );
  await runRetentionCleanup({ idempotencyRetentionDays: 7, authSessionRetentionDays: 30 });
  assert.deepEqual(await minesPost(token, "/rounds", { amount: 100, mineCount: 3 }, key), started);
  assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, 1008.7);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  const daily = await request<{ totalBet: number; totalPayout: number; netProfit: number }>(
    "/game/daily-profit",
    { token },
  );
  assert.equal(daily.body.netProfit, 7.95);
  const tableId = await insertTable();
  await insertSettledHistoryRound({
    tableId,
    userId: user.id,
    createdAt: new Date(Date.now() - 2000),
    settledAt: new Date(),
  });
  const combined = await request<{ totalBet: number; totalPayout: number; netProfit: number }>(
    "/game/daily-profit",
    { token },
  );
  assert.equal(combined.body.totalBet, 200);
  assert.equal(combined.body.totalPayout, 107.95);
  assert.equal(combined.body.netProfit, -92.05);
  const history = await request<{ items: MinesRound[] }>("/mines/history?limit=1", { token });
  assert.equal(history.body.items[0]?.id, id);
});

test("Mines owner authorization, mine hit, all-safe auto-cashout and disabled new games", async () => {
  const user = await insertUser({ username: `mines_end_${runId}`, balance: 10000 });
  const other = await insertUser({ username: `mines_other_${runId}`, balance: 1000 });
  const token = await login(user),
    otherToken = await login(other);
  const start = await minesPost(token, "/rounds", { amount: 5000, mineCount: 3 });
  assert.equal(start.status, 200);
  const id = start.body.round.id;
  assert.equal((await request(`/mines/rounds/${id}`, { token: otherToken })).status, 404);
  assert.equal((await minesPost(otherToken, `/rounds/${id}/reveal`, { cellIndex: 0 })).status, 404);
  const board = await minesBoard(id);
  const lost = await minesPost(token, `/rounds/${id}/reveal`, { cellIndex: board[0] });
  assert.equal(lost.body.round.status, "LOST");
  assert.equal(lost.body.balance, 5000);
  assert.equal(lost.body.round.payout, 0);
  const active = await minesPost(token, "/rounds", { amount: 100, mineCount: 24 });
  const fullBoard = await minesBoard(active.body.round.id);
  const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !fullBoard.includes(i))!;
  const original = env.minesEnabled;
  env.minesEnabled = false;
  try {
    assert.equal(
      (await minesPost(otherToken, "/rounds", { amount: 100, mineCount: 3 })).status,
      503,
    );
    const won = await minesPost(token, `/rounds/${active.body.round.id}/reveal`, {
      cellIndex: safe,
    });
    assert.equal(won.body.round.status, "CASHED_OUT");
    assert.equal(won.body.round.payout, 2375);
    assert.equal(won.body.balance, 7275);
  } finally {
    env.minesEnabled = original;
  }
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("shared wallet serializes simultaneous baccarat/Mines bets and cashout/reveal races", async () => {
  const user = await insertUser({ username: `mines_race_${runId}`, balance: 100.75 });
  const token = await login(user);
  const tableId = await insertTable();
  await insertRound({ tableId, status: "OPEN" });
  const results = await Promise.all([
    minesPost(token, "/rounds", { amount: 100, mineCount: 3 }),
    request("/game/tables/" + tableId + "/bet", {
      method: "POST",
      token,
      body: { bets: [{ betType: "PLAYER", amount: 100 }] },
      headers: { "idempotency-key": randomUUID() },
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, 0.75);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  const rich = await insertUser({ username: `mines_rich_${runId}`, balance: 1000 });
  const richToken = await login(rich);
  const attempts = await Promise.all([
    minesPost(richToken, "/rounds", { amount: 100, mineCount: 3 }),
    minesPost(richToken, "/rounds", { amount: 100, mineCount: 3 }),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const id = attempts.find((r) => r.status === 200)!.body.round.id;
  const board = await minesBoard(id);
  const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !board.includes(i))!;
  await minesPost(richToken, `/rounds/${id}/reveal`, { cellIndex: safe });
  const race = await Promise.all([
    minesPost(richToken, `/rounds/${id}/cashout`, {}),
    minesPost(richToken, `/rounds/${id}/reveal`, { cellIndex: board[0] }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const row = (await pool.query("SELECT status,payout FROM mines_rounds WHERE id=$1", [id]))
    .rows[0];
  assert.equal(
    (await request<{ balance: number }>("/auth/me", { token: richToken })).body.balance,
    sumMoney([900, Number(row.payout)]),
  );
  assert.equal((await reconcileUserBalance(rich.id))?.isReconciled, true);
});

test("cross-game payout exposure rejects before debit and fractions survive baccarat refunds", async () => {
  const user = await insertUser({ username: `mines_limit_${runId}`, balance: 1999999000.75 });
  const token = await login(user);
  const fail = await minesPost(token, "/rounds", { amount: 100, mineCount: 12 });
  assert.equal(fail.status, 400);
  assert.equal(
    (await request<{ balance: number }>("/auth/me", { token })).body.balance,
    1999999000.75,
  );
  const small = await insertUser({ username: `mines_frac_${runId}`, balance: 1000.75 });
  const smallToken = await login(small);
  const tableId = await insertTable();
  const roundId = await insertRound({ tableId, status: "OPEN" });
  const placed = await request<{ balance: number }>(`/game/tables/${tableId}/bet`, {
    method: "POST",
    token: smallToken,
    body: { bets: [{ betType: "PLAYER", amount: 100 }] },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.equal(placed.body.balance, 900.75);
  await pool.query("UPDATE game_rounds SET status='LOCKED' WHERE id=$1", [roundId]);
  await settleActiveRound(roundId, tableId); // Invalid test shoe refunds the entire stake.
  assert.equal(
    (await request<{ balance: number }>("/auth/me", { token: smallToken })).body.balance,
    1000.75,
  );
  assert.equal((await reconcileUserBalance(small.id))?.isReconciled, true);
});

test("Mines transaction rolls back ledger, wallet, round and key when persistence fails", async () => {
  const user = await insertUser({ username: `mines_rollback_${runId}`, balance: 1000.75 });
  const token = await login(user);
  const start = await minesPost(token, "/rounds", { amount: 100, mineCount: 3 });
  const id = start.body.round.id;
  const board = await minesBoard(id);
  const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !board.includes(i))!;
  await minesPost(token, `/rounds/${id}/reveal`, { cellIndex: safe });
  await pool.query(`CREATE FUNCTION fail_mines_test_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test persistence failure'; END $$;
    CREATE TRIGGER fail_mines_test_update BEFORE UPDATE ON mines_rounds FOR EACH ROW EXECUTE FUNCTION fail_mines_test_update();`);
  const key = randomUUID();
  try {
    assert.equal((await minesPost(token, `/rounds/${id}/cashout`, {}, key)).status, 500);
    assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, 900.75);
    assert.equal(
      (await request<{ round: MinesRound }>("/mines/active", { token })).body.round.id,
      id,
    );
    assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  } finally {
    await pool.query(
      "DROP TRIGGER fail_mines_test_update ON mines_rounds; DROP FUNCTION fail_mines_test_update();",
    );
  }
  const retry = await minesPost(token, `/rounds/${id}/cashout`, {}, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.round.payout, minesPayout(100, 3, 1));
});

test("decimal migration preserves old balances, ledger history and guarded cent mutations", async () => {
  const prior = (
    await pool.query("SELECT balance, balance_version FROM users WHERE id='legacy-money-test'")
  ).rows[0];
  assert.equal(prior.balance, "1000.00");
  assert.ok(Number(prior.balance_version) > 0);
  await withTransaction((client) =>
    applyBalanceMutation(
      {
        userId: "legacy-money-test",
        delta: 0.25,
        actorType: "SYSTEM",
        source: "INITIAL_FUNDING",
        referenceType: "USER",
        referenceId: "decimal-test",
      },
      client,
    ),
  );
  const after = (
    await pool.query("SELECT balance, balance_version FROM users WHERE id='legacy-money-test'")
  ).rows[0];
  assert.equal(after.balance, "1000.25");
  assert.ok(Number(after.balance_version) > Number(prior.balance_version));
  assert.equal((await reconcileUserBalance("legacy-money-test"))?.isReconciled, true);
  await assert.rejects(
    pool.query("UPDATE users SET balance=0 WHERE id='legacy-money-test'"),
    /must be journaled/,
  );
  const decimals = await pool.query(
    "SELECT numeric_scale FROM information_schema.columns WHERE table_name='users' AND column_name='balance'",
  );
  assert.equal(decimals.rows[0]?.numeric_scale, 2);
});

test("both games reserve the other's maximum payout before accepting a bet", async () => {
  const tableId = await insertTable();
  await insertRound({ tableId, status: "OPEN" });
  for (const first of ["mines", "baccarat"]) {
    const user = await insertUser({ username: `rsv_${first}_${runId}`, balance: 1999997500.75 });
    const token = await login(user);
    const baccarat = () =>
      request<{ balance: number }>(`/game/tables/${tableId}/bet`, {
        method: "POST",
        token,
        body: { bets: [{ betType: "TIE", amount: 100 }] },
        headers: { "idempotency-key": randomUUID() },
      });
    const mines = () => minesPost(token, "/rounds", { amount: 100, mineCount: 24 });
    assert.equal((await (first === "mines" ? mines() : baccarat())).status, 200);
    assert.equal((await (first === "mines" ? baccarat() : mines())).status, 400);
    assert.equal(
      (await request<{ balance: number }>("/auth/me", { token })).body.balance,
      1999997400.75,
    );
    assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  }
});

test("Mines history cursor returns all own terminal rounds once", async () => {
  const user = await insertUser({ username: `mines_pages_${runId}`, balance: 1000 });
  const token = await login(user);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const result = await minesPost(token, "/rounds", { amount: 100, mineCount: 24 });
    ids.push(result.body.round.id);
    const board = await minesBoard(result.body.round.id);
    await minesPost(token, `/rounds/${result.body.round.id}/reveal`, { cellIndex: board[0] });
  }
  const got: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { status: number; body: { items: MinesRound[]; nextCursor: string | null } } =
      await request<{ items: MinesRound[]; nextCursor: string | null }>(
        `/mines/history?limit=1${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
        { token },
      );
    assert.equal(page.status, 200);
    got.push(...page.body.items.map((r) => r.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.equal(new Set(got).size, 3);
  assert.deepEqual(got, [...ids].reverse());
  assert.equal((await request("/mines/history?limit=51", { token })).status, 400);
});

const plinkoBet = { amount: 100, rows: 16, risk: "medium", ruleVersion: PLINKO_RULE_VERSION };
function plinkoPost(token: string, body: unknown = plinkoBet, key = randomUUID()) {
  return request<PlinkoMutationResponse>("/plinko/rounds", {
    method: "POST", token, body, headers: { "idempotency-key": key },
  });
}

test("Plinko config, validation, atomic settlement, history, daily profit and durable replay", async () => {
  const user = await insertUser({ username: `plinko_main_${runId}`, balance: 10000.75 });
  const token = await login(user);
  const config = await request<PlinkoConfig>("/plinko/config", { token });
  assert.equal(config.status, 200);
  assert.equal(config.body.ruleVersion, 2);
  assert.equal(config.body.tables.length, 27);
  for (const table of config.body.tables) assert.ok(table.rtp >= .95 && table.rtp <= .96);
  assert.equal((await request("/plinko/config")).status, 401);
  for (const change of [{ amount: 101 }, { amount: 0 }, { rows: 7 }, { rows: 17 }, { risk: "expert" },
    { slotIndex: 0 }, { multiplier: 1000 }, { payout: 1000 }, { userId: user.id }])
    assert.equal((await plinkoPost(token, { ...plinkoBet, ...change })).status, 400);
  assert.equal((await request("/plinko/rounds", { token, method: "POST", body: plinkoBet })).status, 400);
  assert.equal((await plinkoPost(token, { ...plinkoBet, ruleVersion: 1 })).status, 409);
  const key = randomUUID();
  const placed = await plinkoPost(token, plinkoBet, key);
  assert.equal(placed.status, 200);
  assert.ok(plinkoMutationResponseSchema.safeParse(placed.body).success);
  const round = placed.body.round;
  assert.equal(round.ruleVersion, 2);
  const table = getPlinkoTable(round.rows, round.risk);
  assert.equal(round.path.length, 16);
  assert.equal(round.slotIndex, round.path.reduce<number>((sum, direction) => sum + direction, 0));
  assert.equal(round.multiplier, table.multipliers[round.slotIndex]);
  assert.equal(round.payout, plinkoPayout(100, table.units[round.slotIndex]!));
  assert.equal(placed.body.balance, sumMoney([user.balance, -100, round.payout]));
  assert.equal((await request<{ round: PlinkoRound }>(`/plinko/rounds/${round.id}`, { token })).body.round.id, round.id);
  const daily = await request<{ totalBet: number; totalPayout: number; netProfit: number }>("/game/daily-profit", { token });
  assert.equal(daily.body.totalBet, 100);
  assert.equal(daily.body.totalPayout, round.payout);
  assert.equal(daily.body.netProfit, sumMoney([round.payout, -100]));
  assert.equal((await plinkoPost(token, { ...plinkoBet, amount: 200 }, key)).status, 409);
  const later = await plinkoPost(token);
  assert.equal(later.status, 200);
  assert.ok(later.body.walletVersion > placed.body.walletVersion);
  await pool.query("UPDATE idempotency_keys SET created_at=NOW()-INTERVAL '20 days' WHERE actor_id=$1", [user.id]);
  await runRetentionCleanup({ idempotencyRetentionDays: 7, authSessionRetentionDays: 30 });
  const replay = await plinkoPost(token, plinkoBet, key);
  assert.deepEqual(replay.body, placed.body);
  assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, later.body.balance);
  const first = await request<{ items: PlinkoRound[]; nextCursor: string }>("/plinko/history?limit=1", { token });
  const second = await request<{ items: PlinkoRound[]; nextCursor: string | null }>(`/plinko/history?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { token });
  assert.equal(first.body.items[0]!.id, later.body.round.id);
  assert.equal(second.body.items[0]!.id, round.id);
  assert.equal(second.body.nextCursor, null);
  assert.equal((await request("/plinko/history?limit=51", { token })).status, 400);
  assert.equal((await request("/plinko/history?cursor=invalid", { token })).status, 400);
  const ledger = await pool.query("SELECT source FROM financial_ledger_entries WHERE reference_id=$1 ORDER BY entry_sequence", [round.id]);
  assert.deepEqual(ledger.rows.map((row) => row.source), ["PLINKO_BET_DEBIT", "PLINKO_SETTLEMENT_CREDIT"]);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Plinko authorizes ownership and replays accepted bets after disable or rate limiting", async () => {
  const user = await insertUser({ username: `plinko_auth_${runId}`, balance: 10000 });
  const other = await insertUser({ username: `plinko_other_${runId}`, balance: 1000 });
  const token = await login(user);
  const otherToken = await login(other);
  const key = randomUUID();
  const placed = await plinkoPost(token, plinkoBet, key);
  assert.equal(placed.status, 200);
  assert.equal((await request(`/plinko/rounds/${placed.body.round.id}`, { token: otherToken })).status, 404);
  assert.equal((await request("/plinko/rounds/not-a-uuid", { token })).status, 400);
  const rateKey = plinkoRateLimitKey(user.id);
  await pool.query("UPDATE login_rate_limits SET failures=239, expires_at=NOW()+INTERVAL '1 minute' WHERE scope=$1 AND key_hash=$2", [rateKey.scope, rateKey.keyHash]);
  assert.equal((await plinkoPost(token)).status, 200); // 240th is allowed.
  assert.equal((await plinkoPost(token)).status, 429);
  assert.deepEqual((await plinkoPost(token, plinkoBet, key)).body, placed.body);
  assert.equal((await plinkoPost(otherToken)).status, 200); // Different authenticated user has a separate quota.
  const original = env.plinkoEnabled;
  env.plinkoEnabled = false;
  try {
    assert.equal((await plinkoPost(token)).status, 503);
    assert.equal((await request<PlinkoConfig>("/plinko/config", { token })).body.enabled, false);
    assert.deepEqual((await plinkoPost(token, plinkoBet, key)).body, placed.body);
    assert.equal((await request(`/plinko/rounds/${placed.body.round.id}`, { token })).status, 200);
  } finally { env.plinkoEnabled = original; }
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Plinko serializes duplicate bets and the wallet with Mines and baccarat", async () => {
  const user = await insertUser({ username: `plinko_race_${runId}`, balance: 10000.75 });
  const token = await login(user);
  const key = randomUUID();
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => plinkoPost(token, plinkoBet, key)));
  for (const result of duplicates) { assert.equal(result.status, 200); assert.deepEqual(result.body, duplicates[0]!.body); }
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM plinko_rounds WHERE user_id=$1", [user.id]);
  assert.equal(count.rows[0].count, 1);
  const tableId = await insertTable();
  await insertRound({ tableId, status: "OPEN" });
  const races = await Promise.all([
    plinkoPost(token), minesPost(token, "/rounds", { amount: 100, mineCount: 3 }),
    request(`/game/tables/${tableId}/bet`, { method: "POST", token, body: { bets: [{ betType: "PLAYER", amount: 100 }] }, headers: { "idempotency-key": randomUUID() } }),
  ]);
  for (const result of races) assert.equal(result.status, 200);
  const plinkoRound = (races[0]!.body as PlinkoMutationResponse).round;
  assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance,
    sumMoney([duplicates[0]!.body.balance, -300, plinkoRound.payout]));
  const minesId = (races[1]!.body as MinesMutation).round.id;
  const mineCells = await minesBoard(minesId);
  const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !mineCells.includes(i))!;
  await minesPost(token, `/rounds/${minesId}/reveal`, { cellIndex: safe });
  const settlementRace = await Promise.all([plinkoPost(token), minesPost(token, `/rounds/${minesId}/cashout`, {})]);
  assert.ok(settlementRace.every((result) => result.status === 200));
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Plinko validates balance and reserved cross-game exposure before drawing", async () => {
  const poor = await insertUser({ username: `plinko_poor_${runId}`, balance: 99.99 });
  const poorToken = await login(poor);
  assert.equal((await plinkoPost(poorToken)).status, 400);
  assert.equal((await request<{ balance: number }>("/auth/me", { token: poorToken })).body.balance, 99.99);
  const rich = await insertUser({ username: `plinko_limit_${runId}`, balance: 1999999000.75 });
  const token = await login(rich);
  assert.equal((await plinkoPost(token, { ...plinkoBet, risk: "high" })).status, 400);
  assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, rich.balance);
  // Leave enough headroom for a low-risk Plinko alone, but not for its combination with an open pair bet.
  const reserved = await insertUser({ username: `plinko_exposure_${runId}`, balance: 1999997000 });
  const reservedToken = await login(reserved);
  const tableId = await insertTable();
  await insertRound({ tableId, status: "OPEN" });
  assert.equal((await request(`/game/tables/${tableId}/bet`, { method: "POST", token: reservedToken,
    body: { bets: [{ betType: "PLAYER_PAIR", amount: 200 }] }, headers: { "idempotency-key": randomUUID() } })).status, 200);
  assert.equal((await plinkoPost(reservedToken, { ...plinkoBet, risk: "low" })).status, 400);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM plinko_rounds WHERE user_id=$1", [reserved.id])).rows[0].count, 0);
  assert.equal((await reconcileUserBalance(reserved.id))?.isReconciled, true);
});

test("Plinko rolls back a post-debit failure and retries the same key safely", async () => {
  const user = await insertUser({ username: `plinko_rollback_${runId}`, balance: 1000.75 });
  const token = await login(user);
  const key = randomUUID();
  await pool.query(`CREATE FUNCTION fail_plinko_credit_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.source = 'PLINKO_SETTLEMENT_CREDIT' THEN RAISE EXCEPTION 'test credit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_plinko_credit_test BEFORE INSERT ON financial_ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_plinko_credit_test();`);
  try {
    assert.equal((await plinkoPost(token, plinkoBet, key)).status, 500);
    assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, user.balance);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM plinko_rounds WHERE user_id=$1", [user.id])).rows[0].count, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE actor_id=$1", [user.id])).rows[0].count, 0);
    assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  } finally { await pool.query("DROP TRIGGER fail_plinko_credit_test ON financial_ledger_entries; DROP FUNCTION fail_plinko_credit_test()"); }
  assert.equal((await plinkoPost(token, plinkoBet, key)).status, 200);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Plinko database rejects inconsistent paths, payouts and duplicate ledger credits", async () => {
  const user = await insertUser({ username: `plinko_ck_${runId}`, balance: 1000 });
  const token = await login(user);
  const placed = await plinkoPost(token);
  const id = placed.body.round.id;
  await assert.rejects(pool.query("UPDATE plinko_rounds SET path=ARRAY[0,1] WHERE id=$1", [id]), /plinko_rounds_path/);
  await assert.rejects(pool.query("UPDATE plinko_rounds SET slot_index=17 WHERE id=$1", [id]), /plinko_rounds_path/);
  await assert.rejects(pool.query("UPDATE plinko_rounds SET payout=payout+0.01 WHERE id=$1", [id]), /plinko_rounds_payout/);
  await assert.rejects(withTransaction((client) => applyBalanceMutation({ userId: user.id, delta: placed.body.round.payout,
    actorType: "SYSTEM", source: "PLINKO_SETTLEMENT_CREDIT", referenceType: "PLINKO_ROUND", referenceId: id }, client)), /financial_ledger_source_reference_unique/);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Plinko history retains millisecond cursor precision and paginates tied times without skips", async () => {
  const user = await insertUser({ username: `plinko_cursor_${runId}`, balance: 1000 });
  const token = await login(user);
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const placed = await plinkoPost(token, { ...plinkoBet, rows: 8, risk: "low" });
    assert.equal(placed.status, 200);
    ids.push(placed.body.round.id);
  }
  const precision = await pool.query("SELECT bool_and(created_at=date_trunc('milliseconds',created_at) AND settled_at=date_trunc('milliseconds',settled_at)) AS exact FROM plinko_rounds WHERE user_id=$1", [user.id]);
  assert.equal(precision.rows[0].exact, true);
  await pool.query("UPDATE plinko_rounds SET created_at=$2,settled_at=$2 WHERE user_id=$1", [user.id, new Date().toISOString()]);
  let cursor: string | null = null;
  const found: string[] = [];
  do {
    const page: { status: number; body: { items: PlinkoRound[]; nextCursor: string | null } } =
      await request(`/plinko/history?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token });
    assert.equal(page.status, 200);
    found.push(...page.body.items.map((round) => round.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(found, ids.sort().reverse());
});


test("Mines WebSocket authenticates, settles and replays across reconnect without double debit", async () => {
  const user = await insertUser({ username: `mines_ws_${runId}`, balance: 1000 });
  const other = await insertUser({ username: `mines_ws_other_${runId}`, balance: 1000 });
  const token = await login(user);
  const otherToken = await login(other);
  const sockets: WebSocket[] = [];
  async function connect(token: string) {
    const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, ["bearer", token]);
    sockets.push(ws);
    await once(ws, "open");
    return ws;
  }
  function command(ws: WebSocket, action: MinesCommand["action"], key = randomUUID()) {
    const requestId = randomUUID();
    return new Promise<MinesCommandResult["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("WS response timeout"));
      }, 5000);
      function cleanup() {
        clearTimeout(timer);
        ws.off("message", receive);
      }
      function receive(raw: Buffer) {
        const value = JSON.parse(raw.toString());
        if (value.type !== "mines_result" || value.requestId !== requestId) return;
        cleanup();
        resolve(minesCommandResultSchema.parse(value).result);
      }
      ws.on("message", receive);
      ws.send(JSON.stringify({ type: "mines_command", requestId, idempotencyKey: key, action }));
    });
  }
  try {
    let ws = await connect(token);
    const key = randomUUID();
    const started = await command(ws, { kind: "start", amount: 100, mineCount: 3 }, key);
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("start failed");
    assert.equal(started.data.balance, 900);
    assert.equal(started.data.round.mineCells, null);
    assert.deepEqual(
      (await minesPost(token, "/rounds", { amount: 100, mineCount: 3 }, key)).body,
      started.data,
    );
    ws.terminate();
    await once(ws, "close");
    ws = await connect(token);
    assert.deepEqual(await command(ws, { kind: "start", amount: 100, mineCount: 3 }, key), started);
    const conflict = await command(ws, { kind: "start", amount: 200, mineCount: 3 }, key);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.status, 409);
    const foreign = await command(await connect(otherToken), {
      kind: "reveal",
      roundId: started.data.round.id,
      cellIndex: 0,
    });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.status, 404);
    const board = await minesBoard(started.data.round.id);
    const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !board.includes(i))!;
    const revealKey = randomUUID();
    const revealed = await command(
      ws,
      { kind: "reveal", roundId: started.data.round.id, cellIndex: safe },
      revealKey,
    );
    assert.equal(revealed.ok, true);
    if (revealed.ok) {
      assert.equal(revealed.data.round.mineCells, null);
      assert.equal(revealed.data.round.version, 2);
    }
    assert.deepEqual(
      await command(
        ws,
        { kind: "reveal", roundId: started.data.round.id, cellIndex: safe },
        revealKey,
      ),
      revealed,
    );
    const cashoutKey = randomUUID();
    const paid = await command(ws, { kind: "cashout", roundId: started.data.round.id }, cashoutKey);
    assert.equal(paid.ok, true);
    if (paid.ok) {
      assert.equal(paid.data.balance, 1007.95);
      assert.equal(paid.data.round.payout, 107.95);
    }
    assert.deepEqual(
      await command(ws, { kind: "cashout", roundId: started.data.round.id }, cashoutKey),
      paid,
    );
    const ledger = await pool.query(
      "SELECT source FROM financial_ledger_entries WHERE reference_id=$1 ORDER BY entry_sequence",
      [started.data.round.id],
    );
    assert.deepEqual(
      ledger.rows.map((row) => row.source),
      ["MINES_BET_DEBIT", "MINES_SETTLEMENT_CREDIT"],
    );
    // Revocation is checked on every command, including an idempotency replay.
    await pool.query("UPDATE users SET is_active=false WHERE id=$1", [user.id]);
    const closed = once(ws, "close");
    ws.send(
      JSON.stringify({
        type: "mines_command",
        requestId: randomUUID(),
        idempotencyKey: cashoutKey,
        action: { kind: "cashout", roundId: started.data.round.id },
      }),
    );
    const [code] = await closed;
    assert.equal(code, 4403);
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});


test("Plinko WebSocket replays lost bets, shares HTTP keys and enforces quotas and sessions", async () => {
  const user = await insertUser({ username: `plinko_ws_${runId}`, balance: 10000 });
  const token = await login(user);
  const sockets: WebSocket[] = [];
  async function connect() {
    const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, ["bearer", token]);
    sockets.push(ws);
    await once(ws, "open");
    return ws;
  }
  function command(
    ws: WebSocket,
    key: string,
    payload: PlinkoCommand["payload"] = { amount: 100, rows: 16, risk: "medium", ruleVersion: PLINKO_RULE_VERSION },
  ) {
    const requestId = randomUUID();
    return new Promise<PlinkoCommandResult["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("WS response timeout"));
      }, 5000);
      function cleanup() {
        clearTimeout(timer);
        ws.off("message", receive);
      }
      function receive(raw: Buffer) {
        const value = JSON.parse(raw.toString());
        if (value.type !== "plinko_result" || value.requestId !== requestId) return;
        cleanup();
        resolve(plinkoCommandResultSchema.parse(value).result);
      }
      ws.on("message", receive);
      ws.send(JSON.stringify({ type: "plinko_command", requestId, idempotencyKey: key, payload }));
    });
  }
  try {
    let ws = await connect();
    const key = randomUUID();
    const paid = await command(ws, key);
    assert.equal(paid.ok, true);
    if (!paid.ok) throw new Error("bet failed");
    assert.equal(paid.data.round.path.length, 16);
    assert.equal(paid.data.balance, sumMoney([10000, -100, paid.data.round.payout]));
    // Both transports must address the same saved result and fingerprint.
    assert.deepEqual((await plinkoPost(token, plinkoBet, key)).body, paid.data);
    const closed = once(ws, "close");
    ws.terminate();
    await closed;
    ws = await connect();
    assert.deepEqual(await command(ws, key), paid);
    const conflict = await command(ws, key, { ...plinkoBet, amount: 200, risk: "medium" });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.status, 409);
    const rateKey = plinkoRateLimitKey(user.id);
    await pool.query(
      "UPDATE login_rate_limits SET failures=240, expires_at=NOW()+INTERVAL '1 minute' WHERE scope=$1 AND key_hash=$2",
      [rateKey.scope, rateKey.keyHash],
    );
    const limited = await command(ws, randomUUID());
    assert.equal(limited.ok, false);
    if (!limited.ok) assert.equal(limited.status, 429);
    assert.deepEqual(await command(ws, key), paid);
    const previous = env.plinkoEnabled;
    env.plinkoEnabled = false;
    try {
      const disabled = await command(ws, randomUUID());
      assert.equal(disabled.ok, false);
      if (!disabled.ok) assert.equal(disabled.status, 503);
      assert.deepEqual(await command(ws, key), paid);
    } finally {
      env.plinkoEnabled = previous;
    }
    const ledger = await pool.query(
      "SELECT source FROM financial_ledger_entries WHERE reference_id=$1 ORDER BY entry_sequence",
      [paid.data.round.id],
    );
    assert.deepEqual(
      ledger.rows.map((row) => row.source),
      ["PLINKO_BET_DEBIT", "PLINKO_SETTLEMENT_CREDIT"],
    );
    assert.equal(
      (
        await pool.query("SELECT COUNT(*)::int AS count FROM plinko_rounds WHERE user_id=$1", [
          user.id,
        ])
      ).rows[0].count,
      1,
    );
    assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
    // An already-open socket cannot replay results after its session is revoked.
    await pool.query("UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1", [user.id]);
    const invalid = await command(ws, key);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.status, 401);
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});

// Hi-Lo uses deterministic server-side draws here; the WS path always uses crypto RNG.
async function hiloSetup(name: string, balance = 10000) {
  env.hiloEnabled = true;
  const user = await insertUser({ username: `hilo_${name}_${runId}`, balance });
  const prepared = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "prepare" }, () => 0)).body);
  return { user, preview: prepared.preview! };
}
async function hiloStart(userId: string, preview: HiloPreview, amount = 100, key = randomUUID()) {
  const action = { kind: "start" as const, amount, previewId: preview.id, expectedVersion: preview.version };
  const result = await mutateHilo(userId, key, action);
  assert.equal(result.statusCode, 200);
  return { data: hiloMutationResponseSchema.parse(result.body), key, action };
}
const noDraw = () => { throw new Error("Rejected/replayed commands must not draw"); };

test("Hi-Lo preview versions, parallel starts, replay and stale guesses preserve exactly one debit", async () => {
  const { user, preview } = await hiloSetup("versions");
  const refreshed = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "refresh_preview", previewId: preview.id, expectedVersion: 1 }, () => 24)).body).preview!;
  assert.equal((await mutateHilo(user.id, randomUUID(), { kind: "start", amount: 100, previewId: preview.id, expectedVersion: 1 }, noDraw)).statusCode, 409);
  const action = { kind: "start" as const, amount: 100, previewId: refreshed.id, expectedVersion: refreshed.version };
  const key = randomUUID();
  const starts = await Promise.all([mutateHilo(user.id, key, action, noDraw), mutateHilo(user.id, randomUUID(), action, noDraw)]);
  assert.deepEqual(starts.map((x) => x.statusCode).sort(), [200, 409]);
  const successful = starts.find((x) => x.statusCode === 200)!;
  const round = hiloMutationResponseSchema.parse(successful.body).round!;
  assert.equal(round.initialCard, 24);
  assert.equal((await pool.query("SELECT count(*) FROM financial_ledger_entries WHERE source='HILO_BET_DEBIT' AND user_id=$1", [user.id])).rows[0].count, "1");
  const choice = { kind: "guess" as const, roundId: round.id, expectedVersion: 1, choice: "higher_or_equal" as const };
  const guessKey = randomUUID();
  const correct = await mutateHilo(user.id, guessKey, choice, () => 24);
  assert.equal(correct.statusCode, 200);
  assert.deepEqual(await mutateHilo(user.id, guessKey, choice, noDraw), correct);
  assert.equal((await mutateHilo(user.id, randomUUID(), choice, noDraw)).statusCode, 409);
  assert.equal((await mutateHilo(user.id, guessKey, { ...choice, choice: "lower_or_equal" }, noDraw)).statusCode, 409);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Hi-Lo exact payouts, cashout race, daily profit and durable idempotency", async () => {
  const { user, preview } = await hiloSetup("cashout");
  const { data } = await hiloStart(user.id, preview);
  let round = data.round!;
  assert.equal((await mutateHilo(user.id, randomUUID(), { kind: "cashout", roundId: round.id, expectedVersion: 1 }, noDraw)).statusCode, 409);
  // A -> K succeeds with 12/13, K -> A succeeds with 12/13, without another 6% deduction.
  for (const [choice, card] of [["higher", 48], ["lower", 0]] as const) {
    round = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: round.version, choice }, () => card)).body).round!;
  }
  assert.equal(round.cashoutAmount, 110.32);
  const key = randomUUID(), action = { kind: "cashout" as const, roundId: round.id, expectedVersion: round.version };
  const settled = await mutateHilo(user.id, key, action, noDraw);
  assert.equal(hiloMutationResponseSchema.parse(settled.body).balance, 10010.32);
  await pool.query("UPDATE idempotency_keys SET created_at=NOW()-INTERVAL '30 days' WHERE actor_id=$1", [user.id]);
  await runRetentionCleanup({ idempotencyRetentionDays: 7, authSessionRetentionDays: 7 });
  assert.deepEqual(await mutateHilo(user.id, key, action, noDraw), settled);
  assert.equal((await mutateHilo(user.id, randomUUID(), action, noDraw)).statusCode, 409);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  const profit = await getUserDailyProfit(user.id, { start: new Date(Date.now()-60000), end: new Date(Date.now()+60000) });
  assert.deepEqual(profit, { totalBet: 100, totalPayout: 110.32, netProfit: 10.32 });
  const page = await hiloHistory(user.id, { limit: 1, cursor: null });
  assert.equal(page.items[0]?.steps.length, 2);
  assert.equal(page.items[0]?.payout, 110.32);
});

test("Hi-Lo skip limits, forbidden ownership, loss and transaction rollback", async () => {
  const { user, preview } = await hiloSetup("skip");
  const other = await insertUser({ username: `hilo_other_${runId}` });
  let round = (await hiloStart(user.id, preview)).data.round!;
  assert.equal((await mutateHilo(other.id, randomUUID(), { kind: "skip", roundId: round.id, expectedVersion: 1 }, noDraw)).statusCode, 404);
  const key = randomUUID(), action = { kind: "guess" as const, roundId: round.id, expectedVersion: 1, choice: "higher" as const };
  await assert.rejects(() => mutateHilo(user.id, key, action, () => { throw new Error("simulated RNG failure"); }), /simulated/);
  assert.equal((await findHiloRound(user.id))?.version, 1);
  assert.equal((await pool.query("SELECT count(*) FROM idempotency_keys WHERE actor_id=$1 AND idempotency_key=$2", [user.id, key])).rows[0].count, "0");
  for (let i = 0; i < 52; i++) {
    round = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "skip", roundId: round.id, expectedVersion: round.version }, () => 0)).body).round!;
    assert.equal(round.multiplier, 0);
    assert.equal(round.cashoutAmount, 0);
    assert.equal(round.steps.at(-1)?.multiplier, 0);
  }
  assert.equal((await mutateHilo(user.id, randomUUID(), { kind: "skip", roundId: round.id, expectedVersion: round.version }, noDraw)).statusCode, 409);
  const lost = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { ...action, expectedVersion: round.version }, () => 0)).body);
  assert.equal(lost.round?.status, "LOST");
  assert.equal(lost.round?.payout, 0);
  assert.equal(lost.balance, 9900);
  assert.equal(await findHiloRound(other.id, round.id), null);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Hi-Lo reserves exposure across games and stops only new rounds when disabled", async () => {
  const { user, preview } = await hiloSetup("exposure", 1998999900);
  const round = (await hiloStart(user.id, preview)).data.round!;
  assert.equal(await getUserUnsettledMaximumPayout(user.id), 1000000);
  const mines = await mutateMines(user.id, randomUUID(), { kind: "start", amount: 100, mineCount: 24 });
  assert.equal(mines.statusCode, 400);
  const plinko = await placePlinkoBet(user.id, randomUUID(), { amount: 100, rows: 16, risk: "high", ruleVersion: PLINKO_RULE_VERSION });
  assert.equal(plinko.statusCode, 400);
  env.hiloEnabled = false;
  try {
    assert.equal((await mutateHilo(user.id, randomUUID(), { kind: "prepare" }, noDraw)).statusCode, 503);
    const won = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: 1, choice: "higher" }, () => 48)).body).round!;
    assert.equal((await mutateHilo(user.id, randomUUID(), { kind: "cashout", roundId: won.id, expectedVersion: won.version }, noDraw)).statusCode, 200);
  } finally { env.hiloEnabled = true; }
});

test("Hi-Lo caps before drawing and atomically settles at the global limit", async () => {
  const { user, preview } = await hiloSetup("cap");
  let round = (await hiloStart(user.id, preview)).data.round!;
  // Reach a high multiplier with real service operations, preserving exact fractions and step history.
  for (let i = 0; i < 3; i++) round = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: round.version, choice: "same" }, () => 0)).body).round!;
  assert.equal(round.options.find((x) => x.choice === "same")?.enabled, false);
  assert.equal((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: round.version, choice: "same" }, noDraw)).statusCode, 409);
  while (round.status === "ACTIVE") {
    const current = rank(round.card);
    round = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: round.version, choice: current === 1 ? "higher" : "lower" }, () => current === 1 ? 48 : 0)).body).round!;
  }
  assert.equal(round.status, "CASHED_OUT");
  assert.ok(round.multiplier <= 10000 && round.multiplier > 10000 * 12 / 13);
  assert.equal(round.payout, hiloPayout(100, { numerator: BigInt((await pool.query("SELECT numerator::text FROM hilo_rounds WHERE id=$1", [round.id])).rows[0].numerator), denominator: BigInt((await pool.query("SELECT denominator::text FROM hilo_rounds WHERE id=$1", [round.id])).rows[0].denominator) }));
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});

test("Hi-Lo WebSocket and read APIs authenticate, replay across reconnect, and expose versioned state", async () => {
  const { user } = await hiloSetup("ws");
  const token = await login(user);
  const sockets: WebSocket[] = [];
  async function connect() { const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, ["bearer", token]); sockets.push(ws); await once(ws, "open"); return ws; }
  function command(ws: WebSocket, action: HiloAction, key = randomUUID()) {
    const requestId = randomUUID();
    return new Promise<HiloCommandResult["result"]>((resolve, reject) => {
      const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("Hi-Lo timeout")); }, 5000);
      function receive(raw: Buffer) {
        const value = JSON.parse(raw.toString());
        if (value.type !== "hilo_result" || value.requestId !== requestId) return;
        clearTimeout(timer); ws.off("message", receive); resolve(hiloCommandResultSchema.parse(value).result);
      }
      ws.on("message", receive); ws.send(JSON.stringify({ type: "hilo_command", requestId, idempotencyKey: key, action }));
    });
  }
  try {
    let ws = await connect();
    const prepared = await command(ws, { kind: "prepare" }); assert.ok(prepared.ok);
    const preview = prepared.data.preview!;
    const action = { kind: "start" as const, amount: 100, previewId: preview.id, expectedVersion: preview.version }, key = randomUUID();
    const started = await command(ws, action, key); assert.ok(started.ok);
    ws.close(); await once(ws, "close"); ws = await connect();
    assert.deepEqual(await command(ws, action, key), started);
    const state = await request<{ round: HiloRound }>("/hilo/state", { token });
    assert.equal(state.status, 200); assert.equal(state.body.round.id, started.data.round!.id);
    assert.equal((await request("/hilo/config")).status, 401);
    const other = await insertUser({ username: `hilo_ws_other_${runId}`, balance: 100 });
    assert.equal((await request(`/hilo/rounds/${state.body.round.id}`, { token: await login(other) })).status, 404);
  } finally { for (const ws of sockets) ws.terminate(); }
});

test("Hi-Lo concurrent guess/cashout applies one version, and exhausted skips auto-settle", async () => {
  const { user, preview } = await hiloSetup("race");
  let round = (await hiloStart(user.id, preview)).data.round!;
  round = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: 1, choice: "higher" }, () => 48)).body).round!;
  const ref = { roundId: round.id, expectedVersion: round.version };
  const results = await Promise.all([
    mutateHilo(user.id, randomUUID(), { kind: "guess", ...ref, choice: "lower" }, () => 0),
    mutateHilo(user.id, randomUUID(), { kind: "cashout", ...ref }, noDraw),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  round = (await findHiloRound(user.id, round.id))!;
  if (round.status === "ACTIVE") await mutateHilo(user.id, randomUUID(), { kind: "cashout", roundId: round.id, expectedVersion: round.version }, noDraw);
  assert.equal((await pool.query("SELECT count(*) FROM financial_ledger_entries WHERE reference_id=$1 AND source='HILO_SETTLEMENT_CREDIT'", [round.id])).rows[0].count, "1");
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  // Boundary fixture: only the 52nd skip is left; middle ranks cannot continue at 9000x.
  const boundary = await hiloSetup("skipcap");
  const next = (await hiloStart(boundary.user.id, boundary.preview)).data.round!;
  await pool.query("UPDATE hilo_rounds SET numerator=9000,denominator=1,success_count=1,skip_count=51 WHERE id=$1", [next.id]);
  const settled = hiloMutationResponseSchema.parse((await mutateHilo(boundary.user.id, randomUUID(), { kind: "skip", roundId: next.id, expectedVersion: next.version }, () => 24)).body);
  assert.equal(settled.round?.status, "CASHED_OUT");
  assert.equal(settled.round?.payout, 900000);
  assert.equal((await reconcileUserBalance(boundary.user.id))?.isReconciled, true);
});

test("Hi-Lo settlement failure rolls back the wallet, ledger, state and idempotency together", async () => {
  const { user, preview } = await hiloSetup("rollback");
  let round = (await hiloStart(user.id, preview)).data.round!;
  round = hiloMutationResponseSchema.parse((await mutateHilo(user.id, randomUUID(), { kind: "guess", roundId: round.id, expectedVersion: 1, choice: "higher" }, () => 48)).body).round!;
  const key = randomUUID(), action = { kind: "cashout" as const, roundId: round.id, expectedVersion: round.version };
  await pool.query(`CREATE FUNCTION hilo_test_reject_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status = 'CASHED_OUT' THEN RAISE EXCEPTION 'simulated state write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER hilo_test_reject_settlement BEFORE UPDATE ON hilo_rounds FOR EACH ROW EXECUTE FUNCTION hilo_test_reject_settlement();`);
  try { await assert.rejects(() => mutateHilo(user.id, key, action, noDraw), /simulated state write failure/); }
  finally { await pool.query("DROP TRIGGER hilo_test_reject_settlement ON hilo_rounds; DROP FUNCTION hilo_test_reject_settlement();"); }
  const current = await findHiloRound(user.id);
  assert.equal(current?.version, round.version);
  assert.equal(current?.status, "ACTIVE");
  assert.equal((await pool.query("SELECT balance::text FROM users WHERE id=$1", [user.id])).rows[0].balance, "9900.00");
  assert.equal((await pool.query("SELECT count(*) FROM financial_ledger_entries WHERE reference_id=$1 AND source='HILO_SETTLEMENT_CREDIT'", [round.id])).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM idempotency_keys WHERE actor_id=$1 AND idempotency_key=$2", [user.id, key])).rows[0].count, "0");
  const result = hiloMutationResponseSchema.parse((await mutateHilo(user.id, key, action, noDraw)).body);
  assert.equal(result.balance, 10001.83);
  assert.equal(result.round?.status, "CASHED_OUT");
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
});


test("Plinko v2 replays a settled v1 wager without recalculating or crediting it again", async () => {
  const user = await insertUser({ username: `plinko_v1_${runId}`, balance: 10000 });
  const token = await login(user);
  const key = randomUUID();
  const input = { amount: 100, rows: 16, risk: "low" as const, ruleVersion: 1 };
  const legacy = plinkoV1Tables.find((t) => t.rows === 16 && t.risk === "low")!;
  const id = randomUUID();
  const payout = plinkoPayout(100, legacy.units[0]!);
  const saved = await withTransaction(async (client) => {
    const claim = { actorId: user.id, scope: "plinko.start", key, requestHash: fingerprintIdempotencyRequest(input) };
    assert.equal((await claimIdempotencyKey(claim, client)).kind, "claimed");
    const inserted = await client.query(`INSERT INTO plinko_rounds
      (id,user_id,amount,rows,risk,path,slot_index,multiplier_units,payout,rule_version)
      VALUES ($1,$2,100,16,'low',$3,0,$4,$5,1) RETURNING *`,
      [id, user.id, Array(16).fill(0), legacy.units[0], payout]);
    await applyBalanceMutation({ userId: user.id, delta: -100, actorType: "PLAYER", actorId: user.id,
      source: "PLINKO_BET_DEBIT", referenceType: "PLINKO_ROUND", referenceId: id }, client);
    const credit = await applyBalanceMutation({ userId: user.id, delta: payout, actorType: "SYSTEM",
      source: "PLINKO_SETTLEMENT_CREDIT", referenceType: "PLINKO_ROUND", referenceId: id }, client);
    const response = { round: publicPlinkoRound(inserted.rows[0]), balance: credit.user.balance, walletVersion: credit.user.walletVersion };
    await completeIdempotencyKey({ ...claim, statusCode: 200, response }, client);
    return response;
  });
  const replay = await plinkoPost(token, input, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, saved);
  assert.equal((await request<{ round: PlinkoRound }>(`/plinko/rounds/${id}`, { token })).body.round.multiplier, 15.4345);
  assert.equal((await plinkoPost(token, input)).status, 409);
  assert.equal((await request<{ balance: number }>("/auth/me", { token })).body.balance, saved.balance);
  assert.equal((await reconcileUserBalance(user.id))?.isReconciled, true);
  assert.equal((await plinkoPost(token)).status, 200);
});
