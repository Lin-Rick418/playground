import { createHash, randomUUID } from "node:crypto";
import {
  fromMinorUnits,
  toMinorUnits,
  minorUnitsToDecimal,
  initialStormProgress,
  stormActionSchema,
  stormRoundSchema,
  stormSessionSchema,
  type ApiErrorCode,
  type StormAction,
  type StormProgress,
  type StormMathProfile,
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
import { queryRow, queryRows, toIsoString, type DbRow } from "../../lib/repositories/client.js";
import { fingerprintIdempotencyRequest } from "../../lib/idempotency.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { PostgresLoginRateLimitStore } from "../../lib/postgres-login-rate-limit-store.js";
import { spin } from "./math.js";
import { configuredSpinner } from "./math-v3.js";
import { spinBalanced } from "./math-v2.js";
import { activeStormProfile, savedStormProfile } from "./profiles.js";

export function stormExposure(
  progress: StormProgress,
  amount: number,
  profile?: StormMathProfile | null,
) {
  if (profile?.settings?.capScope === "spin")
    return progress.freeLeft
      ? (progress.freeLeft + profile.settings.freeMax - progress.freeGranted) *
          amount *
          profile.maxWinFactor
      : 0;
  if (profile)
    return progress.freeLeft
      ? fromMinorUnits(
          toMinorUnits(amount) * BigInt(profile.maxWinFactor) -
            toMinorUnits(progress.cycleWin ?? 0),
        )
      : 0;
  return progress.freeLeft ? (progress.freeLeft + 100 - progress.freeGranted) * amount * 25000 : 0;
}
function sessionFromRow(row: DbRow | null) {
  return stormSessionSchema.parse(
    row
      ? {
          progress: row.progress,
          amount: Number(row.amount),
          version: Number(row.version),
          ruleVersion: Number(row.rule_version),
        }
      : { progress: initialStormProgress(), amount: 10, version: 0, ruleVersion: 1 },
  );
}
export function publicStormRound(row: DbRow) {
  return stormRoundSchema.parse({
    id: row.id,
    amount: Number(row.stake),
    version: Number(row.version),
    ruleVersion: Number(row.rule_version),
    mathProfileId: row.math_profile_id ?? null,
    result: row.result,
    createdAt: toIsoString(row.created_at),
  });
}
export async function stormState(actorId: string) {
  return withTransaction(async (client) => {
    // Same user-first lock order as other instant games. This also gives reads
    // a coherent wallet/session snapshot during another tab's settlement.
    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user || !user.isActive || user.role !== "PLAYER") return null;
    const row = await queryRow(client, "SELECT * FROM storm_sessions WHERE user_id=$1", [actorId]);
    const session = sessionFromRow(row);
    const profile = session.progress.freeLeft
      ? row?.math_profile_id
        ? await savedStormProfile(client, String(row.math_profile_id))
        : null
      : await activeStormProfile(client);
    session.ruleVersion = profile?.settings ? 3 : profile ? 2 : 1;
    session.mathProfile = profile;
    const rows = await queryRows(
      client,
      "SELECT * FROM storm_rounds WHERE user_id=$1 ORDER BY version DESC LIMIT 5",
      [actorId],
    );
    return {
      session,
      lastRound: rows[0] ? publicStormRound(rows[0]) : null,
      recent: rows.map((row) => ({
        id: String(row.id),
        amount: Number(row.amount),
        stake: Number(row.stake),
        payout: Number(row.payout),
        wasFree: Number(row.amount) === 0,
        createdAt: toIsoString(row.created_at),
      })),
      balance: user.balance,
      walletVersion: user.walletVersion,
    };
  });
}
export async function mutateStorm(actorId: string, key: string, input: StormAction) {
  const action = stormActionSchema.parse(input),
    scope = "storm.spin";
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
        body: { code: "CONFLICT", message: "同一操作識別碼不能用於不同投注。" },
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
    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user || !user.isActive || user.role !== "PLAYER")
      return fail(403, "FORBIDDEN", "帳戶無法進行遊戲。");
    const row = await queryRow(client, "SELECT * FROM storm_sessions WHERE user_id=$1 FOR UPDATE", [
      actorId,
    ]);
    const before = sessionFromRow(row);
    if (before.version !== action.expectedVersion)
      return fail(409, "CONFLICT", "遊戲狀態已更新，請重新同步。");
    if (!before.progress.freeLeft && !env.stormEnabled)
      return fail(503, "SERVICE_UNAVAILABLE", "沙海神殿暫停接受新投注。");
    if (before.progress.freeLeft && before.amount !== action.amount)
      return fail(409, "CONFLICT", "免費系列期間須沿用原投注額。");
    const profile = before.progress.freeLeft
      ? row?.math_profile_id
        ? await savedStormProfile(client, String(row.math_profile_id))
        : null
      : await activeStormProfile(client, true);
    const ruleVersion = profile?.settings ? 3 : profile ? 2 : 1;
    if (
      action.ruleVersion !== ruleVersion ||
      (action.mathProfileId ?? null) !== (profile?.id ?? null)
    )
      return fail(409, "CONFLICT", "遊戲配率版本已更新，請重新同步後確認投注。");
    const [rate] = await new PostgresLoginRateLimitStore(client).increment(
      [
        {
          scope: "ENDPOINT_USER",
          keyHash: createHash("sha256").update(`storm.spin\0${actorId}`).digest("hex"),
          windowMs: 60000,
        },
      ],
      Date.now(),
    );
    if (!rate || rate.failures > 120)
      return fail(429, "RATE_LIMITED", "操作過於頻繁，請稍後再試。");
    const cost = before.progress.freeLeft ? 0 : action.amount;
    const balanceAfter = toMinorUnits(user.balance) - toMinorUnits(cost);
    if (balanceAfter < 0n) return fail(400, "VALIDATION_ERROR", "遊戲幣餘額不足。");
    const exposure = toMinorUnits(await getUserUnsettledMaximumPayout(actorId, client));
    const ownExposure = toMinorUnits(stormExposure(before.progress, before.amount, profile));
    // Reserve the entire possible free series (including future retriggers)
    // before drawing. A free spin consumes an already-reserved obligation.
    const required = before.progress.freeLeft
      ? ownExposure
      : toMinorUnits(
          action.amount *
            (profile
              ? profile.maxWinFactor *
                (profile.settings?.capScope === "spin" ? profile.settings.freeMax + 1 : 1)
              : 25000 * 101),
        );
    if (balanceAfter + exposure - ownExposure + required > toMinorUnits(MAX_ACCOUNT_BALANCE))
      return fail(400, "VALIDATION_ERROR", "最大派彩可能超過帳戶上限，請降低投注額。");
    const result = profile?.settings
      ? configuredSpinner({ ...profile, settings: profile.settings })(
          { ...before.progress, balance: user.balance },
          action.amount,
        )
      : profile
        ? spinBalanced({ ...before.progress, balance: user.balance }, action.amount, profile)
        : spin({ ...before.progress, balance: user.balance }, action.amount);
    const { balance: _balance, ...progress } = result.state;
    const session = stormSessionSchema.parse({
      progress,
      amount: action.amount,
      version: before.version + 1,
      ruleVersion,
      mathProfile: profile,
    });
    const id = randomUUID();
    const saved = await queryRow(
      client,
      `INSERT INTO storm_rounds(id,user_id,stake,amount,payout,result,version,rule_version,math_profile_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
      [
        id,
        actorId,
        action.amount,
        minorUnitsToDecimal(toMinorUnits(cost)),
        minorUnitsToDecimal(toMinorUnits(result.payout)),
        JSON.stringify(result),
        session.version,
        ruleVersion,
        profile?.id ?? null,
      ],
    );
    if (!saved) throw new Error("Storm round insert returned no row");
    await client.query(
      `INSERT INTO storm_sessions(user_id,amount,progress,version,rule_version,maximum_payout,math_profile_id,max_win_factor,cap_scope,free_max) VALUES($1,$2,$3::jsonb,$4,$6,$5,$7,$8,$9,$10)
      ON CONFLICT(user_id) DO UPDATE SET amount=EXCLUDED.amount,progress=EXCLUDED.progress,version=EXCLUDED.version,rule_version=EXCLUDED.rule_version,maximum_payout=EXCLUDED.maximum_payout,math_profile_id=EXCLUDED.math_profile_id,max_win_factor=EXCLUDED.max_win_factor,cap_scope=EXCLUDED.cap_scope,free_max=EXCLUDED.free_max`,
      [
        actorId,
        action.amount,
        JSON.stringify(progress),
        session.version,
        stormExposure(progress, action.amount, profile),
        ruleVersion,
        profile?.id ?? null,
        profile?.maxWinFactor ?? null,
        profile?.settings?.capScope ?? null,
        profile?.settings?.freeMax ?? null,
      ],
    );
    const metadata = {
      stake: action.amount,
      ruleVersion,
      mathProfileId: profile?.id ?? null,
      version: session.version,
      wasFree: result.wasFree,
    };
    await applyBalanceMutation(
      {
        userId: actorId,
        delta: -cost,
        actorType: "PLAYER",
        actorId,
        source: "STORM_BET_DEBIT",
        referenceType: "STORM_ROUND",
        referenceId: id,
        metadata,
      },
      client,
    );
    const settled = await applyBalanceMutation(
      {
        userId: actorId,
        delta: result.payout,
        actorType: "SYSTEM",
        source: "STORM_SETTLEMENT_CREDIT",
        referenceType: "STORM_ROUND",
        referenceId: id,
        metadata,
      },
      client,
    );
    if (toMinorUnits(settled.user.balance) !== toMinorUnits(result.state.balance))
      throw new Error("Storm wallet settlement mismatch");
    await publishLiveEvent(
      {
        type: "user_changed",
        userId: actorId,
        reason: "storm_settled",
        at: new Date().toISOString(),
      },
      client,
    );
    return complete(200, {
      session,
      round: publicStormRound(saved),
      balance: fromMinorUnits(toMinorUnits(settled.user.balance)),
      walletVersion: settled.user.walletVersion,
    });
  });
}
