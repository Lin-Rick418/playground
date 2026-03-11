import { calculatePayout, dealRoundFromShoe, getMassachusettsCutCardConfig } from "./baccarat.js";
import {
  createRound,
  ensureTableShoe,
  getActiveRound,
  getTableShoe,
  listTables,
  listRoundBets,
  purgeSettledRoundsBefore,
  replaceTableShoe,
  saveTableShoe,
  settleRound,
  updateBetPayout,
  updateRoundStatus,
  updateUserBalance,
  findUserById,
} from "./db.js";
import { publishTableUpdate } from "./live-updates.js";
import type { GameTableRecord } from "../types/domain.js";

const REVEAL_WINDOW_MS = 5000;
const LOOP_INTERVAL_MS = 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SETTLED_ROUND_RETENTION_MS = 24 * 60 * 60 * 1000;
// Must cover the slowest full reveal path:
// deal 4 cards -> base reveal -> optional two bonus cards -> final reveal hold.
const DEAL_ANIMATION_BUFFER_MS = 7000;
const MIN_CARDS_TO_COMPLETE_ROUND = 6;

function getTableRoundDurationMs(table: GameTableRecord) {
  return table.roundDurationMs;
}

const roundManagerState = globalThis as typeof globalThis & {
  __baccaratRoundManagerInterval?: NodeJS.Timeout;
  __baccaratNextCleanupAt?: number;
};

function createOpenRound(table: GameTableRecord, startTime = Date.now()) {
  const shoe = ensureTableShoe(table.id);
  const opensAtMs = startTime + DEAL_ANIMATION_BUFFER_MS;
  const opensAt = new Date(opensAtMs).toISOString();
  const closesAt = new Date(opensAtMs + getTableRoundDurationMs(table)).toISOString();
  const round = createRound({
    tableId: table.id,
    shoeId: shoe.shoeId,
    status: "OPEN",
    bettingOpensAt: opensAt,
    bettingClosesAt: closesAt,
  });
  publishTableUpdate(table.id, "round_opened");
  return round;
}

function settleActiveRound(roundId: string, tableId: string) {
  let shoe = getTableShoe(tableId);

  if (!shoe || !shoe.shoeId || shoe.cards.length < MIN_CARDS_TO_COMPLETE_ROUND) {
    shoe = replaceTableShoe(tableId);
  }

  const wasLastHand = shoe.lastHandPending;
  const result = dealRoundFromShoe(shoe);

  const applySettlement = () => {
    const bets = listRoundBets(roundId);

    for (const bet of bets) {
      const payout = calculatePayout(bet.betType, bet.amount, result);
      updateBetPayout(bet.id, payout);

      if (payout > 0) {
        const user = findUserById(bet.userId);

        if (user) {
          updateUserBalance(user.id, user.balance + payout);
        }
      }
    }

    settleRound(roundId, result);
  };

  applySettlement();

  if (wasLastHand) {
    replaceTableShoe(tableId);
    return;
  }

  if (result.cutCardAppeared) {
    shoe.lastHandPending = true;
  }

  saveTableShoe(tableId, shoe.shoeId, shoe);
}

function tickTable(table: GameTableRecord) {
  let round = getActiveRound(table.id);
  const now = Date.now();

  if (!round) {
    createOpenRound(table, now);
    return;
  }

  const closesAt = new Date(round.bettingClosesAt).getTime();

  if (round.status === "OPEN" && now >= closesAt) {
    round = updateRoundStatus(round.id, "LOCKED") ?? round;
    publishTableUpdate(table.id, "round_locked");
  }

  if (round.status === "LOCKED" && now >= closesAt + REVEAL_WINDOW_MS) {
    settleActiveRound(round.id, table.id);
    createOpenRound(table, now);
  }
}

function runDailyCleanup(now: number) {
  if (!roundManagerState.__baccaratNextCleanupAt) {
    roundManagerState.__baccaratNextCleanupAt = now;
  }

  if (now < roundManagerState.__baccaratNextCleanupAt) {
    return;
  }

  const cutoffIso = new Date(now - SETTLED_ROUND_RETENTION_MS).toISOString();
  const result = purgeSettledRoundsBefore(cutoffIso);
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

export function startRoundManager() {
  if (roundManagerState.__baccaratRoundManagerInterval) {
    return;
  }

  const runTick = () => {
    const now = Date.now();
    for (const table of listTables()) {
      tickTable(table);
    }

    runDailyCleanup(now);
  };

  runTick();
  roundManagerState.__baccaratRoundManagerInterval = setInterval(runTick, LOOP_INTERVAL_MS);
}
