import { randomUUID } from "node:crypto";
import {
  type HiloAction,
  type HiloRound,
  type HiloPreview,
  type HiloChoice,
  type ApiErrorCode,
  hiloActionSchema,
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
import {
  choices,
  drawCard,
  multiplier,
  nextRatio,
  options,
  payout,
  withinLimit,
  winningRanks,
  wins,
  mustCashout,
  MAX_SKIPS,
  MAX_MULTIPLIER,
  type Ratio,
} from "./math.js";

const roundSelect = `SELECT r.*, COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('numerator',s.numerator::text,'denominator',s.denominator::text) ORDER BY s.sequence)
  FROM hilo_round_steps s WHERE s.round_id = r.id), '[]'::jsonb) AS steps FROM hilo_rounds r`;
function ratioOf(row: DbRow): Ratio {
  return { numerator: BigInt(String(row.numerator)), denominator: BigInt(String(row.denominator)) };
}
function publicPreview(row: DbRow): HiloPreview {
  return { id: String(row.id), card: Number(row.card), version: Number(row.version) };
}
export function publicHiloRound(row: DbRow): HiloRound {
  const amount = fromMinorUnits(toMinorUnits(String(row.amount))),
    ratio = ratioOf(row);
  const status = row.status as HiloRound["status"];
  const successCount = Number(row.success_count);
  return {
    id: String(row.id),
    amount,
    initialCard: Number(row.initial_card),
    card: Number(row.card),
    status,
    successCount,
    skipCount: Number(row.skip_count),
    multiplier: successCount ? multiplier(ratio) : 0,
    payout: Number(row.payout),
    cashoutAmount: status === "ACTIVE" && successCount > 0 ? payout(amount, ratio) : 0,
    options: options(Number(row.card), amount, ratio, status === "ACTIVE"),
    steps: (row.steps as DbRow[]).map((s) => ({
      sequence: Number(s.sequence),
      kind: s.kind as "guess" | "skip",
      fromCard: Number(s.from_card),
      card: Number(s.card),
      choice: s.choice as HiloChoice | null,
      won: s.won as boolean | null,
      multiplier: ratioOf(s).numerator < ratioOf(s).denominator ? 0 : multiplier(ratioOf(s)),
    })),
    version: Number(row.version),
    ruleVersion: 1,
    createdAt: toIsoString(row.created_at),
    settledAt: row.settled_at ? toIsoString(row.settled_at) : null,
  };
}
export async function findHiloRound(actorId: string, id?: string, executor: DbExecutor = pool) {
  const row = await queryRow(
    executor,
    `${roundSelect} WHERE r.user_id = $1 AND ${id ? "r.id = $2" : "r.status = 'ACTIVE'"}`,
    id ? [actorId, id] : [actorId],
  );
  return row ? publicHiloRound(row) : null;
}
export async function hiloState(actorId: string) {
  // Serialize the two reads with mutations so preview and round belong to the same snapshot.
  return withTransaction(async (client) => {
    await findUserById(actorId, client, { forUpdate: true });
    const row = await queryRow(client, "SELECT * FROM hilo_previews WHERE user_id = $1", [actorId]);
    return {
      preview: row ? publicPreview(row) : null,
      round: await findHiloRound(actorId, undefined, client),
    };
  });
}
export async function hiloHistory(
  actorId: string,
  page: { limit: number; cursor: HistoryCursor | null },
) {
  const rows = await queryRows(
    pool,
    `${roundSelect} WHERE r.user_id = $1 AND r.status <> 'ACTIVE'
    AND ($2::timestamptz IS NULL OR (r.settled_at,r.created_at,r.id) < ($2::timestamptz,$3::timestamptz,$4::text))
    ORDER BY r.settled_at DESC,r.created_at DESC,r.id DESC LIMIT $5`,
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
    items: items.map(publicHiloRound),
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
export async function mutateHilo(
  actorId: string,
  key: string,
  input: HiloAction,
  draw: () => number = drawCard,
) {
  const action = hiloActionSchema.parse(input);
  // Only free preview requests expire. Every accepted-money operation survives retention.
  const scope =
    action.kind === "prepare" || action.kind === "refresh_preview"
      ? "hilo-preview"
      : "hilo.mutation";
  const requestHash = fingerprintIdempotencyRequest(action);
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
    let balance = user.balance,
      walletVersion = user.walletVersion;
    let roundId: string | undefined;
    let preview: HiloPreview | null = null;
    if (action.kind === "prepare" || action.kind === "refresh_preview" || action.kind === "start") {
      if (!env.hiloEnabled)
        return fail(503, "SERVICE_UNAVAILABLE", "Hi-Lo 暫停接受新投注，既有局仍可繼續。");
      if (await findHiloRound(actorId, undefined, client))
        return fail(409, "CONFLICT", "請先完成目前的 Hi-Lo。");
      let row = await queryRow(
        client,
        "SELECT * FROM hilo_previews WHERE user_id = $1 FOR UPDATE",
        [actorId],
      );
      if (action.kind === "prepare") {
        row ??= await queryRow(
          client,
          "INSERT INTO hilo_previews(user_id,id,card) VALUES($1,$2,$3) RETURNING *",
          [actorId, randomUUID(), draw()],
        );
        preview = publicPreview(row);
      } else {
        if (!row || row.id !== action.previewId || Number(row.version) !== action.expectedVersion)
          return fail(409, "CONFLICT", "起始牌已更新，請同步後再試。");
        if (action.kind === "refresh_preview") {
          row = await queryRow(
            client,
            "UPDATE hilo_previews SET card=$2, version=version+1 WHERE user_id=$1 RETURNING *",
            [actorId, draw()],
          );
          preview = publicPreview(row);
        } else {
          const after = toMinorUnits(balance) - toMinorUnits(action.amount);
          if (after < 0n) return fail(400, "VALIDATION_ERROR", "餘額不足。");
          const maximum = action.amount * MAX_MULTIPLIER;
          const exposure = await getUserUnsettledMaximumPayout(actorId, client);
          if (
            after + toMinorUnits(exposure) + toMinorUnits(maximum) >
            toMinorUnits(MAX_ACCOUNT_BALANCE)
          )
            return fail(400, "VALIDATION_ERROR", "最大派彩可能超過帳戶上限，請降低投注額。");
          roundId = randomUUID();
          await client.query(
            "INSERT INTO hilo_rounds(id,user_id,amount,initial_card,card,maximum_payout) VALUES($1,$2,$3,$4,$4,$5)",
            [roundId, actorId, action.amount, row.card, maximum],
          );
          await client.query("DELETE FROM hilo_previews WHERE user_id=$1", [actorId]);
          const mutation = await applyBalanceMutation(
            {
              userId: actorId,
              delta: -action.amount,
              actorType: "PLAYER",
              actorId,
              source: "HILO_BET_DEBIT",
              referenceType: "HILO_ROUND",
              referenceId: roundId,
              metadata: { ruleVersion: 1 },
            },
            client,
          );
          balance = mutation.user.balance;
          walletVersion = mutation.user.walletVersion;
        }
      }
    } else {
      roundId = action.roundId;
      const row = await queryRow(
        client,
        "SELECT * FROM hilo_rounds WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [roundId, actorId],
      );
      if (!row) return fail(404, "NOT_FOUND", "Hi-Lo round not found");
      if (row.status !== "ACTIVE" || Number(row.version) !== action.expectedVersion)
        return fail(409, "CONFLICT", "牌局已更新，請同步後再試。");
      let ratio = ratioOf(row),
        card = Number(row.card),
        successes = Number(row.success_count),
        skips = Number(row.skip_count);
      let status = "ACTIVE",
        paid = 0;
      if (action.kind === "cashout") {
        if (!successes) return fail(409, "CONFLICT", "至少猜對一次才能收款。");
        status = "CASHED_OUT";
      } else {
        let won: boolean | null = null;
        if (action.kind === "skip") {
          if (skips >= MAX_SKIPS) return fail(409, "CONFLICT", "本局跳牌次數已用完。");
          skips++;
        } else {
          if (!choices(card).includes(action.choice))
            return fail(400, "VALIDATION_ERROR", "目前牌不允許此選項。");
          const next = nextRatio(ratio, winningRanks(card, action.choice));
          if (!withinLimit(next)) return fail(409, "CONFLICT", "此選項超過最高倍率。");
        }
        const nextCard = draw();
        if (action.kind === "guess") {
          won = wins(card, nextCard, action.choice);
          if (won) {
            successes++;
            ratio = nextRatio(ratio, winningRanks(card, action.choice));
          } else status = "LOST";
        }
        // Every draw is persisted in the same transaction as the resulting state.
        await client.query(
          `INSERT INTO hilo_round_steps(round_id,sequence,kind,from_card,card,choice,won,numerator,denominator)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            roundId,
            Number(row.version),
            action.kind,
            card,
            nextCard,
            action.kind === "guess" ? action.choice : null,
            won,
            ratio.numerator.toString(),
            ratio.denominator.toString(),
          ],
        );
        card = nextCard;
        if (status === "ACTIVE" && successes > 0 && mustCashout(card, ratio, skips))
          status = "CASHED_OUT";
      }
      if (status === "CASHED_OUT") {
        paid = payout(Number(row.amount), ratio);
        const mutation = await applyBalanceMutation(
          {
            userId: actorId,
            delta: paid,
            actorType: "SYSTEM",
            source: "HILO_SETTLEMENT_CREDIT",
            referenceType: "HILO_ROUND",
            referenceId: roundId,
            metadata: { successCount: successes, ruleVersion: 1 },
          },
          client,
        );
        balance = mutation.user.balance;
        walletVersion = mutation.user.walletVersion;
      }
      await client.query(
        `UPDATE hilo_rounds SET card=$2,numerator=$3,denominator=$4,success_count=$5,skip_count=$6,status=$7,payout=$8,
        version=version+1, settled_at=CASE WHEN $7='ACTIVE' THEN NULL ELSE date_trunc('milliseconds',clock_timestamp()) END WHERE id=$1`,
        [
          roundId,
          card,
          ratio.numerator.toString(),
          ratio.denominator.toString(),
          successes,
          skips,
          status,
          minorUnitsToDecimal(toMinorUnits(paid)),
        ],
      );
    }
    if (roundId)
      await publishLiveEvent(
        {
          type: "user_changed",
          userId: actorId,
          reason: `hilo_${action.kind}`,
          at: new Date().toISOString(),
        },
        client,
      );
    return complete(200, {
      preview,
      round: roundId ? await findHiloRound(actorId, roundId, client) : null,
      balance,
      walletVersion,
    });
  });
}
