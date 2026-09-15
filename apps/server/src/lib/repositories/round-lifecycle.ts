import { randomUUID } from "node:crypto";
import type { RoundWinner } from "../../types/domain.js";
import type { Card } from "../baccarat.js";
import { MAX_ACCOUNT_BALANCE, MONEY_DENOMINATION } from "../account-policy.js";
import { type DbExecutor, isPoolClient, pool, queryRows, requireRecord, withTransaction } from "./client.js";
import { applyBalanceMutation } from "./users.js";
import { findRoundById } from "./rounds.js";

export async function cancelRoundAndRefundBets(
  roundId: string,
  reason: string,
  executor: DbExecutor = pool,
): Promise<string[]> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => cancelRoundAndRefundBets(roundId, reason, client));
  }

  const round = await findRoundById(roundId, executor, { forUpdate: true });
  if (!round) throw new Error(`Cannot cancel missing round ${roundId}`);
  if (round.status === "CANCELLED") return [] as string[];
  if (round.status === "SETTLED") throw new Error(`Cannot cancel settled round ${roundId}`);

  const refundRows = await queryRows(
    executor,
    `SELECT user_id, SUM(amount) AS refund
     FROM bets
     WHERE round_id = $1
     GROUP BY user_id
     ORDER BY user_id ASC`,
    [roundId],
  );

  for (const row of refundRows) {
    const userId = String(row.user_id);
    const refund = Number(row.refund);
    await applyBalanceMutation(
      {
        userId,
        delta: refund,
        actorType: "SYSTEM",
        source: "SETTLEMENT_CREDIT",
        referenceType: "ROUND",
        referenceId: roundId,
        metadata: { cancellationReason: reason, refund: true },
      },
      executor,
    );
  }

  await executor.query("UPDATE bets SET payout = amount WHERE round_id = $1", [roundId]);
  await executor.query(
    `UPDATE game_rounds
     SET status = 'CANCELLED', cancellation_reason = $1, settled_at = $2
     WHERE id = $3`,
    [reason, new Date().toISOString(), roundId],
  );

  return refundRows.map((row) => String(row.user_id));
}

export async function settleRound(
  roundId: string,
  result: {
    playerCards: Card[];
    bankerCards: Card[];
    playerTotal: number;
    bankerTotal: number;
    winner: RoundWinner;
    playerPair: boolean;
    bankerPair: boolean;
  },
  executor: DbExecutor = pool,
) {
  const settledAt = new Date().toISOString();

  await executor.query(
    `UPDATE game_rounds
     SET player_cards = $1::jsonb,
         banker_cards = $2::jsonb,
         player_total = $3,
         banker_total = $4,
         winner = $5,
         status = 'SETTLED',
         settled_at = $6,
         player_pair = $7,
         banker_pair = $8
     WHERE id = $9`,
    [
      JSON.stringify(result.playerCards),
      JSON.stringify(result.bankerCards),
      result.playerTotal,
      result.bankerTotal,
      result.winner,
      settledAt,
      result.playerPair,
      result.bankerPair,
      roundId,
    ],
  );

  return requireRecord(await findRoundById(roundId, executor), "Settled round");
}

export async function purgeSettledRoundsBefore(
  cutoffIso: string,
  executor: DbExecutor = pool,
): Promise<{ deletedRounds: number; deletedBets: number }> {
  if (isPoolClient(executor)) {
    const deletedBets = await executor.query(
      `DELETE FROM bets
       WHERE round_id IN (
         SELECT id FROM game_rounds
         WHERE status IN ('SETTLED', 'CANCELLED')
           AND settled_at IS NOT NULL
           AND settled_at < $1
       )`,
      [cutoffIso],
    );
    const deletedRounds = await executor.query(
      "DELETE FROM game_rounds WHERE status IN ('SETTLED', 'CANCELLED') AND settled_at IS NOT NULL AND settled_at < $1",
      [cutoffIso],
    );

    return { deletedRounds: deletedRounds.rowCount ?? 0, deletedBets: deletedBets.rowCount ?? 0 };
  }

  return withTransaction((client) => purgeSettledRoundsBefore(cutoffIso, client));
}
export async function createBalanceAdjustment(
  input: {
    adminId: string;
    userId: string;
    amount: number;
    note?: string;
  },
  executor: DbExecutor = pool,
) {
  if (
    !Number.isSafeInteger(input.amount) ||
    input.amount === 0 ||
    Math.abs(input.amount) > MAX_ACCOUNT_BALANCE ||
    input.amount % MONEY_DENOMINATION !== 0
  ) {
    throw new RangeError("Balance adjustment violates money policy");
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await executor.query(
    "INSERT INTO balance_adjustments (id, admin_id, user_id, amount, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, input.adminId, input.userId, input.amount, input.note ?? null, createdAt],
  );

  return { id, ...input, createdAt };
}
