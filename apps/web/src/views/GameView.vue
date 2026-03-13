<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import axios from "axios";
import { useRoute, useRouter } from "vue-router";
import RoadmapPanel from "../components/RoadmapPanel.vue";
import { BET_OPTIONS, CHIP_VALUES, DEAL_ANIMATION_TIMINGS, DEFAULT_CHIP_VALUE, WINNER_LABELS } from "../const/game";
import { useLiveChannel } from "../composables/useLiveChannel";
import { useRoadVisibilitySettings } from "../composables/useRoadVisibilitySettings";
import type { TableSnapshotMessage, TableUserSnapshotMessage } from "../lib/live";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import type { BetType, Card } from "../types/domain";

type BetKey = BetType;
type DisplayCard = Card;
type CardRank = DisplayCard["rank"];
type PendingBetAmounts = Record<BetKey, number>;

const authStore = useAuthStore();
const gameStore = useGameStore();
const route = useRoute();
const router = useRouter();
const tableId = computed(() => String(route.params.tableId));
const betOptions = BET_OPTIONS;
const selectedChip = ref<(typeof CHIP_VALUES)[number]>(DEFAULT_CHIP_VALUE);
const isPlacingBet = ref(false);
const isRoadSettingsOpen = ref(false);
const isTableLoading = ref(true);
const betGridRef = ref<HTMLElement | null>(null);

const displayedPlayerCards = ref<DisplayCard[]>([]);
const displayedBankerCards = ref<DisplayCard[]>([]);
const playerDealtCount = ref(0);
const bankerDealtCount = ref(0);
const playerFaceUpCount = ref(0);
const bankerFaceUpCount = ref(0);
const revealTimers: number[] = [];
const dealingPhase = ref<"idle" | "dealing" | "base-revealed" | "bonus-dealing" | "revealed">("idle");
const showDealOverlay = ref(false);
const settlementPopup = ref<null | { amount: number }>(null);
const settlementPopupTimer = ref<number | null>(null);
const pendingSettlementAmount = ref<number | null>(null);
const lastResolvedRoundId = ref("");
const lastAnnouncedRoundId = ref("");
const latestParticipatedRoundId = ref("");
const pendingBetAmounts = ref<PendingBetAmounts>({
  PLAYER: 0,
  BANKER: 0,
  TIE: 0,
  PLAYER_PAIR: 0,
  BANKER_PAIR: 0,
});
const { roadVisibility, roadVisibilityOptions, toggleRoadVisibility } = useRoadVisibilitySettings();
const clockNow = ref(Date.now());
const serverTimeOffsetMs = ref(0);
let clockTimer: number | null = null;
let refreshGameDataPromise: Promise<void> | null = null;
let refreshGameDataQueued = false;
let lastBetGridTouchEndMs = 0;
let messageTimer: number | null = null;

const currentRound = computed(() => gameStore.currentRound);
const presentationRound = computed(() => gameStore.previousRound);
const currentTable = computed(() => gameStore.currentTable);
const syncedServerNowMs = computed(() => clockNow.value + serverTimeOffsetMs.value);
const roadmapRounds = computed(() => {
  const rounds = gameStore.roadRounds;
  const currentPresentationRound = presentationRound.value;
  const presentationEndsAt = gameStore.presentation?.endsAt;

  if (!currentPresentationRound || !presentationEndsAt) {
    return rounds;
  }

  if (syncedServerNowMs.value >= new Date(presentationEndsAt).getTime()) {
    return rounds;
  }

  let skippedLatestPresentationRound = false;
  return rounds.filter((round) => {
    if (!skippedLatestPresentationRound && round.id === currentPresentationRound.id) {
      skippedLatestPresentationRound = true;
      return false;
    }

    return true;
  });
});
const availableChips = computed(() => {
  const minBet = currentTable.value?.minBet ?? CHIP_VALUES[0];
  const maxBet = currentTable.value?.maxBet ?? 5000;
  const chips = CHIP_VALUES.filter((chip) => chip >= minBet && chip <= maxBet);
  return chips.length ? chips : CHIP_VALUES.filter((chip) => chip <= maxBet);
});
const overlayPlayerCards = computed(() =>
  dealingPhase.value === "revealed"
    ? (presentationRound.value?.playerCards ?? [])
    : presentationRound.value?.playerCards.slice(0, playerDealtCount.value) ?? [],
);
const overlayBankerCards = computed(() =>
  dealingPhase.value === "revealed"
    ? (presentationRound.value?.bankerCards ?? [])
    : presentationRound.value?.bankerCards.slice(0, bankerDealtCount.value) ?? [],
);
const faceUpPlayerCards = computed(() => overlayPlayerCards.value.filter((_card, index) => isOverlayCardFaceUp("player", index)));
const faceUpBankerCards = computed(() => overlayBankerCards.value.filter((_card, index) => isOverlayCardFaceUp("banker", index)));
const countdownSeconds = computed(() => {
  if (!currentRound.value) {
    return 0;
  }

  const serverTime = syncedServerNowMs.value;
  const opensAt = new Date(currentRound.value.bettingOpensAt).getTime();
  const closeTime = new Date(currentRound.value.bettingClosesAt).getTime();
  const duration = closeTime - opensAt;
  const countdownMs = serverTime < opensAt ? duration : closeTime - serverTime;

  return Math.ceil(Math.max(0, countdownMs) / 1000);
});
const countdownTone = computed(() => {
  if (countdownSeconds.value <= 0) {
    return "closed";
  }

  if (countdownSeconds.value <= 5) {
    return "warning";
  }

  return "open";
});
const countdownDisplay = computed(() => (countdownSeconds.value > 0 ? String(countdownSeconds.value) : ""));
const countdownStyle = computed(() => {
  if (countdownSeconds.value <= 0) {
    return {
      "--countdown-pulse-duration": "0s",
      "--countdown-ring-duration": "0s",
      "--countdown-ring-delay": "0s",
      "--countdown-ring-second-delay": "0s",
    };
  }

  if (countdownSeconds.value <= 5) {
    const pulseDurationMap: Record<number, string> = {
      5: "0.95s",
      4: "0.82s",
      3: "0.68s",
      2: "0.54s",
      1: "0.42s",
    };
    const ringDurationMap: Record<number, string> = {
      5: "1.1s",
      4: "0.96s",
      3: "0.82s",
      2: "0.68s",
      1: "0.54s",
    };

    return {
      "--countdown-pulse-duration": pulseDurationMap[countdownSeconds.value] ?? "0.95s",
      "--countdown-ring-duration": ringDurationMap[countdownSeconds.value] ?? "1.1s",
      "--countdown-ring-delay": "0s",
      "--countdown-ring-second-delay": "0.24s",
    };
  }

  return {
    "--countdown-pulse-duration": "1.4s",
    "--countdown-ring-duration": "1.8s",
    "--countdown-ring-delay": "0s",
    "--countdown-ring-second-delay": "0.9s",
  };
});
const isBettingOpen = computed(() => {
  if (!currentRound.value || currentRound.value.status !== "OPEN") {
    return false;
  }

  const serverTime = syncedServerNowMs.value;
  const opensAt = new Date(currentRound.value.bettingOpensAt).getTime();
  const closesAt = new Date(currentRound.value.bettingClosesAt).getTime();
  return serverTime >= opensAt && serverTime < closesAt;
});
const isLastHandRound = computed(() => Boolean(gameStore.shoeStatus?.isLastHand));
const winningLabel = computed(() => {
  if (!presentationRound.value) {
    return "";
  }

  return WINNER_LABELS[presentationRound.value.winner];
});
const dealStatusLabel = computed(() => {
  if (dealingPhase.value === "revealed") {
    return winningLabel.value;
  }

  if (dealingPhase.value === "bonus-dealing") {
    return "補牌中";
  }

  if (dealingPhase.value === "base-revealed") {
    return "開牌中";
  }

  return "發牌中";
});

async function refreshGameData() {
  if (refreshGameDataPromise) {
    refreshGameDataQueued = true;
    return refreshGameDataPromise;
  }

  refreshGameDataPromise = (async () => {
    const previousRoundId = currentRound.value?.id ?? "";
    const state = await gameStore.fetchState(tableId.value);
    serverTimeOffsetMs.value = new Date(state.serverTime).getTime() - Date.now();
    authStore.patchBalance(state.balance);
    if (state.myBets?.length) {
      latestParticipatedRoundId.value = state.round.id;
    }
    if (!availableChips.value.includes(selectedChip.value)) {
      selectedChip.value = availableChips.value[0] ?? CHIP_VALUES[0];
    }

    const settledRound = state.previousRound;
    if (
      previousRoundId &&
      previousRoundId !== state.round.id &&
      settledRound &&
      settledRound.id === previousRoundId &&
      settledRound.id === latestParticipatedRoundId.value &&
      lastResolvedRoundId.value !== settledRound.id
    ) {
      lastResolvedRoundId.value = settledRound.id;
      await gameStore.fetchHistory();
      const settledHistory = gameStore.history.find((item) => item.round.id === settledRound.id);
      queueSettlementPopup(settledHistory ? settledHistory.totalPayout - settledHistory.totalAmount : 0, state.serverTime);
    }

    syncPresentationWindow(state.serverTime);
  })();

  try {
    await refreshGameDataPromise;
  } finally {
    refreshGameDataPromise = null;
    if (refreshGameDataQueued) {
      refreshGameDataQueued = false;
      void refreshGameData();
    }
  }
}

async function loadTableState() {
  isTableLoading.value = true;

  try {
    await refreshGameData();
  } catch (error) {
    const message = axios.isAxiosError(error) ? (error.response?.data?.message ?? "載入桌況失敗") : "載入桌況失敗";
    gameStore.message = message;
  } finally {
    isTableLoading.value = false;
  }
}

function currentBetAmount(target: BetKey) {
  const actualAmount = gameStore.currentBets
    .filter((bet) => bet.betType === target)
    .reduce((sum, bet) => sum + bet.amount, 0);
  return actualAmount + pendingBetAmounts.value[target];
}

function formatBetDisplayAmount(amount: number) {
  if (amount < 1000) {
    return amount.toLocaleString();
  }

  const compactAmount = amount / 1000;
  return `${Number.isInteger(compactAmount) ? compactAmount : compactAmount.toFixed(1).replace(/\.0$/, "")}k`;
}

async function addBet(target: BetKey) {
  if (!isBettingOpen.value || isPlacingBet.value) {
    return;
  }

  const minBet = currentTable.value?.minBet ?? CHIP_VALUES[0];
  const maxBet = currentTable.value?.maxBet ?? 10000;
  if (selectedChip.value < minBet) {
    gameStore.message = `最低下注 ${minBet.toLocaleString()}`;
    return;
  }

  if (currentBetAmount(target) + selectedChip.value > maxBet) {
    gameStore.message = `單一玩法最高下注 ${maxBet.toLocaleString()}`;
    return;
  }

  if ((authStore.user?.balance ?? 0) < selectedChip.value) {
    gameStore.message = "餘額不足";
    return;
  }

  isPlacingBet.value = true;
  pendingBetAmounts.value[target] += selectedChip.value;

  try {
    const result = await gameStore.placeBet(tableId.value, [{ betType: target, amount: selectedChip.value }]);
    latestParticipatedRoundId.value = result.round.id;
    authStore.patchBalance(result.balance);
  } catch (error) {
    pendingBetAmounts.value[target] = Math.max(0, pendingBetAmounts.value[target] - selectedChip.value);
    const message = axios.isAxiosError(error) ? (error.response?.data?.message ?? "下注失敗") : "下注失敗";
    gameStore.message = message;
    if (message === "Betting is closed") {
      void refreshGameData();
    }
  } finally {
    if (pendingBetAmounts.value[target] >= selectedChip.value) {
      pendingBetAmounts.value[target] -= selectedChip.value;
    }
    isPlacingBet.value = false;
  }
}

function stopRevealTimers() {
  revealTimers.forEach((id) => window.clearTimeout(id));
  revealTimers.length = 0;
}

function stopSettlementPopupTimer() {
  if (settlementPopupTimer.value) {
    window.clearTimeout(settlementPopupTimer.value);
    settlementPopupTimer.value = null;
  }
}

function stopMessageTimer() {
  if (messageTimer) {
    window.clearTimeout(messageTimer);
    messageTimer = null;
  }
}

function showSettlementPopup(amount: number) {
  stopSettlementPopupTimer();
  settlementPopup.value = { amount };
  settlementPopupTimer.value = window.setTimeout(() => {
    settlementPopup.value = null;
  }, 2200);
}

function cardSuitSymbol(suit: string) {
  return suit === "S" ? "♠" : suit === "H" ? "♥" : suit === "D" ? "♦" : "♣";
}

function cardColor(suit: string) {
  return suit === "H" || suit === "D" ? "red" : "black";
}

function visibleHandTotal(cards: DisplayCard[]) {
  const values: Record<CardRank, number> = {
    A: 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 0,
    J: 0,
    Q: 0,
    K: 0,
  };

  return cards.reduce((sum, card) => sum + (values[card.rank] ?? 0), 0) % 10;
}

function speakRoundTotals(round: NonNullable<typeof presentationRound.value>) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  const synth = window.speechSynthesis;
  synth.cancel();

  const winnerText =
    round.winner === "PLAYER" ? "閒贏" : round.winner === "BANKER" ? "莊贏" : "和局";
  const lines = [`閒${round.playerTotal}點`, `莊${round.bankerTotal}點`, winnerText];

  lines.forEach((text) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-TW";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.volume = 1;

    synth.speak(utterance);
  });
}

function isOverlayCardFaceUp(side: "player" | "banker", index: number) {
  return side === "player" ? index < playerFaceUpCount.value : index < bankerFaceUpCount.value;
}

function showPendingSettlementIfNeeded() {
  if (pendingSettlementAmount.value !== null) {
    showSettlementPopup(pendingSettlementAmount.value);
    pendingSettlementAmount.value = null;
  }
}

function queueSettlementPopup(amount: number, serverTimeIso?: string) {
  pendingSettlementAmount.value = amount;

  if (!gameStore.presentation?.endsAt) {
    showPendingSettlementIfNeeded();
    return;
  }

  const serverNowMs = serverTimeIso ? new Date(serverTimeIso).getTime() : syncedServerNowMs.value;
  const presentationEndsAtMs = new Date(gameStore.presentation.endsAt).getTime();

  if (!showDealOverlay.value || serverNowMs >= presentationEndsAtMs) {
    showPendingSettlementIfNeeded();
  }
}

function scheduleRevealTimer(delayMs: number, callback: () => void) {
  if (delayMs <= 0) {
    return;
  }

  revealTimers.push(window.setTimeout(callback, delayMs));
}

function getBonusCards(round: { playerCards: DisplayCard[]; bankerCards: DisplayCard[] }) {
  return [
    { side: "player" as const, card: round.playerCards[2] },
    { side: "banker" as const, card: round.bankerCards[2] },
  ].filter((item): item is { side: "player" | "banker"; card: DisplayCard } => Boolean(item.card));
}

function syncPresentationState(elapsedMs: number) {
  if (!presentationRound.value) {
    return;
  }

  const baseCards = [
    { side: "player", card: presentationRound.value.playerCards[0] },
    { side: "banker", card: presentationRound.value.bankerCards[0] },
    { side: "player", card: presentationRound.value.playerCards[1] },
    { side: "banker", card: presentationRound.value.bankerCards[1] },
  ].filter((item): item is { side: "player" | "banker"; card: DisplayCard } => Boolean(item.card));
  const bonusCards = getBonusCards(presentationRound.value);

  const shownBaseCards = baseCards.filter(
    (_item, index) => elapsedMs >= index * DEAL_ANIMATION_TIMINGS.baseCardIntervalMs,
  );
  displayedPlayerCards.value = shownBaseCards.filter((item) => item.side === "player").map((item) => item.card);
  displayedBankerCards.value = shownBaseCards.filter((item) => item.side === "banker").map((item) => item.card);
  playerDealtCount.value = displayedPlayerCards.value.length;
  bankerDealtCount.value = displayedBankerCards.value.length;
  playerFaceUpCount.value = 0;
  bankerFaceUpCount.value = 0;
  dealingPhase.value = "dealing";

  if (elapsedMs >= DEAL_ANIMATION_TIMINGS.baseRevealDelayMs) {
    dealingPhase.value = "base-revealed";
    playerDealtCount.value = Math.max(playerDealtCount.value, Math.min(2, presentationRound.value.playerCards.length));
    bankerDealtCount.value = Math.max(bankerDealtCount.value, Math.min(2, presentationRound.value.bankerCards.length));
    playerFaceUpCount.value = Math.min(2, displayedPlayerCards.value.length);
    bankerFaceUpCount.value = Math.min(2, displayedBankerCards.value.length);
  }

  if (!bonusCards.length) {
    if (
      elapsedMs >=
      DEAL_ANIMATION_TIMINGS.baseRevealDelayMs + DEAL_ANIMATION_TIMINGS.noBonusRevealDelayMs
    ) {
      dealingPhase.value = "revealed";
      displayedPlayerCards.value = [...presentationRound.value.playerCards];
      displayedBankerCards.value = [...presentationRound.value.bankerCards];
      playerDealtCount.value = displayedPlayerCards.value.length;
      bankerDealtCount.value = displayedBankerCards.value.length;
      playerFaceUpCount.value = displayedPlayerCards.value.length;
      bankerFaceUpCount.value = displayedBankerCards.value.length;
    }
    return;
  }

  const bonusStartMs =
    DEAL_ANIMATION_TIMINGS.baseRevealDelayMs + DEAL_ANIMATION_TIMINGS.bonusPhaseDelayMs;
  if (elapsedMs >= bonusStartMs) {
    dealingPhase.value = "bonus-dealing";
    const dealtBonusCards = bonusCards.filter(
      (_item, index) => elapsedMs >= bonusStartMs + index * DEAL_ANIMATION_TIMINGS.bonusCardIntervalMs,
    );
    const revealedBonusCards = bonusCards.filter(
      (_item, index) =>
        elapsedMs >=
        bonusStartMs +
          index * DEAL_ANIMATION_TIMINGS.bonusCardIntervalMs +
          DEAL_ANIMATION_TIMINGS.bonusRevealDelayMs,
    );
    displayedPlayerCards.value = [
      ...presentationRound.value.playerCards.slice(0, 2),
      ...dealtBonusCards.filter((item) => item.side === "player").map((item) => item.card),
    ];
    displayedBankerCards.value = [
      ...presentationRound.value.bankerCards.slice(0, 2),
      ...dealtBonusCards.filter((item) => item.side === "banker").map((item) => item.card),
    ];
    playerDealtCount.value = displayedPlayerCards.value.length;
    bankerDealtCount.value = displayedBankerCards.value.length;
    playerFaceUpCount.value = 2 + revealedBonusCards.filter((item) => item.side === "player").length;
    bankerFaceUpCount.value = 2 + revealedBonusCards.filter((item) => item.side === "banker").length;
  }

  const lastBonusRevealAtMs =
    bonusStartMs +
    (bonusCards.length - 1) * DEAL_ANIMATION_TIMINGS.bonusCardIntervalMs +
    DEAL_ANIMATION_TIMINGS.bonusRevealDelayMs;
  if (
    elapsedMs >=
    lastBonusRevealAtMs + DEAL_ANIMATION_TIMINGS.finalRevealDelayMs
  ) {
    dealingPhase.value = "revealed";
    displayedPlayerCards.value = [...presentationRound.value.playerCards];
    displayedBankerCards.value = [...presentationRound.value.bankerCards];
    playerDealtCount.value = displayedPlayerCards.value.length;
    bankerDealtCount.value = displayedBankerCards.value.length;
    playerFaceUpCount.value = displayedPlayerCards.value.length;
    bankerFaceUpCount.value = displayedBankerCards.value.length;
  }
}

function syncPresentationWindow(serverTimeIso: string) {
  if (!presentationRound.value || !gameStore.presentation?.startsAt || !gameStore.presentation?.endsAt) {
    stopRevealTimers();
    displayedPlayerCards.value = [];
    displayedBankerCards.value = [];
    playerDealtCount.value = 0;
    bankerDealtCount.value = 0;
    playerFaceUpCount.value = 0;
    bankerFaceUpCount.value = 0;
    showDealOverlay.value = false;
    dealingPhase.value = "idle";
    return;
  }

  const serverNowMs = new Date(serverTimeIso).getTime();
  const presentationStartsAtMs = new Date(gameStore.presentation.startsAt).getTime();
  const presentationEndsAtMs = new Date(gameStore.presentation.endsAt).getTime();

  if (serverNowMs >= presentationEndsAtMs) {
    stopRevealTimers();
    showDealOverlay.value = false;
    dealingPhase.value = "idle";
    playerDealtCount.value = 0;
    bankerDealtCount.value = 0;
    playerFaceUpCount.value = 0;
    bankerFaceUpCount.value = 0;
    showPendingSettlementIfNeeded();
    return;
  }

  if (serverNowMs < presentationStartsAtMs) {
    return;
  }

  stopRevealTimers();
  showDealOverlay.value = true;
  syncPresentationState(serverNowMs - presentationStartsAtMs);

  const round = presentationRound.value;
  const baseCards = [
    { side: "player", card: round.playerCards[0] },
    { side: "banker", card: round.bankerCards[0] },
    { side: "player", card: round.playerCards[1] },
    { side: "banker", card: round.bankerCards[1] },
  ].filter((item): item is { side: "player" | "banker"; card: DisplayCard } => Boolean(item.card));
  const bonusCards = getBonusCards(round);

  const elapsedMs = serverNowMs - presentationStartsAtMs;

  baseCards.forEach((item, index) => {
    scheduleRevealTimer(index * DEAL_ANIMATION_TIMINGS.baseCardIntervalMs - elapsedMs, () => {
      if (item.side === "player") {
        displayedPlayerCards.value = [...displayedPlayerCards.value, item.card];
        playerDealtCount.value = displayedPlayerCards.value.length;
      } else {
        displayedBankerCards.value = [...displayedBankerCards.value, item.card];
        bankerDealtCount.value = displayedBankerCards.value.length;
      }
    });
  });

  scheduleRevealTimer(DEAL_ANIMATION_TIMINGS.baseRevealDelayMs - elapsedMs, () => {
    dealingPhase.value = "base-revealed";
    playerDealtCount.value = Math.max(playerDealtCount.value, Math.min(2, round.playerCards.length));
    bankerDealtCount.value = Math.max(bankerDealtCount.value, Math.min(2, round.bankerCards.length));
    playerFaceUpCount.value = Math.min(2, displayedPlayerCards.value.length);
    bankerFaceUpCount.value = Math.min(2, displayedBankerCards.value.length);
  });

  if (!bonusCards.length) {
    scheduleRevealTimer(
      DEAL_ANIMATION_TIMINGS.baseRevealDelayMs + DEAL_ANIMATION_TIMINGS.noBonusRevealDelayMs - elapsedMs,
      () => {
        dealingPhase.value = "revealed";
        displayedPlayerCards.value = [...round.playerCards];
        displayedBankerCards.value = [...round.bankerCards];
        playerDealtCount.value = displayedPlayerCards.value.length;
        bankerDealtCount.value = displayedBankerCards.value.length;
        playerFaceUpCount.value = displayedPlayerCards.value.length;
        bankerFaceUpCount.value = displayedBankerCards.value.length;
      },
    );
  } else {
    const bonusStartMs =
      DEAL_ANIMATION_TIMINGS.baseRevealDelayMs + DEAL_ANIMATION_TIMINGS.bonusPhaseDelayMs;
    scheduleRevealTimer(bonusStartMs - elapsedMs, () => {
      dealingPhase.value = "bonus-dealing";
    });

    bonusCards.forEach((item, index) => {
      const dealAtMs = bonusStartMs + index * DEAL_ANIMATION_TIMINGS.bonusCardIntervalMs;
      const revealAtMs = dealAtMs + DEAL_ANIMATION_TIMINGS.bonusRevealDelayMs;

      scheduleRevealTimer(
        dealAtMs - elapsedMs,
        () => {
          if (item.side === "player") {
            displayedPlayerCards.value = [...round.playerCards.slice(0, 2), item.card];
            playerDealtCount.value = displayedPlayerCards.value.length;
          } else {
            displayedBankerCards.value = [...round.bankerCards.slice(0, 2), item.card];
            bankerDealtCount.value = displayedBankerCards.value.length;
          }
        },
      );

      scheduleRevealTimer(revealAtMs - elapsedMs, () => {
        if (item.side === "player") {
          playerFaceUpCount.value = 3;
        } else {
          bankerFaceUpCount.value = 3;
        }
      });
    });

    const lastBonusRevealAtMs =
      bonusStartMs +
      (bonusCards.length - 1) * DEAL_ANIMATION_TIMINGS.bonusCardIntervalMs +
      DEAL_ANIMATION_TIMINGS.bonusRevealDelayMs;
    scheduleRevealTimer(
      lastBonusRevealAtMs + DEAL_ANIMATION_TIMINGS.finalRevealDelayMs - elapsedMs,
      () => {
        dealingPhase.value = "revealed";
        displayedPlayerCards.value = [...round.playerCards];
        displayedBankerCards.value = [...round.bankerCards];
        playerDealtCount.value = displayedPlayerCards.value.length;
        bankerDealtCount.value = displayedBankerCards.value.length;
        playerFaceUpCount.value = displayedPlayerCards.value.length;
        bankerFaceUpCount.value = displayedBankerCards.value.length;
      },
    );
  }

  scheduleRevealTimer(presentationEndsAtMs - serverNowMs, () => {
    showDealOverlay.value = false;
    dealingPhase.value = "idle";
    playerDealtCount.value = 0;
    bankerDealtCount.value = 0;
    playerFaceUpCount.value = 0;
    bankerFaceUpCount.value = 0;
    showPendingSettlementIfNeeded();
  });
}

function backToLobby() {
  router.push("/lobby");
}

function openRoadSettings() {
  isRoadSettingsOpen.value = true;
}

function closeRoadSettings() {
  isRoadSettingsOpen.value = false;
}

function preventBetGridDoubleTapZoom(event: TouchEvent) {
  const now = event.timeStamp || Date.now();
  if (now - lastBetGridTouchEndMs < 320) {
    event.preventDefault();
  }

  lastBetGridTouchEndMs = now;
}

async function applyTableSnapshotMessage(message: TableSnapshotMessage) {
  const previousRoundId = currentRound.value?.id ?? "";

  gameStore.applyTableSnapshot(message.data);
  serverTimeOffsetMs.value = new Date(message.data.serverTime).getTime() - Date.now();
  syncPresentationWindow(message.data.serverTime);
  isTableLoading.value = false;

  const settledRound = message.data.previousRound;
  if (
    previousRoundId &&
    previousRoundId !== (message.data.round?.id ?? "") &&
    settledRound &&
    settledRound.id === previousRoundId &&
    settledRound.id === latestParticipatedRoundId.value &&
    lastResolvedRoundId.value !== settledRound.id
  ) {
    lastResolvedRoundId.value = settledRound.id;
    await gameStore.fetchHistory();
    const settledHistory = gameStore.history.find((item) => item.round.id === settledRound.id);
    queueSettlementPopup(
      settledHistory ? settledHistory.totalPayout - settledHistory.totalAmount : 0,
      message.data.serverTime,
    );
  }
}

function applyTableUserSnapshotMessage(message: TableUserSnapshotMessage) {
  if (message.data.tableId !== tableId.value) {
    return;
  }

  if (message.data.myBets.length > 0) {
    latestParticipatedRoundId.value = message.data.currentRoundId;
  }

  gameStore.applyTableUserSnapshot({
    currentRoundId: message.data.currentRoundId,
    myBets: message.data.myBets,
  });
  authStore.patchBalance(message.data.balance);

  if (!message.data.isActive) {
    authStore.logout();
    router.push("/login");
  }
}

const liveChannel = useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_table", tableId: tableId.value }),
  onMessage: (message) => {
    if (message.type === "table_snapshot") {
      void applyTableSnapshotMessage(message);
      return;
    }

    if (message.type === "table_user_snapshot") {
      applyTableUserSnapshotMessage(message);
    }
  },
  onError: (message) => {
    gameStore.message = message;
  },
});

onMounted(async () => {
  clockTimer = window.setInterval(() => {
    clockNow.value = Date.now();
  }, 250);
  betGridRef.value?.addEventListener("touchend", preventBetGridDoubleTapZoom, { passive: false });
  await loadTableState();
});

onUnmounted(() => {
  stopRevealTimers();
  stopSettlementPopupTimer();
  stopMessageTimer();
  pendingSettlementAmount.value = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  if (clockTimer) {
    window.clearInterval(clockTimer);
  }
  betGridRef.value?.removeEventListener("touchend", preventBetGridDoubleTapZoom);
});

watch(tableId, async () => {
  gameStore.currentBets = [];
  isTableLoading.value = true;
  liveChannel.reconnect();
  await loadTableState();
});

watch(
  () => gameStore.message,
  (message) => {
    stopMessageTimer();

    if (!message) {
      return;
    }

    messageTimer = window.setTimeout(() => {
      if (gameStore.message === message) {
        gameStore.message = "";
      }
    }, 2200);
  },
);

watch(
  [() => showDealOverlay.value, () => dealingPhase.value, () => presentationRound.value?.id ?? ""],
  ([overlayVisible, phase, roundId]) => {
    if (!overlayVisible || phase !== "revealed" || !presentationRound.value || !roundId) {
      return;
    }

    if (lastAnnouncedRoundId.value === roundId) {
      return;
    }

    lastAnnouncedRoundId.value = roundId;
    speakRoundTotals(presentationRound.value);
  },
);
</script>

<template>
  <main class="page-shell game-page">
    <transition name="table-loading-fade">
      <div v-if="isTableLoading" class="table-loading-overlay">
        <div class="table-loading-panel panel">
          <div class="table-loading-spinner" aria-hidden="true" />
          <p class="topbar-label">Loading Table</p>
          <strong>進入牌桌中</strong>
          <span>正在同步最新桌況與路圖</span>
        </div>
      </div>
    </transition>

    <button class="corner-button back-button" @click="backToLobby" aria-label="返回大廳">
      ←
    </button>
    <button class="corner-button settings-button" @click="openRoadSettings" aria-label="路圖設定">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M21.67 18.17 13.9 10.4a6 6 0 0 1-7.67-7.67l3.2 3.2 2.34-.67.67-2.34-3.2-3.2A6 6 0 0 1 16.9 7.4l7.77 7.77a1.8 1.8 0 0 1 0 2.54l-1.46 1.46a1.8 1.8 0 0 1-2.54 0Zm-4.7-5.46 3.72 3.72.9-.9-3.72-3.72-.9.9Zm-11.3 7.96a2.7 2.7 0 1 1 3.82-3.82 2.7 2.7 0 0 1-3.82 3.82Z"
        />
      </svg>
    </button>
    <div class="floating-balance" aria-label="玩家餘額">
      <span class="coin-symbol">$</span>
      <strong>{{ authStore.user?.balance?.toLocaleString() ?? "--" }}</strong>
    </div>
    <transition name="last-hand-fade">
      <div v-if="isLastHandRound" class="last-hand-banner">
        <strong>最後一局</strong>
        <span>此局結束後換靴</span>
      </div>
    </transition>

    <transition name="settlement-pop">
      <div v-if="settlementPopup" class="settlement-popup" :class="settlementPopup.amount >= 0 ? 'positive' : 'negative'">
        <strong>您贏了</strong>
        <span>{{ settlementPopup.amount >= 0 ? "+" : "" }}{{ settlementPopup.amount.toLocaleString() }}</span>
      </div>
    </transition>

    <transition name="game-message-pop">
      <div v-if="gameStore.message" class="game-message-toast">
        {{ gameStore.message }}
      </div>
    </transition>

    <div v-if="showDealOverlay && presentationRound" class="deal-overlay">
      <div class="deal-overlay-panel panel">
        <div class="deal-head">
          <div>
            <p class="topbar-label">Latest Result</p>
            <h2>{{ dealingPhase === "revealed" ? winningLabel : dealStatusLabel }}</h2>
          </div>
          <span
            class="status-chip"
            :class="dealingPhase === 'revealed' ? (presentationRound.winner === 'PLAYER' ? 'win' : presentationRound.winner === 'BANKER' ? 'lose' : 'tie') : 'neutral'"
          >
            {{ dealStatusLabel }}
          </span>
        </div>

        <div class="deal-table">
          <div class="hand-lane player-lane">
            <div class="lane-head">
              <h3>閒</h3>
              <strong>{{ faceUpPlayerCards.length ? visibleHandTotal(faceUpPlayerCards) : "--" }}</strong>
            </div>
            <div class="card-line">
              <div
                v-for="(card, index) in overlayPlayerCards"
                :key="`overlay-player-${index}-${card.rank}-${card.suit}`"
                class="playing-card"
                :class="isOverlayCardFaceUp('player', index) ? cardColor(card.suit) : 'masked'"
              >
                <template v-if="isOverlayCardFaceUp('player', index)">
                  <span>{{ card.rank }}</span>
                  <small>{{ cardSuitSymbol(card.suit) }}</small>
                </template>
              </div>
            </div>
          </div>

          <div class="hand-lane banker-lane">
            <div class="lane-head">
              <h3>莊</h3>
              <strong>{{ faceUpBankerCards.length ? visibleHandTotal(faceUpBankerCards) : "--" }}</strong>
            </div>
            <div class="card-line">
              <div
                v-for="(card, index) in overlayBankerCards"
                :key="`overlay-banker-${index}-${card.rank}-${card.suit}`"
                class="playing-card"
                :class="isOverlayCardFaceUp('banker', index) ? cardColor(card.suit) : 'masked'"
              >
                <template v-if="isOverlayCardFaceUp('banker', index)">
                  <span>{{ card.rank }}</span>
                  <small>{{ cardSuitSymbol(card.suit) }}</small>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p class="table-limit-banner">
      {{ currentTable?.code }} / {{ Math.round((currentTable?.roundDurationMs ?? 30000) / 1000) }} 秒 / 最低
      {{ currentTable?.minBet?.toLocaleString() ?? "--" }} / 單種最高 {{ currentTable?.maxBet?.toLocaleString() ?? "--" }}
    </p>

    <section class="panel table-panel">
      <div class="table-panel-head-row">
        <div
          class="countdown-chip table-panel-countdown"
          :class="countdownTone"
          :style="countdownStyle"
          :aria-label="countdownDisplay ? `封盤倒數 ${countdownDisplay} 秒` : '封盤中'"
        >
          <span v-if="countdownDisplay">{{ countdownDisplay }}</span>
        </div>
      </div>

      <div ref="betGridRef" class="bet-grid">
        <article
          v-for="option in betOptions"
          :key="option.key"
          class="bet-card"
          :class="[option.accent, option.gridClass]"
          @pointerdown.prevent="addBet(option.key)"
        >
          <div class="bet-card-top">
            <div>
              <h3>{{ option.label }}</h3>
            </div>
            <span class="bet-amount">{{ formatBetDisplayAmount(currentBetAmount(option.key)) }}</span>
          </div>
          <p class="bet-payout">{{ option.payout }}</p>
        </article>
      </div>

      <section class="chip-rack">
        <button
          v-for="chip in availableChips"
          :key="chip"
          class="chip"
          :class="{ active: selectedChip === chip }"
          :disabled="!isBettingOpen"
          @click="selectedChip = chip"
        >
          {{ chip }}
        </button>
      </section>
    </section>

    <section class="panel road-panel">
      <RoadmapPanel :rounds="roadmapRounds" :visibility="roadVisibility" :clear-preview-signal="showDealOverlay ? presentationRound?.id ?? 'active' : null" />
    </section>

    <div v-if="isRoadSettingsOpen" class="modal-backdrop">
      <section class="settings-modal panel" role="dialog" aria-modal="true" aria-labelledby="road-settings-title">
        <button class="settings-close-button" type="button" @click="closeRoadSettings" aria-label="關閉路圖設定">
          ✕
        </button>

        <div class="settings-modal-head">
          <p class="topbar-label">Roadmap Settings</p>
          <h2 id="road-settings-title">路圖設定</h2>
        </div>

        <div class="settings-list">
          <button
            v-for="option in roadVisibilityOptions"
            :key="option.key"
            type="button"
            class="settings-item"
            :class="{ active: roadVisibility[option.key] }"
            @click="toggleRoadVisibility(option.key)"
          >
            <span>{{ option.label }}</span>
            <strong>{{ roadVisibility[option.key] ? "顯示中" : "已隱藏" }}</strong>
          </button>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.game-page {
  --top-ui-clearance: 98px;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  align-content: start;
  gap: 16px;
  overflow-x: clip;
  height: 100vh;
  max-height: 100vh;
  padding-top: var(--top-ui-clearance);
}

.corner-button {
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 999px;
  background: rgba(8, 18, 14, 0.88);
  color: #f7f4e9;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.back-button {
  position: fixed;
  top: 22px;
  left: 22px;
  z-index: 20;
  font-size: 26px;
  line-height: 1;
}

.settings-button {
  position: fixed;
  top: 22px;
  left: 78px;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.settings-button svg {
  width: 24px;
  height: 24px;
  fill: #f4de9b;
}

.table-panel,
.road-panel {
  padding: 10px;
}

.deal-overlay {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 100%;
  max-width: 430px;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background:
    linear-gradient(180deg, rgba(2, 8, 6, 0.78), rgba(2, 8, 6, 0.46) 45%, rgba(2, 8, 6, 0.78));
  backdrop-filter: blur(6px);
  overflow-x: hidden;
}

.table-loading-overlay {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 100%;
  max-width: 430px;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    linear-gradient(180deg, rgba(2, 8, 6, 0.88), rgba(2, 8, 6, 0.74) 48%, rgba(2, 8, 6, 0.88));
  backdrop-filter: blur(8px);
}

.table-loading-panel {
  width: 100%;
  max-width: 280px;
  padding: 26px 20px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.table-loading-spinner {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 3px solid rgba(244, 222, 155, 0.2);
  border-top-color: #f4de9b;
  border-right-color: rgba(244, 222, 155, 0.64);
  animation: table-loading-spin 0.82s linear infinite;
  box-shadow: 0 0 18px rgba(244, 222, 155, 0.12);
}

.table-loading-panel strong {
  color: #f7f4e9;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.table-loading-panel span {
  color: rgba(247, 244, 233, 0.68);
  font-size: 13px;
  line-height: 1.5;
}

.table-loading-fade-enter-active,
.table-loading-fade-leave-active {
  transition: opacity 220ms ease;
}

.table-loading-fade-enter-from,
.table-loading-fade-leave-to {
  opacity: 0;
}

@keyframes table-loading-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.deal-overlay-panel {
  width: 100%;
  max-width: 100%;
  padding: 22px 18px;
  overflow: hidden;
}

.floating-balance {
  position: fixed;
  top: 22px;
  right: 22px;
  z-index: 20;
  min-width: 126px;
  height: 44px;
  padding: 0 18px 0 10px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  justify-content: space-around;
  background: rgba(8, 18, 14, 0.88);
  border: 1px solid rgba(244, 222, 155, 0.2);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
}

.coin-symbol {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 30% 30%, #fff2ba, #f4de9b 48%, #be9240 100%);
  color: #6d4b0f;
  font-size: 16px;
  font-weight: 900;
  box-shadow: inset 0 0 0 1px rgba(109, 75, 15, 0.18);
}

.floating-balance strong {
  color: #f4de9b;
  font-size: 17px;
  font-weight: 900;
  line-height: 1;
}

.last-hand-banner {
  position: fixed;
  top: 84px;
  left: 50%;
  z-index: 20;
  transform: translateX(-50%);
  min-width: 180px;
  padding: 10px 16px;
  border-radius: 18px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  background:
    linear-gradient(180deg, rgba(117, 18, 18, 0.96), rgba(77, 8, 8, 0.92)),
    linear-gradient(135deg, rgba(255, 215, 140, 0.22), transparent 60%);
  border: 1px solid rgba(255, 210, 124, 0.45);
  box-shadow:
    0 10px 24px rgba(0, 0, 0, 0.28),
    0 0 0 1px rgba(255, 180, 92, 0.08) inset;
  pointer-events: none;
}

.last-hand-banner strong {
  color: #ffe5a8;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 0.08em;
}

.last-hand-banner span {
  color: rgba(255, 241, 214, 0.92);
  font-size: 11px;
}

.last-hand-fade-enter-active,
.last-hand-fade-leave-active {
  transition:
    opacity 220ms ease,
    transform 220ms ease;
}

.last-hand-fade-enter-from,
.last-hand-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}

.topbar-label {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(247, 244, 233, 0.6);
}

.status-chip.neutral {
  background: rgba(255, 255, 255, 0.12);
  color: #f7f4e9;
}

.deal-head,
.table-head,
.current-bets,
.lane-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.deal-head h2,
.table-head h2 {
  margin: 4px 0 0;
}

.table-limit-banner {
  margin: 0;
  padding: 0 16px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  line-height: 1.08;
  font-family: "Cormorant Garamond", "Times New Roman", serif;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.03em;
  color: #f7e9b7;
  text-shadow:
    0 0 18px rgba(244, 222, 155, 0.18),
    0 10px 24px rgba(0, 0, 0, 0.22);
  background: linear-gradient(180deg, #fff7da 0%, #f4de9b 38%, #d7a74c 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.table-panel,
.road-panel {
  min-height: 0;
}

.table-panel {
  overflow: visible;
}

.road-panel {
  overflow: hidden;
}

.table-panel-head-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-bottom: 10px;
}

.deal-table {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  margin-top: 18px;
  width: 100%;
}

.hand-lane {
  padding: 18px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.04);
}

.card-line {
  display: flex;
  gap: clamp(8px, 2.5vw, 10px);
  margin-top: 14px;
  min-height: clamp(82px, 28vw, 112px);
  justify-content: center;
  width: 100%;
  overflow: hidden;
}

.playing-card {
  width: clamp(52px, 16vw, 72px);
  height: clamp(74px, 23vw, 102px);
  border-radius: 14px;
  background: linear-gradient(180deg, #fffdf7, #efe7d4);
  color: #111;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.22);
  animation: deal-in 240ms ease-out;
}

.playing-card.masked {
  background:
    repeating-linear-gradient(45deg, rgba(234, 231, 222, 0.18), rgba(234, 231, 222, 0.18) 8px, rgba(122, 25, 34, 0.82) 8px, rgba(122, 25, 34, 0.82) 16px),
    linear-gradient(135deg, #43151b, #912735);
  color: transparent;
}

.playing-card.red {
  color: #c93d3d;
}

.playing-card.black {
  color: #1c1c1c;
}

.playing-card span {
  font-size: clamp(22px, 6vw, 28px);
  font-weight: 800;
}

.playing-card small {
  font-size: clamp(16px, 4.8vw, 20px);
  margin-top: 6px;
}

.countdown-chip {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.5), transparent 34%),
    linear-gradient(180deg, #7cf3a4, #3ec870);
  color: #f7f4e9;
  font-size: 14px;
  font-weight: 900;
  box-shadow:
    inset 0 0 0 3px rgba(255, 255, 255, 0.22),
    0 10px 20px rgba(0, 0, 0, 0.18),
    0 0 24px rgba(83, 219, 132, 0.28);
  animation: countdown-pulse var(--countdown-pulse-duration, 1.4s) ease-in-out infinite;
}

.table-panel-countdown {
  position: relative;
  flex: 0 0 auto;
}

.countdown-chip.warning {
  background:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.46), transparent 34%),
    linear-gradient(180deg, #ffe082, #f2c247);
  color: #c62222;
  box-shadow:
    inset 0 0 0 3px rgba(255, 255, 255, 0.22),
    0 10px 20px rgba(0, 0, 0, 0.18),
    0 0 24px rgba(242, 194, 71, 0.28);
}

.countdown-chip.closed {
  background:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.42), transparent 34%),
    linear-gradient(180deg, #ff7a7a, #d62f2f);
  color: transparent;
  box-shadow:
    inset 0 0 0 3px rgba(255, 255, 255, 0.2),
    0 10px 20px rgba(0, 0, 0, 0.18),
    0 0 24px rgba(214, 47, 47, 0.32);
  animation: none;
}

.countdown-chip::before,
.countdown-chip::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 999px;
  border: 2px solid rgba(124, 243, 164, 0.38);
  animation: countdown-ring var(--countdown-ring-duration, 1.8s) ease-out infinite;
  animation-delay: var(--countdown-ring-delay, 0s);
}

.countdown-chip.warning::before,
.countdown-chip.warning::after {
  border-color: rgba(255, 208, 98, 0.52);
}

.countdown-chip.closed::before,
.countdown-chip.closed::after {
  border-color: rgba(255, 105, 105, 0.56);
  animation: none;
  opacity: 0;
}

.countdown-chip::after {
  animation-delay: var(--countdown-ring-second-delay, 0.9s);
}

@keyframes countdown-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.08);
  }
}

@keyframes countdown-ring {
  0% {
    opacity: 0.7;
    transform: scale(0.92);
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

.bet-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: clamp(12px, 3vw, 16px);
  margin: 10px 0 12px;
}

.bet-card {
  border-radius: 18px;
  min-height: clamp(104px, 29vw, 128px);
  padding: clamp(12px, 3.2vw, 16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: transform 120ms ease, filter 120ms ease;
}

.bet-card-top,
.bet-card-top *,
.bet-payout {
  pointer-events: none;
}

.bet-card:active {
  transform: scale(0.985);
  filter: brightness(1.05);
}

.bet-card.player {
  background: rgba(30, 122, 214, 0.16);
}

.bet-card.banker {
  background: rgba(210, 62, 62, 0.16);
}

.bet-card.tie {
  background: rgba(89, 167, 116, 0.16);
}

.bet-card.pair-player {
  background: rgba(61, 124, 196, 0.12);
}

.bet-card.pair-banker {
  background: rgba(169, 54, 54, 0.12);
}

.grid-player,
.grid-tie,
.grid-banker {
  grid-column: span 2;
}

.grid-player-pair,
.grid-banker-pair {
  grid-column: span 3;
}

.bet-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.bet-card-top h3 {
  margin: 0 0 6px;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: clamp(18px, 5.2vw, 23px);
  font-weight: 900;
  line-height: 1.08;
  letter-spacing: 0.03em;
}

.bet-amount {
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: clamp(21px, 6vw, 26px);
  font-weight: 800;
  line-height: 1;
}

.bet-payout {
  margin: 12px 0 0;
  font-size: clamp(18px, 5vw, 22px);
  font-weight: 800;
  letter-spacing: 0.04em;
  text-align: center;
  text-shadow:
    0 0 18px rgba(244, 222, 155, 0.18),
    0 10px 24px rgba(0, 0, 0, 0.22);
  background: linear-gradient(180deg, #fff7da 0%, #f4de9b 38%, #d7a74c 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.chip-rack {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.chip {
  width: 58px;
  height: 58px;
  border-radius: 50%;
  border: 3px solid rgba(255, 245, 204, 0.32);
  background:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.4), transparent 35%),
    linear-gradient(135deg, #a51f30, #df6c5f);
  color: #fff7ef;
  font-weight: 800;
  box-shadow: inset 0 0 0 6px rgba(255, 255, 255, 0.12);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
}

.chip.active {
  transform: translateY(-4px);
  border-color: #f4de9b;
  box-shadow:
    0 10px 20px rgba(0, 0, 0, 0.24),
    inset 0 0 0 6px rgba(255, 255, 255, 0.12);
}

.chip:active {
  transform: scale(0.96);
  filter: brightness(1.05);
}

.settlement-popup {
  position: fixed;
  top: 28px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 90;
  min-width: 240px;
  padding: 18px 28px;
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  background: rgba(8, 18, 14, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
}

.settlement-popup strong {
  font-size: 16px;
}

.settlement-popup span {
  font-size: 34px;
  font-weight: 900;
}

.settlement-popup.positive span {
  color: #72f2a5;
}

.settlement-popup.negative span {
  color: #ff7f7f;
}

.settlement-pop-enter-active,
.settlement-pop-leave-active {
  transition: opacity 220ms ease, transform 220ms ease;
}

.settlement-pop-enter-from,
.settlement-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -16px) scale(0.94);
}

.game-message-toast {
  position: fixed;
  top: 92px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 85;
  max-width: min(80vw, 320px);
  padding: 10px 16px;
  border-radius: 14px;
  background: rgba(8, 18, 14, 0.94);
  border: 1px solid rgba(244, 222, 155, 0.22);
  color: #f7f4e9;
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.24);
  pointer-events: none;
}

.game-message-pop-enter-active,
.game-message-pop-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.game-message-pop-enter-from,
.game-message-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -10px);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(3, 9, 7, 0.66);
  backdrop-filter: blur(6px);
}

.settings-modal {
  position: relative;
  width: min(100%, 360px);
  padding: 24px 18px 18px;
}

.settings-modal-head h2 {
  margin: 4px 0 0;
}

.settings-close-button {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 999px;
  background: rgba(182, 34, 34, 0.92);
  color: #fff7f7;
  font-size: 16px;
  font-weight: 900;
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.22);
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 18px;
}

.settings-item {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.05);
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #f7f4e9;
  text-align: left;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition:
    transform 120ms ease,
    border-color 120ms ease,
    background 120ms ease;
}

.settings-item span {
  font-size: 15px;
  font-weight: 800;
}

.settings-item strong {
  color: rgba(247, 244, 233, 0.62);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.settings-item.active {
  background: rgba(244, 222, 155, 0.14);
  border-color: rgba(244, 222, 155, 0.38);
}

.settings-item.active strong {
  color: #f4de9b;
}

.settings-item:active {
  transform: scale(0.985);
}

@keyframes deal-in {
  from {
    transform: translateY(-42px) rotate(-10deg) scale(0.9);
    opacity: 0;
  }
  to {
    transform: translateY(0) rotate(0) scale(1);
    opacity: 1;
  }
}

</style>
