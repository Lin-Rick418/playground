import { randomUUID } from "node:crypto";
import {
  type ApiErrorCode,
  type MinesRound,
  fromMinorUnits,
  toMinorUnits,
  minorUnitsToDecimal,
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
import { generateMineCells, minesMultiplier, minesPayout } from "./math.js";

export function publicMinesRound(row: DbRow): MinesRound {
  const mineCount = Number(row.mine_count);
  const cells = row.mine_cells as number[];
  const revealed = row.revealed_cells as number[];
  const safeCount = revealed.filter((cell) => !cells.includes(cell)).length;
  const status = row.status as MinesRound["status"];
  const amount = fromMinorUnits(toMinorUnits(String(row.amount)));
  return {
    id: String(row.id),
    amount,
    mineCount,
    revealedCells: revealed,
    status,
    payout: fromMinorUnits(toMinorUnits(String(row.payout))),
    cashoutAmount:
      status === "ACTIVE" && safeCount > 0 ? minesPayout(amount, mineCount, safeCount) : 0,
    multiplier: safeCount ? minesMultiplier(mineCount, safeCount) : 0,
    nextMultiplier:
      status === "ACTIVE" && safeCount < 25 - mineCount
        ? minesMultiplier(mineCount, safeCount + 1)
        : null,
    mineCells: status === "ACTIVE" ? null : cells,
    createdAt: toIsoString(row.created_at),
    settledAt: row.settled_at ? toIsoString(row.settled_at) : null,
    version: Number(row.version),
    ruleVersion: 1,
  };
}

export async function findMinesRound(actorId: string, id?: string, executor: DbExecutor = pool) {
  const row = await queryRow(
    executor,
    id
      ? "SELECT * FROM mines_rounds WHERE user_id = $1 AND id = $2"
      : "SELECT * FROM mines_rounds WHERE user_id = $1 AND status = 'ACTIVE'",
    id ? [actorId, id] : [actorId],
  );
  return row ? publicMinesRound(row) : null;
}

export async function minesHistory(
  actorId: string,
  page: { limit: number; cursor: HistoryCursor | null },
) {
  const rows = await queryRows(
    pool,
    `SELECT * FROM mines_rounds WHERE user_id = $1 AND status <> 'ACTIVE'
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
    items: items.map(publicMinesRound),
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

type Action =
  | { kind: "start"; amount: number; mineCount: number }
  | { kind: "reveal"; roundId: string; cellIndex: number }
  | { kind: "cashout"; roundId: string };
type Result = { statusCode: number; body: Record<string, unknown> };

export async function mutateMines(actorId: string, key: string, action: Action): Promise<Result> {
  const scope = action.kind === "start" ? "mines.start" : `mines.${action.kind}:${action.roundId}`;
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
    // Lock the shared user first, then this user's Mines round. Exposure reads never lock baccarat rounds.
    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user || !user.isActive || user.role !== "PLAYER")
      return fail(403, "FORBIDDEN", "Account is not allowed to play");
    let row: DbRow | null;
    let balance = user.balance;
    let walletVersion = user.walletVersion;
    if (action.kind === "start") {
      if (!env.minesEnabled)
        return fail(503, "SERVICE_UNAVAILABLE", "Mines 暫停接受新投注，既有局仍可繼續。");
      const active = await queryRow(
        client,
        "SELECT id FROM mines_rounds WHERE user_id = $1 AND status = 'ACTIVE'",
        [actorId],
      );
      if (active) return fail(409, "CONFLICT", "請先完成目前的 Mines。");
      const balanceAfter = toMinorUnits(user.balance) - toMinorUnits(action.amount);
      if (balanceAfter < 0n) return fail(400, "VALIDATION_ERROR", "餘額不足。");
      const maximumPayout = minesPayout(action.amount, action.mineCount, 25 - action.mineCount);
      const exposure = await getUserUnsettledMaximumPayout(actorId, client);
      if (
        balanceAfter + toMinorUnits(exposure) + toMinorUnits(maximumPayout) >
        toMinorUnits(MAX_ACCOUNT_BALANCE)
      ) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "本次投注的最大派彩可能超過帳戶上限，請降低投注額或調整雷數。",
        );
      }
      row = await queryRow(
        client,
        `INSERT INTO mines_rounds (id, user_id, amount, mine_count, mine_cells, maximum_payout)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          randomUUID(),
          actorId,
          minorUnitsToDecimal(toMinorUnits(action.amount)),
          action.mineCount,
          generateMineCells(action.mineCount),
          minorUnitsToDecimal(toMinorUnits(maximumPayout)),
        ],
      );
      if (!row) throw new Error("Mines round insert returned no row");
      const mutation = await applyBalanceMutation(
        {
          userId: actorId,
          delta: -action.amount,
          actorType: "PLAYER",
          actorId,
          source: "MINES_BET_DEBIT",
          referenceType: "MINES_ROUND",
          referenceId: String(row.id),
          metadata: { mineCount: action.mineCount },
        },
        client,
      );
      balance = mutation.user.balance;
      walletVersion = mutation.user.walletVersion;
    } else {
      row = await queryRow(
        client,
        "SELECT * FROM mines_rounds WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [action.roundId, actorId],
      );
      if (!row) return fail(404, "NOT_FOUND", "Mines round not found");
      if (row.status !== "ACTIVE") return fail(409, "CONFLICT", "此局已結束。");
      const mines = row.mine_cells as number[];
      const revealed = [...(row.revealed_cells as number[])];
      let status = "ACTIVE";
      let payout = 0;
      if (action.kind === "reveal") {
        if (revealed.includes(action.cellIndex)) return fail(409, "CONFLICT", "此格已翻開。");
        revealed.push(action.cellIndex);
        if (mines.includes(action.cellIndex)) status = "LOST";
        else if (revealed.length === 25 - Number(row.mine_count)) status = "CASHED_OUT";
      } else {
        if (!revealed.length) return fail(409, "CONFLICT", "至少翻開一個安全格才能收款。");
        status = "CASHED_OUT";
      }
      if (status === "CASHED_OUT") {
        payout = minesPayout(Number(row.amount), Number(row.mine_count), revealed.length);
        const mutation = await applyBalanceMutation(
          {
            userId: actorId,
            delta: payout,
            actorType: "SYSTEM",
            source: "MINES_SETTLEMENT_CREDIT",
            referenceType: "MINES_ROUND",
            referenceId: action.roundId,
            metadata: { safeCount: revealed.length, ruleVersion: 1 },
          },
          client,
        );
        balance = mutation.user.balance;
        walletVersion = mutation.user.walletVersion;
      }
      row = await queryRow(
        client,
        `UPDATE mines_rounds SET revealed_cells = $2, status = $3, payout = $4,
        settled_at = CASE WHEN $3 = 'ACTIVE' THEN NULL ELSE clock_timestamp() END, version = version + 1 WHERE id = $1 RETURNING *`,
        [action.roundId, revealed, status, minorUnitsToDecimal(toMinorUnits(payout))],
      );
      if (!row) throw new Error("Mines round update returned no row");
    }
    await publishLiveEvent(
      {
        type: "user_changed",
        userId: actorId,
        reason: `mines_${action.kind}`,
        at: new Date().toISOString(),
      },
      client,
    );
    return complete(200, { round: publicMinesRound(row), balance, walletVersion });
  });
}
