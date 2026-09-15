import { toMinorUnits, type ApiErrorCode } from "@baccarat/contracts";
import {
  getMaximumPayout,
  getSafeBalanceAfterChange,
  isValidBetForTable,
  isValidTableMoneyPolicy,
  MAX_ACCOUNT_BALANCE,
} from "../../lib/account-policy.js";
import {
  applyBalanceMutation,
  claimIdempotencyKey,
  completeIdempotencyKey,
  createBet,
  findTableById,
  findUserById,
  getActiveRound,
  getUserUnsettledMaximumPayout,
  listUserRoundBets,
  withTransaction,
} from "../../lib/db.js";
import { fingerprintIdempotencyRequest } from "../../lib/idempotency.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { isRoundBettingOpen } from "../../lib/round-schedule.js";
import type { BetType } from "../../types/domain.js";

type PlaceBetBody = Record<string, unknown>;

export type PlaceBetResult =
  | { kind: "success"; statusCode: number; body: PlaceBetBody }
  | { kind: "error"; statusCode: number; body: PlaceBetBody };

type PlaceBetsInput = {
  actorId: string;
  tableId: string;
  idempotencyKey: string;
  bets: { betType: BetType; amount: number }[];
};

function storedResult(statusCode: number, body: PlaceBetBody): PlaceBetResult {
  return statusCode >= 400
    ? { kind: "error", statusCode, body }
    : { kind: "success", statusCode, body };
}

export async function placeBets(input: PlaceBetsInput): Promise<PlaceBetResult> {
  const { actorId, tableId, idempotencyKey, bets: requestedBets } = input;
  const scope = `game.bet:${tableId}`;
  const requestHash = fingerprintIdempotencyRequest({ tableId, bets: requestedBets });

  return withTransaction(async (client) => {
    const totalBet = requestedBets.reduce((sum, bet) => sum + bet.amount, 0);
    const claim = await claimIdempotencyKey<PlaceBetBody>(
      { actorId, scope, key: idempotencyKey, requestHash },
      client,
    );

    if (claim.kind === "replay") {
      return storedResult(claim.statusCode, claim.response);
    }
    if (claim.kind === "conflict") {
      return {
        kind: "error",
        statusCode: 409,
        body: {
          code: "CONFLICT",
          message: "Idempotency-Key was already used for a different request",
        },
      };
    }

    async function fail(
      statusCode: number,
      code: ApiErrorCode,
      message: string,
    ): Promise<PlaceBetResult> {
      const body = { code, message };
      await completeIdempotencyKey(
        { actorId, scope, key: idempotencyKey, requestHash, statusCode, response: body },
        client,
      );
      return { kind: "error", statusCode, body };
    }

    const table = await findTableById(tableId, client);
    if (!table) return fail(404, "NOT_FOUND", "Table not found");
    if (!isValidTableMoneyPolicy(table.minBet, table.maxBet)) {
      return fail(503, "SERVICE_UNAVAILABLE", "Table betting policy is invalid");
    }

    const activeRound = await getActiveRound(table.id, client, { forUpdate: true });
    const now = Date.now();
    if (!activeRound || !isRoundBettingOpen(activeRound, now)) {
      return fail(400, "VALIDATION_ERROR", "Betting is closed");
    }
    if (requestedBets.some((bet) => !isValidBetForTable(bet.amount, table.minBet, table.maxBet))) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `Each bet must be between ${table.minBet} and ${table.maxBet} in supported denominations`,
      );
    }

    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user) return fail(404, "NOT_FOUND", "User not found");
    if (!user.isActive || user.role !== "PLAYER") {
      return fail(403, "FORBIDDEN", "Account is not allowed to bet");
    }

    const existingRoundBets = await listUserRoundBets(user.id, activeRound.id, client);
    const existingBetTotals = new Map<string, number>();
    for (const bet of existingRoundBets) {
      existingBetTotals.set(bet.betType, (existingBetTotals.get(bet.betType) ?? 0) + bet.amount);
    }
    for (const bet of requestedBets) {
      const nextTotal = (existingBetTotals.get(bet.betType) ?? 0) + bet.amount;
      if (nextTotal > table.maxBet) {
        return fail(400, "VALIDATION_ERROR", `單一玩法最高下注 ${table.maxBet}`);
      }
    }

    if (user.balance < totalBet) return fail(400, "VALIDATION_ERROR", "Insufficient balance");
    const balanceAfterStake = getSafeBalanceAfterChange(user.balance, -totalBet);
    if (balanceAfterStake === null) {
      return fail(400, "VALIDATION_ERROR", "Bet would make balance invalid");
    }

    const [existingUnsettledMaximumPayout, newMaximumPayout] = await Promise.all([
      getUserUnsettledMaximumPayout(user.id, client),
      Promise.resolve(
        requestedBets.reduce(
          (sum, bet) => sum + getMaximumPayout(bet.betType, bet.amount),
          0,
        ),
      ),
    ]);
    const maximumPossibleBalance =
      toMinorUnits(balanceAfterStake) + toMinorUnits(existingUnsettledMaximumPayout) + toMinorUnits(newMaximumPayout);
    if (
      maximumPossibleBalance > toMinorUnits(MAX_ACCOUNT_BALANCE)
    ) {
      return fail(400, "VALIDATION_ERROR", "Bet could exceed the supported account balance");
    }

    const placedBets = [];
    let updatedUser = user;
    for (const bet of requestedBets) {
      const createdBet = await createBet(
        { userId: user.id, roundId: activeRound.id, betType: bet.betType, amount: bet.amount },
        client,
      );
      placedBets.push({
        id: createdBet.id,
        betType: createdBet.betType,
        amount: createdBet.amount,
        payout: createdBet.payout,
        createdAt: createdBet.createdAt,
      });
      const mutation = await applyBalanceMutation(
        {
          userId: user.id,
          delta: -bet.amount,
          actorType: "PLAYER",
          actorId: user.id,
          source: "BET_DEBIT",
          referenceType: "BET",
          referenceId: createdBet.id,
          metadata: { roundId: activeRound.id, betType: bet.betType },
        },
        client,
      );
      updatedUser = mutation.user;
    }

    const body = {
      table,
      round: activeRound,
      bets: placedBets,
      balance: updatedUser.balance,
      walletVersion: updatedUser.walletVersion,
    };
    await publishLiveEvent(
      { type: "user_changed", userId: user.id, reason: "bet_placed", at: new Date().toISOString() },
      client,
    );
    await completeIdempotencyKey(
      { actorId, scope, key: idempotencyKey, requestHash, statusCode: 200, response: body },
      client,
    );
    return { kind: "success", statusCode: 200, body };
  });
}
