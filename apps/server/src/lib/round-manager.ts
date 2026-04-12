import { calculatePayout, dealRoundFromShoe, getMassachusettsCutCardConfig } from "./baccarat.js";
import {
  createRound,
  ensureTableShoe,
  findUserById,
  getActiveRound,
  getTableShoe,
  listRoundBets,
  listTables,
  purgeSettledRoundsBefore,
  replaceTableShoe,
  saveTableShoe,
  settleRound,
  updateBetPayout,
  updateRoundStatus,
  updateUserBalance,
  withTransaction,
} from "./db.js";
import { publishLiveEvent } from "./live-events.js";
import type { GameTableRecord } from "../types/domain.js";

const REVEAL_WINDOW_MS = 5000;
const LOOP_INTERVAL_MS = 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SETTLED_ROUND_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEAL_ANIMATION_BUFFER_MS = 7000;
const MIN_CARDS_TO_COMPLETE_ROUND = 6;

function getTableRoundDurationMs(table: GameTableRecord) {
  return table.roundDurationMs;
}

const roundManagerState = globalThis as typeof globalThis & {
  __baccaratRoundManagerInterval?: NodeJS.Timeout;
  __baccaratNextCleanupAt?: number;
  __baccaratRoundManagerTicking?: boolean;
};

async function createOpenRound(table: GameTableRecord, startTime = Date.now()) {
  const round = await withTransaction(async (client) => {
    const shoe = await ensureTableShoe(table.id, client);
    const opensAtMs = startTime + DEAL_ANIMATION_BUFFER_MS;
    const opensAt = new Date(opensAtMs).toISOString();
    const closesAt = new Date(opensAtMs + getTableRoundDurationMs(table)).toISOString();

    return createRound(
      {
        tableId: table.id,
        shoeId: shoe.shoeId,
        status: "OPEN",
        bettingOpensAt: opensAt,
        bettingClosesAt: closesAt,
      },
      client,
    );
  });

  await publishLiveEvent({
    type: "table_changed",
    tableId: table.id,
    reason: "round_opened",
    at: new Date().toISOString(),
  });

  return round;
}

async function settleActiveRound(roundId: string, tableId: string) {
  const affectedUserIds = new Set<string>();

  await withTransaction(async (client) => {
    let shoe = await getTableShoe(tableId, client, { forUpdate: true });

    if (!shoe || !shoe.shoeId || shoe.cards.length < MIN_CARDS_TO_COMPLETE_ROUND) {
      shoe = await replaceTableShoe(tableId, client);
    }

    const wasLastHand = shoe.lastHandPending;
    const result = dealRoundFromShoe(shoe);
    const bets = await listRoundBets(roundId, client);
    const payoutsByUser = new Map<string, number>();

    for (const bet of bets) {
      const payout = calculatePayout(bet.betType, bet.amount, result);
      affectedUserIds.add(bet.userId);
      await updateBetPayout(bet.id, payout, client);

      if (payout > 0) {
        payoutsByUser.set(bet.userId, (payoutsByUser.get(bet.userId) ?? 0) + payout);
      }
    }

    for (const [userId, payout] of payoutsByUser.entries()) {
      const user = await findUserById(userId, client, { forUpdate: true });

      if (user) {
        await updateUserBalance(user.id, user.balance + payout, client);
      }
    }

    await settleRound(roundId, result, client);

    if (wasLastHand) {
      await replaceTableShoe(tableId, client);
      return;
    }

    if (result.cutCardAppeared) {
      shoe.lastHandPending = true;
    }

    await saveTableShoe(tableId, shoe.shoeId, shoe, client);
  });

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
    await createOpenRound(table, now);
    return;
  }

  const closesAt = new Date(round.bettingClosesAt).getTime();

  if (round.status === "OPEN" && now >= closesAt) {
    round = (await updateRoundStatus(round.id, "LOCKED")) ?? round;
    await publishLiveEvent({
      type: "table_changed",
      tableId: table.id,
      reason: "round_locked",
      at: new Date().toISOString(),
    });
  }

  if (round.status === "LOCKED" && now >= closesAt + REVEAL_WINDOW_MS) {
    await settleActiveRound(round.id, table.id);
    await createOpenRound(table, now);
  }
}

async function runDailyCleanup(now: number) {
  if (!roundManagerState.__baccaratNextCleanupAt) {
    roundManagerState.__baccaratNextCleanupAt = now;
  }

  if (now < roundManagerState.__baccaratNextCleanupAt) {
    return;
  }

  const cutoffIso = new Date(now - SETTLED_ROUND_RETENTION_MS).toISOString();
  const result = await purgeSettledRoundsBefore(cutoffIso);
  roundManagerState.__baccaratNextCleanupAt = now + CLEANUP_INTERVAL_MS;

  if (result.deletedRounds > 0 || result.deletedBets > 0) {
    console.log(
      `Daily cleanup removed ${result.deletedRounds} settled rounds and ${result.deletedBets} bets before ${cutoffIso}`,
    );
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

export async function startRoundManager() {
  if (roundManagerState.__baccaratRoundManagerInterval) {
    return;
  }

  const runTick = async () => {
    if (roundManagerState.__baccaratRoundManagerTicking) {
      return;
    }

    roundManagerState.__baccaratRoundManagerTicking = true;

    try {
      const now = Date.now();
      const tables = await listTables();

      const results = await Promise.allSettled(tables.map((table) => tickTable(table)));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Table tick failed", result.reason);
        }
      }

      await runDailyCleanup(now);
    } catch (error) {
      console.error("Round manager tick failed", error);
    } finally {
      roundManagerState.__baccaratRoundManagerTicking = false;
    }
  };

  await runTick();
  roundManagerState.__baccaratRoundManagerInterval = setInterval(() => {
    void runTick();
  }, LOOP_INTERVAL_MS);
}
