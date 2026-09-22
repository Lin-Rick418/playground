import { randomUUID } from "node:crypto";
import {
  blackjackActionSchema,
  blackjackRoundSchema,
  fromMinorUnits,
  toMinorUnits,
  minorUnitsToDecimal,
  type BlackjackAction,
  type BlackjackRound,
  type ApiErrorCode,
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
import {
  activeHand,
  additionalStake,
  allowedActions,
  maximumPayout,
  payout,
  play,
  shuffleShoe,
  startRound,
  total,
  totalBet,
  type BlackjackState,
} from "./math.js";
const decimal = (n: number) => minorUnitsToDecimal(toMinorUnits(n));
export function publicBlackjackRound(row: DbRow): BlackjackRound {
  const state = row.state as BlackjackState;
  const hidden = state.phase !== "SETTLED";
  // Explicit allowlist: never spread stored state into a public response.
  return blackjackRoundSchema.parse({
    id: String(row.id),
    amount: Number(row.amount),
    totalBet: Number(row.total_bet),
    payout: Number(row.payout),
    status: row.status,
    phase: state.phase,
    dealerCards: hidden ? state.dealer.slice(0, 1) : [...state.dealer],
    dealerTotal: hidden ? null : total(state.dealer).total,
    dealerSoft: hidden ? null : total(state.dealer).soft,
    dealerHidden: hidden,
    hands: state.hands.map((h) => ({
      id: h.id,
      cards: [...h.cards],
      amount: h.amount,
      total: h.total,
      soft: h.soft,
      status: h.status,
      split: h.split,
      splitAces: h.splitAces,
      doubled: h.doubled,
      outcome: h.outcome,
      payout: h.payout,
    })),
    activeHandId: activeHand(state)?.id ?? null,
    insurance: { ...state.insurance },
    allowedActions: allowedActions(state),
    version: Number(row.version),
    ruleVersion: Number(row.rule_version),
    createdAt: toIsoString(row.created_at),
    settledAt: row.settled_at ? toIsoString(row.settled_at) : null,
  });
}
export async function findBlackjackRound(
  actorId: string,
  id?: string,
  executor: DbExecutor = pool,
) {
  const row = await queryRow(
    executor,
    `SELECT * FROM blackjack_rounds WHERE user_id=$1 AND ${id ? "id=$2" : "status='ACTIVE'"}`,
    id ? [actorId, id] : [actorId],
  );
  return row ? publicBlackjackRound(row) : null;
}
export async function blackjackHistory(
  actorId: string,
  page: { limit: number; cursor: HistoryCursor | null },
) {
  const rows = await queryRows(
    pool,
    `SELECT * FROM blackjack_rounds WHERE user_id=$1 AND status='SETTLED'
    AND ($2::timestamptz IS NULL OR (settled_at,created_at,id)<($2::timestamptz,$3::timestamptz,$4::text))
    ORDER BY settled_at DESC,created_at DESC,id DESC LIMIT $5`,
    [
      actorId,
      page.cursor?.settledAt ?? null,
      page.cursor?.createdAt ?? null,
      page.cursor?.roundId ?? null,
      page.limit + 1,
    ],
  );
  const items = rows.slice(0, page.limit),
    last = items.at(-1);
  return {
    items: items.map(publicBlackjackRound),
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
export async function mutateBlackjack(
  actorId: string,
  key: string,
  input: BlackjackAction,
  shoeFactory: () => number[] = shuffleShoe,
) {
  const action = blackjackActionSchema.parse(input),
    scope = "blackjack.mutation",
    requestHash = fingerprintIdempotencyRequest(action);
  return withTransaction(async (client) => {
    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user || !user.isActive || user.role !== "PLAYER")
      return {
        statusCode: 403,
        body: { code: "FORBIDDEN", message: "Account is not allowed to play" },
      };
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
    async function complete(statusCode: number, body: Record<string, unknown>) {
      await completeIdempotencyKey(
        { actorId, scope, key, requestHash, statusCode, response: body },
        client,
      );
      return { statusCode, body };
    }
    const fail = (status: number, code: ApiErrorCode, message: string) =>
      complete(status, { code, message });
    let state: BlackjackState, roundId: string, amount: number, debit: number, version: number;
    let previousMaximum = 0,
      reservedMaximum: number;
    const exposure = await getUserUnsettledMaximumPayout(actorId, client);
    if (action.kind === "start") {
      if (!env.blackjackEnabled)
        return fail(503, "SERVICE_UNAVAILABLE", "Blackjack 暫停接受新投注，既有局仍可繼續。");
      if (await findBlackjackRound(actorId, undefined, client))
        return fail(409, "CONFLICT", "請先完成目前的 Blackjack。");
      amount = action.amount;
      debit = amount;
      roundId = randomUUID();
      version = 1;
      reservedMaximum = fromMinorUnits((toMinorUnits(amount) * 5n) / 2n);
    } else {
      const row = await queryRow(
        client,
        "SELECT * FROM blackjack_rounds WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [action.roundId, actorId],
      );
      if (!row) return fail(404, "NOT_FOUND", "Blackjack round not found");
      if (row.status !== "ACTIVE" || Number(row.version) !== action.expectedVersion)
        return fail(409, "CONFLICT", "牌局已更新，請同步後再試。");
      state = structuredClone(row.state as BlackjackState);
      roundId = String(row.id);
      amount = Number(row.amount);
      version = Number(row.version) + 1;
      try {
        debit = additionalStake(state, action);
      } catch (error) {
        return fail(400, "VALIDATION_ERROR", (error as Error).message);
      }
      previousMaximum = Number(row.maximum_payout);
      reservedMaximum = fromMinorUnits(
        toMinorUnits(previousMaximum) +
          toMinorUnits(debit) * (action.kind === "insurance" ? 3n : 2n),
      );
    }
    const after = toMinorUnits(user.balance) - toMinorUnits(debit);
    if (after < 0n) return fail(400, "VALIDATION_ERROR", "餘額不足。");
    if (
      after +
        toMinorUnits(exposure) -
        toMinorUnits(previousMaximum) +
        toMinorUnits(reservedMaximum) >
      toMinorUnits(MAX_ACCOUNT_BALANCE)
    )
      return fail(400, "VALIDATION_ERROR", "可能派彩超過帳戶額度。");
    // All admission checks precede drawing; declined actions cannot consume cards.
    if (action.kind === "start") state = startRound(amount, shoeFactory());
    else play(state!, action);
    const next = state!,
      settled = next.phase === "SETTLED",
      paid = payout(next),
      max = maximumPayout(next),
      operationId = randomUUID();
    if (action.kind === "start") {
      await client.query(
        `INSERT INTO blackjack_rounds(id,user_id,amount,total_bet,state,status,payout,maximum_payout,version,settled_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,CASE WHEN $6='SETTLED' THEN date_trunc('milliseconds',clock_timestamp()) ELSE NULL END)`,
        [
          roundId,
          actorId,
          decimal(amount),
          decimal(totalBet(next)),
          JSON.stringify(next),
          settled ? "SETTLED" : "ACTIVE",
          decimal(paid),
          decimal(max),
          version,
        ],
      );
    } else {
      await client.query(
        `UPDATE blackjack_rounds SET total_bet=$2,state=$3::jsonb,status=$4,payout=$5,maximum_payout=$6,version=$7,
        settled_at=CASE WHEN $4='SETTLED' THEN date_trunc('milliseconds',clock_timestamp()) ELSE NULL END WHERE id=$1`,
        [
          roundId,
          decimal(totalBet(next)),
          JSON.stringify(next),
          settled ? "SETTLED" : "ACTIVE",
          decimal(paid),
          decimal(max),
          version,
        ],
      );
    }
    await client.query(
      "INSERT INTO blackjack_round_actions(id,round_id,sequence,kind,debit,action) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [operationId, roundId, version, action.kind, decimal(debit), JSON.stringify(action)],
    );
    let balance = user.balance,
      walletVersion = user.walletVersion;
    if (debit > 0) {
      const result = await applyBalanceMutation(
        {
          userId: actorId,
          delta: -debit,
          actorType: "PLAYER",
          actorId,
          source: "BLACKJACK_BET_DEBIT",
          referenceType: "BLACKJACK_ACTION",
          referenceId: operationId,
          metadata: { roundId, operation: action.kind },
        },
        client,
      );
      balance = result.user.balance;
      walletVersion = result.user.walletVersion;
    }
    if (settled) {
      const result = await applyBalanceMutation(
        {
          userId: actorId,
          delta: paid,
          actorType: "SYSTEM",
          source: "BLACKJACK_SETTLEMENT_CREDIT",
          referenceType: "BLACKJACK_ROUND",
          referenceId: roundId,
        },
        client,
      );
      balance = result.user.balance;
      walletVersion = result.user.walletVersion;
    }
    await publishLiveEvent(
      {
        type: "user_changed",
        userId: actorId,
        reason: `blackjack_${action.kind}`,
        at: new Date().toISOString(),
      },
      client,
    );
    return complete(200, {
      round: await findBlackjackRound(actorId, roundId, client),
      balance,
      walletVersion,
    });
  }).catch((error: unknown) => {
    // PostgreSQL constraint errors can include the entire private state in detail.
    // Preserve a diagnostic code but never forward row data to the WS logger.
    const safe = new Error("Blackjack transaction failed");
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
      Object.assign(safe, { code: error.code });
    throw safe;
  });
}
