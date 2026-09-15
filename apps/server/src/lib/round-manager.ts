import { sumMoney } from "@baccarat/contracts";
import { calculatePayout, dealRoundFromShoe, getMassachusettsCutCardConfig } from "./baccarat.js";
import { createOrGetActiveRound } from "./active-round-invariant.js";
import {
  applyBalanceMutation,
  cancelRoundAndRefundBets,
  createRound,
  ensureTableShoe,
  findRoundById,
  findUserById,
  getActiveRound,
  getTableShoe,
  listRoundBets,
  listTables,
  recordShoeDealAudit,
  replaceTableShoe,
  saveTableShoe,
  setTableRoundScheduleVersion,
  settleRound,
  updateRoundStatus,
  updateBetPayouts,
  validateActiveShoeAudit,
  withTransaction,
} from "./db.js";
import { publishLiveEvent } from "./live-events.js";
import { logger, toLogError } from "./logger.js";
import {
  type Clock,
  DEAL_ANIMATION_BUFFER_MS,
  getFreshRoundWindow,
  REVEAL_WINDOW_MS,
  systemClock,
} from "./round-schedule.js";
import {
  createSerializedIntervalRunner,
  type SerializedIntervalRunner,
} from "./serialized-interval.js";
import type { GameTableRecord } from "../types/domain.js";

const LOOP_INTERVAL_MS = 1000;
const MIN_CARDS_TO_COMPLETE_ROUND = 6;
const ROUND_SCHEDULE_VERSION = 1;
const roundLogger = logger.child({ component: "round-manager" });

const roundManagerState = globalThis as typeof globalThis & {
  __baccaratRoundManagerLoop?: SerializedIntervalRunner;
};

async function createOpenRound(
  table: GameTableRecord,
  initializePhase = false,
  clock: Clock = systemClock,
) {
  const { round, created } = await createOrGetActiveRound(
    () =>
      withTransaction(async (client) => {
        const shoe = await ensureTableShoe(table.id, client);
        const shouldApplyPhase = initializePhase || table.roundScheduleVersion < ROUND_SCHEDULE_VERSION;
        // Read the clock only after preceding DB work. createRound immediately
        // validates this window against its own persistence timestamp.
        const roundWindow = getFreshRoundWindow(table, clock, shouldApplyPhase);

        const nextRound = await createRound(
          {
            tableId: table.id,
            shoeId: shoe.shoeId,
            status: "OPEN",
            ...roundWindow,
          },
          client,
        );

        if (shouldApplyPhase) {
          await setTableRoundScheduleVersion(table.id, ROUND_SCHEDULE_VERSION, client);
        }

        return nextRound;
      }),
    () => getActiveRound(table.id),
  );

  if (created) {
    await publishLiveEvent({
      type: "table_changed",
      tableId: table.id,
      reason: "round_opened",
      at: new Date().toISOString(),
    });
    roundLogger.info({
      event: "round_opened",
      tableId: table.id,
      roundId: round.id,
      shoeId: round.shoeId,
    }, "Round opened");
  }

  return round;
}

export async function settleActiveRound(roundId: string, tableId: string) {
  const affectedUserIds = new Set<string>();

  const settlementEvent = await withTransaction(async (client) => {
    // Guard against concurrent settlement (e.g. two worker processes): lock
    // the round row and bail out unless it is still awaiting settlement.
    const round = await findRoundById(roundId, client, { forUpdate: true });

    if (!round || round.status !== "LOCKED") {
      return null;
    }

    const shoe = await getTableShoe(tableId, client, { forUpdate: true });
    let cancellationReason: string | null = null;

    if (round.tableId !== tableId || !shoe || !shoe.shoeId || round.shoeId !== shoe.shoeId) {
      cancellationReason = "SHOE_BINDING_INVALID";
    } else if (shoe.cards.length < MIN_CARDS_TO_COMPLETE_ROUND) {
      cancellationReason = "INSUFFICIENT_COMMITTED_CARDS";
    } else {
      const audit = await validateActiveShoeAudit(shoe.shoeId, tableId, client);
      if (!audit.valid) cancellationReason = audit.reason ?? "SHOE_AUDIT_INVALID";
    }

    if (cancellationReason) {
      const refundedUserIds = await cancelRoundAndRefundBets(roundId, cancellationReason, client);
      for (const userId of refundedUserIds) affectedUserIds.add(userId);
      return {
        event: "round_cancelled_refunded",
        tableId,
        roundId,
        cancellationReason,
        refundedUserCount: refundedUserIds.length,
      } as const;
    }

    if (!shoe) throw new Error("Validated shoe disappeared before settlement");

    const wasLastHand = shoe.lastHandPending;
    const cardsBeforeDeal = [...shoe.cards];
    const result = dealRoundFromShoe(shoe);
    const dealtCards = cardsBeforeDeal.slice().reverse().slice(0, cardsBeforeDeal.length - shoe.cards.length);
    const bets = await listRoundBets(roundId, client);
    const payoutsByUser = new Map<string, number>();
    const betPayouts: { betId: string; payout: number }[] = [];

    for (const bet of bets) {
      const payout = calculatePayout(bet.betType, bet.amount, result);
      affectedUserIds.add(bet.userId);
      betPayouts.push({ betId: bet.id, payout });

      if (payout > 0) {
        payoutsByUser.set(bet.userId, sumMoney([payoutsByUser.get(bet.userId) ?? 0, payout]));
      }
    }

    await updateBetPayouts(betPayouts, client);

    for (const [userId, payout] of payoutsByUser.entries()) {
      const user = await findUserById(userId, client, { forUpdate: true });

      if (user) {
        await applyBalanceMutation(
          {
            userId: user.id,
            delta: payout,
            actorType: "SYSTEM",
            source: "SETTLEMENT_CREDIT",
            referenceType: "ROUND",
            referenceId: roundId,
            metadata: { tableId },
          },
          client,
        );
      }
    }

    await settleRound(roundId, result, client);
    await recordShoeDealAudit(
      {
        shoeId: shoe.shoeId,
        roundId,
        dealtCards,
        result: {
          playerCards: result.playerCards,
          bankerCards: result.bankerCards,
          playerTotal: result.playerTotal,
          bankerTotal: result.bankerTotal,
          winner: result.winner,
          playerPair: result.playerPair,
          bankerPair: result.bankerPair,
        },
      },
      client,
    );

    if (wasLastHand) {
      const nextShoe = await replaceTableShoe(tableId, client, "CUT_CARD_LAST_HAND");
      return {
        event: "round_settled",
        tableId,
        roundId,
        shoeId: shoe.shoeId,
        winner: result.winner,
        betCount: bets.length,
        totalAmount: sumMoney(bets.map((bet) => bet.amount)),
        totalPayout: sumMoney(betPayouts.map((bet) => bet.payout)),
        nextShoeId: nextShoe.shoeId,
      } as const;
    }

    if (result.cutCardAppeared) {
      shoe.lastHandPending = true;
    }

    await saveTableShoe(tableId, shoe.shoeId, shoe, client);
    return {
      event: "round_settled",
      tableId,
      roundId,
      shoeId: shoe.shoeId,
      winner: result.winner,
      betCount: bets.length,
      totalAmount: sumMoney(bets.map((bet) => bet.amount)),
      totalPayout: sumMoney(betPayouts.map((bet) => bet.payout)),
    } as const;
  });

  if (!settlementEvent) {
    return;
  }

  roundLogger.info(settlementEvent, settlementEvent.event === "round_settled"
    ? "Round settled"
    : "Round cancelled and bets refunded");
  if ("nextShoeId" in settlementEvent) {
    roundLogger.info({
      event: "shoe_replaced",
      tableId,
      roundId,
      previousShoeId: settlementEvent.shoeId,
      shoeId: settlementEvent.nextShoeId,
      reason: "CUT_CARD_LAST_HAND",
    }, "Table shoe replaced");
  }

  await publishLiveEvent({
    type: "table_changed",
    tableId,
    reason: "round_settled",
    at: new Date().toISOString(),
  });

  await Promise.all(
    Array.from(affectedUserIds, (userId) =>
      publishLiveEvent({
        type: "user_changed",
        userId,
        reason: "round_settled",
        at: new Date().toISOString(),
      }),
    ),
  );
}

async function tickTable(table: GameTableRecord) {
  let round = await getActiveRound(table.id);
  const now = Date.now();

  if (!round) {
    await createOpenRound(table, true);
    return;
  }

  const closesAt = new Date(round.bettingClosesAt).getTime();

  if (round.status === "OPEN" && now >= closesAt) {
    round = await updateRoundStatus(round.id, "LOCKED");
    await publishLiveEvent({
      type: "table_changed",
      tableId: table.id,
      reason: "round_locked",
      at: new Date().toISOString(),
    });
    roundLogger.info({
      event: "round_locked",
      tableId: table.id,
      roundId: round.id,
      shoeId: round.shoeId,
    }, "Round locked");
  }

  if (round.status === "LOCKED" && now >= closesAt + REVEAL_WINDOW_MS) {
    await settleActiveRound(round.id, table.id);
    await createOpenRound(table);
  }
}

export function getRoundConfig() {
  const cutCardConfig = getMassachusettsCutCardConfig();

  return {
    revealWindowMs: REVEAL_WINDOW_MS,
    dealAnimationBufferMs: DEAL_ANIMATION_BUFFER_MS,
    cutCardMinRemaining: cutCardConfig.minRemaining,
    cutCardMaxRemaining: cutCardConfig.maxRemaining,
    reshuffleRule: "massachusetts_cut_card_last_hand",
  };
}

export type RoundManagerTickResult = { healthy: boolean; detail?: string };

export async function startRoundManager(options?: {
  onTickComplete?: (result: RoundManagerTickResult) => Promise<void> | void;
}) {
  if (roundManagerState.__baccaratRoundManagerLoop) {
    return;
  }

  const runTick = async () => {
    let tickResult: RoundManagerTickResult = { healthy: false, detail: "Round manager tick did not complete" };

    try {
      const tables = await listTables();

      const results = await Promise.allSettled(tables.map((table) => tickTable(table)));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          roundLogger.error({
            event: "table_tick_failed",
            tableId: tables[index]?.id,
            err: toLogError(result.reason),
          }, "Table tick failed");
        }
      }
      const rejectedCount = results.filter((result) => result.status === "rejected").length;
      tickResult = rejectedCount === 0
        ? { healthy: true }
        : { healthy: false, detail: `${rejectedCount} table tick(s) failed` };
    } catch (error) {
      roundLogger.error({
        event: "round_manager_tick_failed",
        err: toLogError(error),
      }, "Round manager tick failed");
      tickResult = {
        healthy: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        await options?.onTickComplete?.(tickResult);
      } catch (error) {
        roundLogger.error({
          event: "round_manager_heartbeat_failed",
          err: toLogError(error),
        }, "Round manager heartbeat failed");
      }
    }
  };

  const loop = createSerializedIntervalRunner(runTick, LOOP_INTERVAL_MS);
  roundManagerState.__baccaratRoundManagerLoop = loop;

  try {
    await loop.start();
  } catch (error) {
    if (roundManagerState.__baccaratRoundManagerLoop === loop) {
      delete roundManagerState.__baccaratRoundManagerLoop;
    }
    throw error;
  }
}

export async function stopRoundManager() {
  const loop = roundManagerState.__baccaratRoundManagerLoop;
  if (!loop) return;

  await loop.stop();
  if (roundManagerState.__baccaratRoundManagerLoop === loop) {
    delete roundManagerState.__baccaratRoundManagerLoop;
  }
}
