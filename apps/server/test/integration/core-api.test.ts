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

test("bet placement debits exactly once and insufficient balance rolls back", async () => {
  const player = await insertUser({ username: `bettor_ci_${runId}`, balance: 1_000 });
  const tableId = await insertTable();
  await insertRound({ tableId, status: "OPEN" });
  const token = await login(player);

  const placed = await request<{ balance: number; bets: unknown[] }>(
    `/game/tables/${tableId}/bet`,
    {
      method: "POST",
      token,
      body: {
        bets: [
          { betType: "PLAYER", amount: 100 },
          { betType: "BANKER", amount: 200 },
        ],
      },
      headers: { "idempotency-key": randomUUID() },
    },
  );
  assert.equal(placed.status, 200);
  assert.equal(placed.body.balance, 700);
  assert.equal(placed.body.bets.length, 2);

  const rejected = await request<{ message: string }>(`/game/tables/${tableId}/bet`, {
    method: "POST",
    token,
    body: { bets: [{ betType: "TIE", amount: 800 }] },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.message, "Insufficient balance");

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
});
