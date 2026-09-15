import { createHash, randomUUID } from "node:crypto";
import {
  type ApiErrorCode,
  type PlinkoRound,
  type PlinkoStartRequest,
  fromMinorUnits,
  toMinorUnits,
  minorUnitsToDecimal,
  plinkoStartRequestSchema,
} from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { MAX_ACCOUNT_BALANCE } from "../../lib/account-policy.js";
import {
  applyBalanceMutation,
  findUserById,
  getUserUnsettledMaximumPayout,
  withTransaction,
} from "../../lib/db.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
} from "../../lib/repositories/idempotency-store.js";
import {
  pool,
  queryRow,
  queryRows,
  toIsoString,
  type DbExecutor,
  type DbRow,
} from "../../lib/repositories/client.js";
import { fingerprintIdempotencyRequest } from "../../lib/idempotency.js";
import { encodeHistoryCursor, type HistoryCursor } from "../../lib/history-pagination.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { PostgresLoginRateLimitStore } from "../../lib/postgres-login-rate-limit-store.js";
import { generatePlinkoPath, getPlinkoTable, plinkoPayout, PLINKO_RULE_VERSION } from "./math.js";

export function publicPlinkoRound(row: DbRow): PlinkoRound {
  return {
    id: String(row.id),
    amount: fromMinorUnits(toMinorUnits(String(row.amount))),
    rows: Number(row.rows),
    risk: row.risk as PlinkoRound["risk"],
    path: row.path as (0 | 1)[],
    slotIndex: Number(row.slot_index),
    multiplier: Number(row.multiplier_units) / 10000,
    payout: fromMinorUnits(toMinorUnits(String(row.payout))),
    ruleVersion: Number(row.rule_version),
    createdAt: toIsoString(row.created_at),
    settledAt: toIsoString(row.settled_at),
  };
}

export async function findPlinkoRound(actorId: string, id: string, executor: DbExecutor = pool) {
  const row = await queryRow(
    executor,
    "SELECT * FROM plinko_rounds WHERE user_id = $1 AND id = $2",
    [actorId, id],
  );
  return row ? publicPlinkoRound(row) : null;
}

export async function plinkoHistory(
  actorId: string,
  page: { limit: number; cursor: HistoryCursor | null },
) {
  const rows = await queryRows(
    pool,
    `SELECT * FROM plinko_rounds WHERE user_id = $1
    AND ($2::timestamptz IS NULL OR (settled_at, created_at, id) < ($2::timestamptz, $3::timestamptz, $4::text))
    ORDER BY settled_at DESC, created_at DESC, id DESC LIMIT $5`,
    [
      actorId,
      page.cursor?.settledAt ?? null,
      page.cursor?.createdAt ?? null,
      page.cursor?.roundId ?? null,
      page.limit + 1,
    ],
  );
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: items.map(publicPlinkoRound),
    nextCursor:
      rows.length > page.limit && last
        ? encodeHistoryCursor({
            settledAt: toIsoString(last.settled_at),
            createdAt: toIsoString(last.created_at),
            roundId: String(last.id),
          })
        : null,
  };
}

// Namespace and hash contain only the authenticated account ID, never a client-supplied identity.
export function plinkoRateLimitKey(actorId: string) {
  return {
    scope: "ENDPOINT_USER",
    keyHash: createHash("sha256").update(`plinko.start\0${actorId}`).digest("hex"),
  };
}

type Result = { statusCode: number; body: Record<string, unknown> };
export async function placePlinkoBet(
  actorId: string,
  key: string,
  input: PlinkoStartRequest,
): Promise<Result> {
  const action = plinkoStartRequestSchema.parse(input);
  const scope = "plinko.start";
  const requestHash = fingerprintIdempotencyRequest(action);
  return withTransaction(async (client) => {
    const claim = await claimIdempotencyKey<Record<string, unknown>>(
      { actorId, scope, key, requestHash },
      client,
    );
    if (claim.kind === "replay") return { statusCode: claim.statusCode, body: claim.response };
    if (claim.kind === "conflict")
      return {
        statusCode: 409,
        body: {
          code: "CONFLICT",
          message: "Idempotency-Key was already used for a different request",
        },
      };
    async function complete(statusCode: number, body: Record<string, unknown>): Promise<Result> {
      await completeIdempotencyKey(
        { actorId, scope, key, requestHash, statusCode, response: body },
        client,
      );
      return { statusCode, body };
    }
    const fail = (status: number, code: ApiErrorCode, message: string) =>
      complete(status, { code, message });
    // Same user-first order as Mines; exposure reads never lock baccarat rounds.
    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user || !user.isActive || user.role !== "PLAYER")
      return fail(403, "FORBIDDEN", "Account is not allowed to play");
    if (!env.plinkoEnabled) return fail(503, "SERVICE_UNAVAILABLE", "Plinko 暫停接受新投注。");
    if (action.ruleVersion !== PLINKO_RULE_VERSION)
      return fail(409, "CONFLICT", "Plinko 規則已更新，請重新載入設定。");
    const [rate] = await new PostgresLoginRateLimitStore(client).increment(
      [{ ...plinkoRateLimitKey(actorId), windowMs: 60000 }],
      Date.now(),
    );
    if (!rate || rate.failures > 240)
      return fail(429, "RATE_LIMITED", "投注過於頻繁，請稍後再試。");
    const table = getPlinkoTable(action.rows, action.risk);
    const balanceAfter = toMinorUnits(user.balance) - toMinorUnits(action.amount);
    if (balanceAfter < 0n) return fail(400, "VALIDATION_ERROR", "餘額不足。");
    const exposure = await getUserUnsettledMaximumPayout(actorId, client);
    const maximumPayout = plinkoPayout(action.amount, Math.max(...table.units));
    if (
      balanceAfter + toMinorUnits(exposure) + toMinorUnits(maximumPayout) >
      toMinorUnits(MAX_ACCOUNT_BALANCE)
    )
      return fail(
        400,
        "VALIDATION_ERROR",
        "本次投注的最大派彩可能超過帳戶上限，請降低投注額或調整設定。",
      );

    const path = generatePlinkoPath(action.rows);
    const slotIndex = path.reduce<number>((sum, direction) => sum + direction, 0);
    const units = table.units[slotIndex];
    const payout = plinkoPayout(action.amount, units);
    const id = randomUUID();
    const row = await queryRow(
      client,
      `INSERT INTO plinko_rounds
      (id, user_id, amount, rows, risk, path, slot_index, multiplier_units, payout, rule_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        actorId,
        minorUnitsToDecimal(toMinorUnits(action.amount)),
        action.rows,
        action.risk,
        path,
        slotIndex,
        units,
        minorUnitsToDecimal(toMinorUnits(payout)),
        PLINKO_RULE_VERSION,
      ],
    );
    if (!row) throw new Error("Plinko round insert returned no row");
    const metadata = {
      rows: action.rows,
      risk: action.risk,
      slotIndex,
      multiplierUnits: units,
      ruleVersion: PLINKO_RULE_VERSION,
    };
    await applyBalanceMutation(
      {
        userId: actorId,
        delta: -action.amount,
        actorType: "PLAYER",
        actorId,
        source: "PLINKO_BET_DEBIT",
        referenceType: "PLINKO_ROUND",
        referenceId: id,
        metadata,
      },
      client,
    );
    const settled = await applyBalanceMutation(
      {
        userId: actorId,
        delta: payout,
        actorType: "SYSTEM",
        source: "PLINKO_SETTLEMENT_CREDIT",
        referenceType: "PLINKO_ROUND",
        referenceId: id,
        metadata,
      },
      client,
    );
    await publishLiveEvent(
      {
        type: "user_changed",
        userId: actorId,
        reason: "plinko_settled",
        at: new Date().toISOString(),
      },
      client,
    );
    return complete(200, {
      round: publicPlinkoRound(row),
      balance: settled.user.balance,
      walletVersion: settled.user.walletVersion,
    });
  });
}
