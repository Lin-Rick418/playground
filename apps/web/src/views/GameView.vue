<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import axios from "axios";
import { useRoute, useRouter } from "vue-router";
import { createLiveEventSource, type LiveUpdateEvent } from "../lib/live";
import RoadmapPanel from "../components/RoadmapPanel.vue";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";

type BetKey = "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR";
type DisplayCard = { rank: string; suit: string };
type CardRank = DisplayCard["rank"];
type PendingBetAmounts = Record<BetKey, number>;
type RoadVisibilitySettings = {
  beadRoad: boolean;
  bigRoad: boolean;
  bigEyeRoad: boolean;
  smallRoad: boolean;
  cockroachRoad: boolean;
};

const authStore = useAuthStore();
const gameStore = useGameStore();
const route = useRoute();
const router = useRouter();
const tableId = computed(() => String(route.params.tableId));
const ROAD_VISIBILITY_STORAGE_KEY = "baccarat-road-visibility";
const chipValues = [100, 500, 1000, 10000, 50000] as const;
const selectedChip = ref<(typeof chipValues)[number]>(chipValues[1]);
const isPlacingBet = ref(false);
const isRoadSettingsOpen = ref(false);
const betGridRef = ref<HTMLElement | null>(null);

const roadVisibilityOptions = [
  { key: "beadRoad", label: "珠盤路" },
  { key: "bigRoad", label: "大路" },
  { key: "bigEyeRoad", label: "大眼仔路" },
  { key: "smallRoad", label: "小路" },
  { key: "cockroachRoad", label: "曱甴路" },
] as const satisfies ReadonlyArray<{ key: keyof RoadVisibilitySettings; label: string }>;

const mainBetOptions = [
  { key: "PLAYER", label: "閒", payout: "1:1", accent: "player" },
  { key: "TIE", label: "和", payout: "8:1", accent: "tie" },
  { key: "BANKER", label: "莊", payout: "0.95:1", accent: "banker" },
] as const;

const sideBetOptions = [
  { key: "PLAYER_PAIR", label: "閒對", payout: "11:1", accent: "pair-player" },
  { key: "BANKER_PAIR", label: "莊對", payout: "11:1", accent: "pair-banker" },
] as const;

const betOptions = [
  ...mainBetOptions.map((option) => ({
    ...option,
    gridClass: option.key === "PLAYER" ? "grid-player" : option.key === "TIE" ? "grid-tie" : "grid-banker",
  })),
  ...sideBetOptions.map((option) => ({
    ...option,
    gridClass: option.key === "PLAYER_PAIR" ? "grid-player-pair" : "grid-banker-pair",
  })),
] as const;

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
const pendingBetAmounts = ref<PendingBetAmounts>({
  PLAYER: 0,
  BANKER: 0,
  TIE: 0,
  PLAYER_PAIR: 0,
  BANKER_PAIR: 0,
});
const roadVisibility = ref<RoadVisibilitySettings>(loadRoadVisibilitySettings());
const clockNow = ref(Date.now());
const serverTimeOffsetMs = ref(0);
let stream: EventSource | null = null;
let fallbackTimer: number | null = null;
let clockTimer: number | null = null;
let refreshGameDataPromise: Promise<void> | null = null;
let refreshGameDataQueued = false;
let lastBetGridTouchEndMs = 0;
const BASE_CARD_INTERVAL_MS = 520;
const BASE_REVEAL_DELAY_MS = 2400;
const BONUS_PHASE_DELAY_MS = 620;
const BONUS_CARD_INTERVAL_MS = 620;
const NO_BONUS_REVEAL_DELAY_MS = 850;
const FINAL_REVEAL_DELAY_MS = 520;

const totalBet = computed(() => {
  const currentTotal = gameStore.currentBets.reduce((sum, bet) => sum + bet.amount, 0);
  const pendingTotal = Object.values(pendingBetAmounts.value).reduce((sum, amount) => sum + amount, 0);
  return currentTotal + pendingTotal;
});
const currentRound = computed(() => gameStore.currentRound);
const presentationRound = computed(() => gameStore.previousRound);
const currentTable = computed(() => gameStore.currentTable);
const syncedServerNowMs = computed(() => clockNow.value + serverTimeOffsetMs.value);
const availableChips = computed(() => {
  const minBet = currentTable.value?.minBet ?? chipValues[0];
  const maxBet = currentTable.value?.maxBet ?? 5000;
  const chips = chipValues.filter((chip) => chip >= minBet && chip <= maxBet);
  return chips.length ? chips : chipValues.filter((chip) => chip <= maxBet);
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

  return presentationRound.value.winner === "PLAYER"
    ? "閒贏"
    : presentationRound.value.winner === "BANKER"
      ? "莊贏"
      : "和局";
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

function createDefaultRoadVisibility(): RoadVisibilitySettings {
  return {
    beadRoad: true,
    bigRoad: true,
    bigEyeRoad: true,
    smallRoad: true,
    cockroachRoad: true,
  };
}

function normalizeRoadVisibilitySettings(value: unknown): RoadVisibilitySettings {
  const defaults = createDefaultRoadVisibility();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  return {
    beadRoad: typeof (value as Partial<RoadVisibilitySettings>).beadRoad === "boolean" ? Boolean((value as Partial<RoadVisibilitySettings>).beadRoad) : defaults.beadRoad,
    bigRoad: typeof (value as Partial<RoadVisibilitySettings>).bigRoad === "boolean" ? Boolean((value as Partial<RoadVisibilitySettings>).bigRoad) : defaults.bigRoad,
    bigEyeRoad:
      typeof (value as Partial<RoadVisibilitySettings>).bigEyeRoad === "boolean"
        ? Boolean((value as Partial<RoadVisibilitySettings>).bigEyeRoad)
        : defaults.bigEyeRoad,
    smallRoad:
      typeof (value as Partial<RoadVisibilitySettings>).smallRoad === "boolean"
        ? Boolean((value as Partial<RoadVisibilitySettings>).smallRoad)
        : defaults.smallRoad,
    cockroachRoad:
      typeof (value as Partial<RoadVisibilitySettings>).cockroachRoad === "boolean"
        ? Boolean((value as Partial<RoadVisibilitySettings>).cockroachRoad)
        : defaults.cockroachRoad,
  };
}

function loadRoadVisibilitySettings() {
  if (typeof window === "undefined") {
    return createDefaultRoadVisibility();
  }

  try {
    const rawValue = window.localStorage.getItem(ROAD_VISIBILITY_STORAGE_KEY);
    return rawValue ? normalizeRoadVisibilitySettings(JSON.parse(rawValue)) : createDefaultRoadVisibility();
  } catch {
    return createDefaultRoadVisibility();
  }
}

async function refreshGameData() {
  if (refreshGameDataPromise) {
    refreshGameDataQueued = true;
    return refreshGameDataPromise;
  }

  refreshGameDataPromise = (async () => {
    const previousRoundId = currentRound.value?.id ?? "";
    const previousRoundBetTotal = gameStore.currentBets.reduce((sum, bet) => sum + bet.amount, 0);
    const state = await gameStore.fetchState(tableId.value);
    serverTimeOffsetMs.value = new Date(state.serverTime).getTime() - Date.now();
    authStore.patchBalance(state.balance);
    if (!availableChips.value.includes(selectedChip.value)) {
      selectedChip.value = availableChips.value[0] ?? chipValues[0];
    }

    const settledRound = state.previousRound;
    if (
      previousRoundId &&
      previousRoundId !== state.round.id &&
      settledRound &&
      settledRound.id === previousRoundId &&
      previousRoundBetTotal > 0 &&
      lastResolvedRoundId.value !== settledRound.id
    ) {
      lastResolvedRoundId.value = settledRound.id;
      await gameStore.fetchHistory();
      const settledHistory = gameStore.history.find((item) => item.round.id === settledRound.id);
      pendingSettlementAmount.value = settledHistory ? settledHistory.totalPayout - settledHistory.totalAmount : 0;
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

  const minBet = currentTable.value?.minBet ?? chipValues[0];
  const maxBet = currentTable.value?.maxBet ?? 10000;
  if (selectedChip.value < minBet) {
    gameStore.message = `最低下注 ${minBet.toLocaleString()}`;
    return;
  }

  if (currentBetAmount(target) + selectedChip.value > maxBet) {
    gameStore.message = `單一玩法最高下注 ${maxBet.toLocaleString()}`;
    return;
  }

  isPlacingBet.value = true;
  pendingBetAmounts.value[target] += selectedChip.value;

  try {
    const result = await gameStore.placeBet(tableId.value, [{ betType: target, amount: selectedChip.value }]);
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

function isOverlayCardFaceUp(side: "player" | "banker", index: number) {
  return side === "player" ? index < playerFaceUpCount.value : index < bankerFaceUpCount.value;
}

function showPendingSettlementIfNeeded() {
  if (pendingSettlementAmount.value !== null) {
    showSettlementPopup(pendingSettlementAmount.value);
    pendingSettlementAmount.value = null;
  }
}

function scheduleRevealTimer(delayMs: number, callback: () => void) {
  if (delayMs <= 0) {
    return;
  }

  revealTimers.push(window.setTimeout(callback, delayMs));
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
  const bonusCards = [
    { side: "player", card: presentationRound.value.playerCards[2] },
    { side: "banker", card: presentationRound.value.bankerCards[2] },
  ].filter((item): item is { side: "player" | "banker"; card: DisplayCard } => Boolean(item.card));

  const shownBaseCards = baseCards.filter((_item, index) => elapsedMs >= index * BASE_CARD_INTERVAL_MS);
  displayedPlayerCards.value = shownBaseCards.filter((item) => item.side === "player").map((item) => item.card);
  displayedBankerCards.value = shownBaseCards.filter((item) => item.side === "banker").map((item) => item.card);
  playerDealtCount.value = displayedPlayerCards.value.length;
  bankerDealtCount.value = displayedBankerCards.value.length;
  playerFaceUpCount.value = 0;
  bankerFaceUpCount.value = 0;
  dealingPhase.value = "dealing";

  if (elapsedMs >= BASE_REVEAL_DELAY_MS) {
    dealingPhase.value = "base-revealed";
    playerDealtCount.value = Math.max(playerDealtCount.value, Math.min(2, presentationRound.value.playerCards.length));
    bankerDealtCount.value = Math.max(bankerDealtCount.value, Math.min(2, presentationRound.value.bankerCards.length));
    playerFaceUpCount.value = Math.min(2, displayedPlayerCards.value.length);
    bankerFaceUpCount.value = Math.min(2, displayedBankerCards.value.length);
  }

  if (!bonusCards.length) {
    if (elapsedMs >= BASE_REVEAL_DELAY_MS + NO_BONUS_REVEAL_DELAY_MS) {
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

  const bonusStartMs = BASE_REVEAL_DELAY_MS + BONUS_PHASE_DELAY_MS;
  if (elapsedMs >= bonusStartMs) {
    dealingPhase.value = "bonus-dealing";
    const shownBonusCards = bonusCards.filter(
      (_item, index) => elapsedMs >= bonusStartMs + index * BONUS_CARD_INTERVAL_MS,
    );
    displayedPlayerCards.value = [
      ...presentationRound.value.playerCards.slice(0, 2),
      ...shownBonusCards.filter((item) => item.side === "player").map((item) => item.card),
    ];
    displayedBankerCards.value = [
      ...presentationRound.value.bankerCards.slice(0, 2),
      ...shownBonusCards.filter((item) => item.side === "banker").map((item) => item.card),
    ];
    playerDealtCount.value = displayedPlayerCards.value.length;
    bankerDealtCount.value = displayedBankerCards.value.length;
    playerFaceUpCount.value = 2;
    bankerFaceUpCount.value = 2;
  }

  if (elapsedMs >= bonusStartMs + bonusCards.length * BONUS_CARD_INTERVAL_MS + FINAL_REVEAL_DELAY_MS) {
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
  const bonusCards = [
    { side: "player", card: round.playerCards[2] },
    { side: "banker", card: round.bankerCards[2] },
  ].filter((item): item is { side: "player" | "banker"; card: DisplayCard } => Boolean(item.card));

  const elapsedMs = serverNowMs - presentationStartsAtMs;

  baseCards.forEach((item, index) => {
    scheduleRevealTimer(index * BASE_CARD_INTERVAL_MS - elapsedMs, () => {
      if (item.side === "player") {
        displayedPlayerCards.value = [...displayedPlayerCards.value, item.card];
        playerDealtCount.value = displayedPlayerCards.value.length;
      } else {
        displayedBankerCards.value = [...displayedBankerCards.value, item.card];
        bankerDealtCount.value = displayedBankerCards.value.length;
      }
    });
  });

  scheduleRevealTimer(BASE_REVEAL_DELAY_MS - elapsedMs, () => {
    dealingPhase.value = "base-revealed";
    playerDealtCount.value = Math.max(playerDealtCount.value, Math.min(2, round.playerCards.length));
    bankerDealtCount.value = Math.max(bankerDealtCount.value, Math.min(2, round.bankerCards.length));
    playerFaceUpCount.value = Math.min(2, displayedPlayerCards.value.length);
    bankerFaceUpCount.value = Math.min(2, displayedBankerCards.value.length);
  });

  if (!bonusCards.length) {
    scheduleRevealTimer(BASE_REVEAL_DELAY_MS + NO_BONUS_REVEAL_DELAY_MS - elapsedMs, () => {
      dealingPhase.value = "revealed";
      displayedPlayerCards.value = [...round.playerCards];
      displayedBankerCards.value = [...round.bankerCards];
      playerDealtCount.value = displayedPlayerCards.value.length;
      bankerDealtCount.value = displayedBankerCards.value.length;
      playerFaceUpCount.value = displayedPlayerCards.value.length;
      bankerFaceUpCount.value = displayedBankerCards.value.length;
    });
  } else {
    const bonusStartMs = BASE_REVEAL_DELAY_MS + BONUS_PHASE_DELAY_MS;
    scheduleRevealTimer(bonusStartMs - elapsedMs, () => {
      dealingPhase.value = "bonus-dealing";
    });

    bonusCards.forEach((item, index) => {
      scheduleRevealTimer(bonusStartMs + index * BONUS_CARD_INTERVAL_MS - elapsedMs, () => {
        if (item.side === "player") {
          displayedPlayerCards.value = [...round.playerCards.slice(0, 2), item.card];
          playerDealtCount.value = displayedPlayerCards.value.length;
        } else {
          displayedBankerCards.value = [...round.bankerCards.slice(0, 2), item.card];
          bankerDealtCount.value = displayedBankerCards.value.length;
        }
      });
    });

    scheduleRevealTimer(bonusStartMs + bonusCards.length * BONUS_CARD_INTERVAL_MS + FINAL_REVEAL_DELAY_MS - elapsedMs, () => {
      dealingPhase.value = "revealed";
      displayedPlayerCards.value = [...round.playerCards];
      displayedBankerCards.value = [...round.bankerCards];
      playerDealtCount.value = displayedPlayerCards.value.length;
      bankerDealtCount.value = displayedBankerCards.value.length;
      playerFaceUpCount.value = displayedPlayerCards.value.length;
      bankerFaceUpCount.value = displayedBankerCards.value.length;
    });
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

function toggleRoadVisibility(target: keyof RoadVisibilitySettings) {
  roadVisibility.value[target] = !roadVisibility.value[target];
}

function preventBetGridDoubleTapZoom(event: TouchEvent) {
  const now = event.timeStamp || Date.now();
  if (now - lastBetGridTouchEndMs < 320) {
    event.preventDefault();
  }

  lastBetGridTouchEndMs = now;
}

function startFallbackPolling() {
  if (fallbackTimer) {
    window.clearInterval(fallbackTimer);
  }

  fallbackTimer = window.setInterval(async () => {
    await refreshGameData();
  }, 1000);
}

function handleLiveEvent(event: LiveUpdateEvent) {
  if (event.type === "table_updated" && event.tableId === tableId.value) {
    void refreshGameData();
    return;
  }

  if (event.type === "user_updated") {
    void refreshGameData();
  }
}

function connectTableStream() {
  stream?.close();

  if (typeof EventSource === "undefined") {
    startFallbackPolling();
    return;
  }

  if (fallbackTimer) {
    window.clearInterval(fallbackTimer);
    fallbackTimer = null;
  }

  stream = createLiveEventSource(`/game/stream/tables/${tableId.value}`, handleLiveEvent);
}

onMounted(async () => {
  await refreshGameData();
  clockTimer = window.setInterval(() => {
    clockNow.value = Date.now();
  }, 250);
  connectTableStream();
  betGridRef.value?.addEventListener("touchend", preventBetGridDoubleTapZoom, { passive: false });
});

onUnmounted(() => {
  stopRevealTimers();
  stopSettlementPopupTimer();
  pendingSettlementAmount.value = null;
  stream?.close();
  if (fallbackTimer) {
    window.clearInterval(fallbackTimer);
  }
  if (clockTimer) {
    window.clearInterval(clockTimer);
  }
  betGridRef.value?.removeEventListener("touchend", preventBetGridDoubleTapZoom);
});

watch(tableId, async () => {
  await refreshGameData();
  connectTableStream();
});

watch(
  roadVisibility,
  (value) => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ROAD_VISIBILITY_STORAGE_KEY, JSON.stringify(value));
  },
  { deep: true },
);
</script>

<template>
  <main class="page-shell game-page">
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
    <div class="countdown-chip floating-countdown" :class="{ danger: countdownSeconds <= 5 }">{{ countdownSeconds }}</div>
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

    <section class="panel table-panel">
      <div class="table-head">
        <div>
          <p class="topbar-label">Baccarat Table</p>
          <h2>下注桌</h2>
          <p class="table-limit-text">
            {{ currentTable?.code }} / {{ Math.round((currentTable?.roundDurationMs ?? 30000) / 1000) }} 秒 / 最低
            {{ currentTable?.minBet?.toLocaleString() ?? "--" }} / 單種最高 {{ currentTable?.maxBet?.toLocaleString() ?? "--" }}
          </p>
        </div>
        <strong>總下注 {{ formatBetDisplayAmount(totalBet) }}</strong>
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
      <RoadmapPanel :rounds="gameStore.roadRounds" :visibility="roadVisibility" />
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
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-x: clip;
  height: 100vh;
  max-height: 100vh;
  padding-top: 82px;
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
  padding: 18px;
}

.deal-overlay {
  position: fixed;
  inset: 0;
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

.deal-overlay-panel {
  width: 100%;
  max-width: 100%;
  padding: 22px 18px;
  overflow: hidden;
}

.floating-balance {
  position: fixed;
  top: 22px;
  right: 86px;
  z-index: 20;
  height: 52px;
  padding: 0 16px 0 12px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
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
  font-size: 18px;
  font-weight: 900;
  line-height: 1;
}

.floating-countdown {
  position: fixed;
  top: 22px;
  left: auto;
  right: 22px;
  bottom: auto;
  z-index: 20;
  pointer-events: none;
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

.table-limit-text {
  margin: 8px 0 0;
  color: rgba(247, 244, 233, 0.72);
  font-size: 13px;
}

.table-panel,
.road-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.table-panel {
  flex: 7 1 0;
  overflow: auto;
  justify-content: space-around ;
}

.road-panel {
  flex: 3 1 0;
  overflow: hidden;
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
  width: 52px;
  height: 52px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: fixed;
  background:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.5), transparent 34%),
    linear-gradient(180deg, #7cf3a4, #3ec870);
  color: #f7f4e9;
  font-size: 18px;
  font-weight: 900;
  box-shadow:
    inset 0 0 0 3px rgba(255, 255, 255, 0.22),
    0 10px 20px rgba(0, 0, 0, 0.18),
    0 0 24px rgba(83, 219, 132, 0.28);
  animation: countdown-pulse 1.4s ease-in-out infinite;
}

.countdown-chip.danger {
  animation-duration: 0.55s;
  color: #b21919;
}

.countdown-chip::before,
.countdown-chip::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 999px;
  border: 2px solid rgba(124, 243, 164, 0.38);
  animation: countdown-ring 1.8s ease-out infinite;
}

.countdown-chip.danger::before,
.countdown-chip.danger::after {
  border-color: rgba(255, 105, 105, 0.48);
  animation-duration: 0.8s;
}

.countdown-chip::after {
  animation-delay: 0.9s;
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
  gap: 12px;
  margin: 18px 0 16px;
}

.bet-card {
  border-radius: 18px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
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
}

.bet-amount {
  font-size: 20px;
  font-weight: 800;
}

.bet-payout {
  margin: 10px 0 0;
  color: #f4de9b;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-align: center;
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
