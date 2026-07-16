<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import axios from "axios";
import { useRoute, useRouter } from "vue-router";
import RoadmapPanel from "../components/RoadmapPanel.vue";
import { BET_OPTIONS, CHIP_VALUES, DEAL_ANIMATION_TIMINGS, DEFAULT_CHIP_VALUE, WINNER_LABELS } from "../const/game";
import { useDialogFocus } from "../composables/useDialogFocus";
import { useLiveChannel } from "../composables/useLiveChannel";
import { loadVoiceAnnouncementEnabled, saveVoiceAnnouncementEnabled } from "../lib/settings";
import { playVoiceClips, preloadVoiceClips, stopVoicePlayback, unlockVoicePlayback } from "../lib/voice";
import type { TableSnapshotMessage, TableUserSnapshotMessage } from "../lib/live";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import type { ActiveRound, BetType, Card } from "../types/domain";

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
const isRoadmapOpen = ref(false);
const isTableLoading = ref(true);
const isVoiceAnnouncementEnabled = ref(loadVoiceAnnouncementEnabled());
const settlementDialogRef = ref<HTMLElement | null>(null);
const settlementCloseButtonRef = ref<HTMLElement | null>(null);
const roadmapDialogRef = ref<HTMLElement | null>(null);
const roadmapCloseButtonRef = ref<HTMLElement | null>(null);
const settingsDialogRef = ref<HTMLElement | null>(null);
const settingsCloseButtonRef = ref<HTMLElement | null>(null);

const displayedPlayerCards = ref<DisplayCard[]>([]);
const displayedBankerCards = ref<DisplayCard[]>([]);
const playerDealtCount = ref(0);
const bankerDealtCount = ref(0);
const playerFaceUpCount = ref(0);
const bankerFaceUpCount = ref(0);
const revealTimers: number[] = [];
const dealingPhase = ref<"idle" | "dealing" | "base-revealed" | "bonus-dealing" | "revealed">("idle");
const showDealOverlay = ref(false);
type SettlementInfo = { participated: boolean; amount: number };
type SettlementScreen = SettlementInfo & {
  winner: keyof typeof WINNER_LABELS;
  playerTotal: number;
  bankerTotal: number;
  playerPair: boolean;
  bankerPair: boolean;
};
const settlementPopup = ref<null | SettlementScreen>(null);
const settlementPopupTimer = ref<number | null>(null);
const pendingSettlement = ref<SettlementInfo | null>(null);
const { onDialogKeydown: onSettlementDialogKeydown } = useDialogFocus({
  isOpen: () => Boolean(settlementPopup.value),
  dialogRef: settlementDialogRef,
  close: dismissSettlementPopup,
  initialFocusRef: settlementCloseButtonRef,
});
const { onDialogKeydown: onRoadmapDialogKeydown } = useDialogFocus({
  isOpen: () => isRoadmapOpen.value,
  dialogRef: roadmapDialogRef,
  close: closeRoadmap,
  initialFocusRef: roadmapCloseButtonRef,
});
const { onDialogKeydown: onSettingsDialogKeydown } = useDialogFocus({
  isOpen: () => isRoadSettingsOpen.value,
  dialogRef: settingsDialogRef,
  close: closeRoadSettings,
  initialFocusRef: settingsCloseButtonRef,
});
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
const stagedBetAmounts = ref<PendingBetAmounts>({
  PLAYER: 0,
  BANKER: 0,
  TIE: 0,
  PLAYER_PAIR: 0,
  BANKER_PAIR: 0,
});
const clockNow = ref(Date.now());
const serverTimeOffsetMs = ref(0);
let clockTimer: number | null = null;
let refreshGameDataPromise: Promise<void> | null = null;
let refreshGameDataQueued = false;
let messageTimer: number | null = null;
const VOICE_UNLOCK_EVENTS = ["pointerdown", "touchstart", "keydown"] as const;

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
  const table = currentTable.value;
  if (!table) {
    return [...CHIP_VALUES];
  }

  const { minBet, maxBet } = table;
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
const countdownDisplay = computed(() => (countdownSeconds.value > 0 ? String(countdownSeconds.value) : ""));
const isBettingOpen = computed(() => {
  if (!currentRound.value || currentRound.value.status !== "OPEN") {
    return false;
  }

  const serverTime = syncedServerNowMs.value;
  const opensAt = new Date(currentRound.value.bettingOpensAt).getTime();
  const closesAt = new Date(currentRound.value.bettingClosesAt).getTime();
  return serverTime >= opensAt && serverTime < closesAt;
});
const bettingStatusAnnouncement = computed(() => (isBettingOpen.value ? "下注已開放" : "目前停止下注"));
const isLastHandRound = computed(() => Boolean(gameStore.shoeStatus?.isLastHand));
const playerScoreDisplay = computed(() => {
  if (showDealOverlay.value) {
    return faceUpPlayerCards.value.length ? visibleHandTotal(faceUpPlayerCards.value) : 0;
  }

  return presentationRound.value?.playerTotal ?? 0;
});
const bankerScoreDisplay = computed(() => {
  if (showDealOverlay.value) {
    return faceUpBankerCards.value.length ? visibleHandTotal(faceUpBankerCards.value) : 0;
  }

  return presentationRound.value?.bankerTotal ?? 0;
});
const feltPlayerCards = computed(() =>
  showDealOverlay.value ? overlayPlayerCards.value : presentationRound.value?.playerCards ?? [],
);
const feltBankerCards = computed(() =>
  showDealOverlay.value ? overlayBankerCards.value : presentationRound.value?.bankerCards ?? [],
);
const todayProfit = computed(() => gameStore.dailyProfit?.netProfit ?? null);
const dailyProfitPeriodLabel = computed(() => {
  const summary = gameStore.dailyProfit;
  return summary ? `${summary.date.slice(5)} 收益 · ${summary.timeZone}` : "本日收益";
});
const dailyProfitAccessibleLabel = computed(() => {
  const summary = gameStore.dailyProfit;
  return summary ? `${summary.date} 收益，時區 ${summary.timeZone}` : "本日收益尚未載入";
});

function betOptionsByKeys(keys: readonly BetKey[]) {
  return keys.flatMap((key) => betOptions.filter((option) => option.key === key));
}

const sideBetRow = betOptionsByKeys(["PLAYER_PAIR", "TIE", "BANKER_PAIR"]);
const mainBetRow = betOptionsByKeys(["PLAYER", "BANKER"]);

const lastBetSnapshot = ref<null | { roundId: string; bets: { betType: BetKey; amount: number }[] }>(null);
const canRepeatLastBets = computed(() =>
  Boolean(
    lastBetSnapshot.value &&
      isBettingOpen.value &&
      currentRound.value &&
      lastBetSnapshot.value.roundId !== currentRound.value.id,
  ),
);
const totalStagedAmount = computed(() =>
  (Object.values(stagedBetAmounts.value) as number[]).reduce((sum, amount) => sum + amount, 0),
);
const hasStagedBets = computed(() => totalStagedAmount.value > 0);

watch(
  () => [gameStore.currentBets, currentRound.value?.id ?? ""] as const,
  ([bets, roundId]) => {
    if (!roundId || !bets.length) {
      return;
    }

    const aggregated = new Map<BetKey, number>();
    for (const bet of bets) {
      aggregated.set(bet.betType, (aggregated.get(bet.betType) ?? 0) + bet.amount);
    }

    lastBetSnapshot.value = {
      roundId,
      bets: [...aggregated].map(([betType, amount]) => ({ betType, amount })),
    };
  },
  { deep: true },
);

function chipLabel(chip: number) {
  return chip >= 10000 ? `${chip / 10000}萬` : chip.toLocaleString();
}

function isFeltCardFaceUp(side: "player" | "banker", index: number) {
  return showDealOverlay.value ? isOverlayCardFaceUp(side, index) : true;
}

function repeatLastBets() {
  const table = currentTable.value;
  const user = authStore.user;
  if (!canRepeatLastBets.value || isPlacingBet.value || !lastBetSnapshot.value || !table || !user) {
    return;
  }

  const bets = lastBetSnapshot.value.bets;
  const totalAmount = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const maxBet = table.maxBet;

  if (user.balance < totalStagedAmount.value + totalPendingAmount() + totalAmount) {
    gameStore.message = "餘額不足";
    return;
  }

  if (bets.some((bet) => currentBetAmount(bet.betType) + bet.amount > maxBet)) {
    gameStore.message = `單一玩法最高下注 ${maxBet.toLocaleString()}`;
    return;
  }

  for (const bet of bets) {
    stagedBetAmounts.value[bet.betType] += bet.amount;
  }
}

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
    if (state.myBets.length) {
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
      settledRound.id === previousRoundId
    ) {
      await handleRoundSettled(settledRound, state.serverTime);
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
  return actualAmount + stagedBetAmounts.value[target] + pendingBetAmounts.value[target];
}

function totalPendingAmount() {
  return (Object.values(pendingBetAmounts.value) as number[]).reduce((sum, amount) => sum + amount, 0);
}

function formatBetDisplayAmount(amount: number) {
  if (amount < 1000) {
    return amount.toLocaleString();
  }

  const compactAmount = amount / 1000;
  return `${Number.isInteger(compactAmount) ? compactAmount : compactAmount.toFixed(1).replace(/\.0$/, "")}k`;
}

function betAreaAriaLabel(option: (typeof BET_OPTIONS)[number]) {
  const amount = currentBetAmount(option.key);
  const amountText = amount ? `，目前下注 ${amount.toLocaleString()}` : "，目前尚未下注";
  return `${option.label}，賠率 ${option.payout}，每次增加 ${selectedChip.value.toLocaleString()}${amountText}`;
}

function stageBet(target: BetKey) {
  const table = currentTable.value;
  const user = authStore.user;
  if (!isBettingOpen.value || !table || !user) {
    return;
  }

  const { minBet, maxBet } = table;
  if (selectedChip.value < minBet) {
    gameStore.message = `最低下注 ${minBet.toLocaleString()}`;
    return;
  }

  if (currentBetAmount(target) + selectedChip.value > maxBet) {
    gameStore.message = `單一玩法最高下注 ${maxBet.toLocaleString()}`;
    return;
  }

  if (user.balance < totalStagedAmount.value + totalPendingAmount() + selectedChip.value) {
    gameStore.message = "餘額不足";
    return;
  }

  stagedBetAmounts.value[target] += selectedChip.value;
}

function resetStagedBetAmounts() {
  stagedBetAmounts.value = { PLAYER: 0, BANKER: 0, TIE: 0, PLAYER_PAIR: 0, BANKER_PAIR: 0 };
}

function clearStagedBets() {
  resetStagedBetAmounts();
}

async function confirmStagedBets() {
  const table = currentTable.value;
  const user = authStore.user;
  if (!hasStagedBets.value || isPlacingBet.value || !table || !user) {
    return;
  }

  if (!isBettingOpen.value) {
    gameStore.message = "Betting is closed";
    void refreshGameData();
    return;
  }

  const bets = (Object.entries(stagedBetAmounts.value) as [BetKey, number][])
    .filter(([, amount]) => amount > 0)
    .map(([betType, amount]) => ({ betType, amount }));
  const totalAmount = bets.reduce((sum, bet) => sum + bet.amount, 0);

  if (user.balance < totalPendingAmount() + totalAmount) {
    gameStore.message = "餘額不足";
    return;
  }

  isPlacingBet.value = true;
  for (const bet of bets) {
    pendingBetAmounts.value[bet.betType] += bet.amount;
  }
  const submittedStaged = { ...stagedBetAmounts.value };
  resetStagedBetAmounts();

  try {
    const result = await gameStore.placeBet(tableId.value, bets);
    latestParticipatedRoundId.value = result.round.id;
    authStore.patchBalance(result.balance);
  } catch (error) {
    for (const [betType, amount] of Object.entries(submittedStaged) as [BetKey, number][]) {
      stagedBetAmounts.value[betType] += amount;
    }
    const message = axios.isAxiosError(error) ? (error.response?.data?.message ?? "下注失敗") : "下注失敗";
    gameStore.message = message;
    if (message === "Betting is closed") {
      void refreshGameData();
    }
  } finally {
    for (const bet of bets) {
      pendingBetAmounts.value[bet.betType] = Math.max(0, pendingBetAmounts.value[bet.betType] - bet.amount);
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

function dismissSettlementPopup() {
  stopSettlementPopupTimer();
  settlementPopup.value = null;
}

function stopMessageTimer() {
  if (messageTimer) {
    window.clearTimeout(messageTimer);
    messageTimer = null;
  }
}

function showSettlementPopup(info: SettlementInfo) {
  const round = presentationRound.value;
  if (!round) {
    return;
  }

  stopSettlementPopupTimer();
  settlementPopup.value = {
    ...info,
    winner: round.winner,
    playerTotal: round.playerTotal,
    bankerTotal: round.bankerTotal,
    playerPair: round.playerPair,
    bankerPair: round.bankerPair,
  };
  settlementPopupTimer.value = window.setTimeout(() => {
    settlementPopup.value = null;
  }, 3400);
}

async function handleRoundSettled(settledRound: ActiveRound, serverTimeIso: string) {
  if (lastResolvedRoundId.value === settledRound.id) {
    return;
  }

  lastResolvedRoundId.value = settledRound.id;
  const participated = settledRound.id === latestParticipatedRoundId.value;
  let amount = 0;

  if (participated) {
    await gameStore.fetchHistory();
    const settledHistory = gameStore.history.find((item) => item.round.id === settledRound.id);
    amount = settledHistory ? settledHistory.totalPayout - settledHistory.totalAmount : 0;
  }

  queueSettlementPopup({ participated, amount }, serverTimeIso);
}

function cardSuitSymbol(suit: Card["suit"]) {
  return suit === "S" ? "♠" : suit === "H" ? "♥" : suit === "D" ? "♦" : "♣";
}

function cardColor(suit: Card["suit"]) {
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

  return cards.reduce((sum, card) => sum + values[card.rank], 0) % 10;
}

function speakRoundTotals(round: NonNullable<typeof presentationRound.value>) {
  if (!isVoiceAnnouncementEnabled.value) {
    return;
  }

  const winnerClip =
    round.winner === "PLAYER" ? "xianWin" : round.winner === "BANKER" ? "zhuangWin" : "tie";
  const clips = [`xian${round.playerTotal}`, `zhuang${round.bankerTotal}`, winnerClip];
  if (round.playerPair) {
    clips.push("xianPair");
  }
  if (round.bankerPair) {
    clips.push("zhuangPair");
  }

  void playVoiceClips(clips);
}

function testVoiceAnnouncement() {
  unlockVoicePlayback();

  if (!isVoiceAnnouncementEnabled.value) {
    isVoiceAnnouncementEnabled.value = true;
  }

  void playVoiceClips(["xian8", "zhuang5", "xianWin"]);
}

function isOverlayCardFaceUp(side: "player" | "banker", index: number) {
  return side === "player" ? index < playerFaceUpCount.value : index < bankerFaceUpCount.value;
}

function showPendingSettlementIfNeeded() {
  if (pendingSettlement.value !== null) {
    showSettlementPopup(pendingSettlement.value);
    pendingSettlement.value = null;
  }
}

function queueSettlementPopup(info: SettlementInfo, serverTimeIso?: string) {
  pendingSettlement.value = info;

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

function openRoadmap() {
  isRoadmapOpen.value = true;
}

function closeRoadmap() {
  isRoadmapOpen.value = false;
}

function resetPendingBetAmounts() {
  pendingBetAmounts.value = { PLAYER: 0, BANKER: 0, TIE: 0, PLAYER_PAIR: 0, BANKER_PAIR: 0 };
}

async function applyTableSnapshotMessage(message: TableSnapshotMessage) {
  const previousRoundId = currentRound.value?.id ?? "";

  gameStore.applyTableSnapshot(message.data);
  serverTimeOffsetMs.value = new Date(message.data.serverTime).getTime() - Date.now();
  syncPresentationWindow(message.data.serverTime);
  isTableLoading.value = false;

  if (previousRoundId && previousRoundId !== message.data.round.id) {
    resetPendingBetAmounts();
    resetStagedBetAmounts();
  }

  const settledRound = message.data.previousRound;
  if (
    previousRoundId &&
    previousRoundId !== message.data.round.id &&
    settledRound &&
    settledRound.id === previousRoundId
  ) {
    await handleRoundSettled(settledRound, message.data.serverTime);
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
  VOICE_UNLOCK_EVENTS.forEach((eventName) =>
    window.addEventListener(eventName, unlockVoicePlayback, { once: true, passive: true }),
  );
  void preloadVoiceClips();
  void gameStore.fetchHistory().catch(() => {});
  await loadTableState();
});

onUnmounted(() => {
  stopRevealTimers();
  stopSettlementPopupTimer();
  stopMessageTimer();
  pendingSettlement.value = null;
  stopVoicePlayback();
  if (clockTimer) {
    window.clearInterval(clockTimer);
  }
  VOICE_UNLOCK_EVENTS.forEach((eventName) => window.removeEventListener(eventName, unlockVoicePlayback));
});

watch(tableId, async () => {
  gameStore.currentBets = [];
  resetStagedBetAmounts();
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

watch(isVoiceAnnouncementEnabled, (value) => {
  saveVoiceAnnouncementEnabled(value);
});

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
        <div class="table-loading-panel panel" role="status" aria-live="polite" aria-atomic="true">
          <div class="table-loading-spinner" aria-hidden="true" />
          <p class="topbar-label">Loading Table</p>
          <strong>進入牌桌中</strong>
          <span>正在同步最新桌況與路圖</span>
        </div>
      </div>
    </transition>

    <header class="table-nav">
      <button class="nav-icon-button" type="button" @click="backToLobby" aria-label="返回大廳">‹</button>
      <div class="table-nav-title">
        <h1>{{ currentTable?.name ?? "遊戲桌" }}</h1>
        <p>
          {{ currentTable?.code ?? "--" }}｜{{ Math.round((currentTable?.roundDurationMs ?? 30000) / 1000) }}秒｜限紅
          {{ currentTable?.minBet?.toLocaleString() ?? "--" }}-{{ currentTable?.maxBet?.toLocaleString() ?? "--" }}
        </p>
      </div>
      <button class="nav-text-button" type="button" @click="openRoadSettings" aria-haspopup="dialog">設定</button>
    </header>

    <div class="table-toolbar">
      <transition name="last-hand-fade">
        <div v-if="isLastHandRound" class="last-hand-pill" role="status" aria-live="polite">最後一局</div>
      </transition>
      <div class="toolbar-actions">
        <button type="button" class="toolbar-round-button" @click="openRoadmap" aria-haspopup="dialog" aria-label="開啟路單">
          <span class="road-dots" aria-hidden="true">
            <i class="dot player" /><i class="dot banker" /><i class="dot tie" /><i class="dot gold" />
          </span>
          <span class="toolbar-round-label">路單</span>
        </button>
        <button
          type="button"
          class="toolbar-round-button sound-button"
          :class="{ muted: !isVoiceAnnouncementEnabled }"
          @click="isVoiceAnnouncementEnabled = !isVoiceAnnouncementEnabled"
          :aria-pressed="isVoiceAnnouncementEnabled"
          :aria-label="isVoiceAnnouncementEnabled ? '關閉語音播報' : '開啟語音播報'"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9v6h4l5 4V5L8 9H4Z" />
            <path v-if="isVoiceAnnouncementEnabled" d="M16.5 8.5a5 5 0 0 1 0 7M18.8 6.2a8 8 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path v-else d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <transition name="settlement-pop">
      <div v-if="settlementPopup" class="settlement-screen" @click.self="dismissSettlementPopup">
        <section
          ref="settlementDialogRef"
          class="settlement-card panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settlement-title"
          tabindex="-1"
          @keydown="onSettlementDialogKeydown"
        >
          <button
            ref="settlementCloseButtonRef"
            type="button"
            class="settlement-close-button"
            @click="dismissSettlementPopup"
            aria-label="關閉本局結算"
          >
            ✕
          </button>
          <p id="settlement-title" class="settlement-eyebrow">本局結算</p>
          <p class="settlement-result" :class="settlementPopup.winner === 'PLAYER' ? 'player' : settlementPopup.winner === 'BANKER' ? 'banker' : 'tie'">
            {{ WINNER_LABELS[settlementPopup.winner] }}
          </p>
          <div class="settlement-score">
            <span class="ss player">閒 <strong>{{ settlementPopup.playerTotal }}</strong></span>
            <span class="ss-vs">比</span>
            <span class="ss banker">莊 <strong>{{ settlementPopup.bankerTotal }}</strong></span>
          </div>
          <div v-if="settlementPopup.playerPair || settlementPopup.bankerPair" class="settlement-tags">
            <span v-if="settlementPopup.playerPair" class="settlement-tag player">閒對</span>
            <span v-if="settlementPopup.bankerPair" class="settlement-tag banker">莊對</span>
          </div>
          <div
            class="settlement-outcome"
            :class="!settlementPopup.participated ? 'none' : settlementPopup.amount > 0 ? 'win' : settlementPopup.amount < 0 ? 'lose' : 'push'"
          >
            <template v-if="!settlementPopup.participated">
              <strong>本局未下注</strong>
              <span>沒中也有福氣點 (ツ)つ</span>
            </template>
            <template v-else-if="settlementPopup.amount > 0">
              <strong>您贏了</strong>
              <span class="amt">+{{ settlementPopup.amount.toLocaleString() }}</span>
            </template>
            <template v-else-if="settlementPopup.amount < 0">
              <strong>您輸了</strong>
              <span class="amt">{{ settlementPopup.amount.toLocaleString() }}</span>
            </template>
            <template v-else>
              <strong>平手退回</strong>
              <span class="amt">0</span>
            </template>
          </div>
        </section>
      </div>
    </transition>

    <transition name="game-message-pop">
      <div v-if="gameStore.message" class="game-message-toast" role="status" aria-live="polite" aria-atomic="true">
        {{ gameStore.message }}
      </div>
    </transition>

    <div class="score-row" aria-label="本局點數" aria-live="polite" aria-atomic="true">
      <span class="score-side player">閒</span>
      <div v-if="showDealOverlay" class="score-flaps">
        <div class="score-flap"><strong>{{ playerScoreDisplay }}</strong></div>
        <div class="score-flap"><strong>{{ bankerScoreDisplay }}</strong></div>
      </div>
      <span v-else class="score-gap" aria-hidden="true" />
      <span class="score-side banker">莊</span>
    </div>

    <div class="table-stage">
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ bettingStatusAnnouncement }}
      </p>
      <template v-if="showDealOverlay">
        <div class="felt-cards">
          <div class="felt-hand player-hand" :class="{ 'has-bonus': feltPlayerCards.length >= 3 }">
            <div
              v-for="(card, index) in feltPlayerCards"
              :key="`felt-player-${index}-${card.rank}-${card.suit}`"
              class="playing-card"
              :class="[isFeltCardFaceUp('player', index) ? cardColor(card.suit) : 'masked', { 'card-bonus': index === 2 }]"
            >
              <template v-if="isFeltCardFaceUp('player', index)">
                <span>{{ card.rank }}</span>
                <small>{{ cardSuitSymbol(card.suit) }}</small>
              </template>
            </div>
          </div>
          <div class="felt-hand banker-hand" :class="{ 'has-bonus': feltBankerCards.length >= 3 }">
            <div
              v-for="(card, index) in feltBankerCards"
              :key="`felt-banker-${index}-${card.rank}-${card.suit}`"
              class="playing-card"
              :class="[isFeltCardFaceUp('banker', index) ? cardColor(card.suit) : 'masked', { 'card-bonus': index === 2 }]"
            >
              <template v-if="isFeltCardFaceUp('banker', index)">
                <span>{{ card.rank }}</span>
                <small>{{ cardSuitSymbol(card.suit) }}</small>
              </template>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="bet-timer">
        <div
          class="alarm-clock"
          :class="{ warning: isBettingOpen && countdownSeconds <= 5, idle: !isBettingOpen }"
          aria-hidden="true"
        >
          <svg viewBox="0 0 120 128" class="alarm-clock-art">
            <g class="alarm-metal">
              <rect x="56" y="4" width="8" height="12" rx="4" />
              <ellipse cx="28" cy="26" rx="18" ry="15" transform="rotate(-34 28 26)" />
              <ellipse cx="92" cy="26" rx="18" ry="15" transform="rotate(34 92 26)" />
              <rect x="22" y="102" width="11" height="18" rx="5" transform="rotate(26 27 111)" />
              <rect x="87" y="102" width="11" height="18" rx="5" transform="rotate(-26 93 111)" />
            </g>
            <circle class="alarm-ring" cx="60" cy="66" r="48" />
            <circle class="alarm-face" cx="60" cy="66" r="39" />
          </svg>
          <span class="alarm-count">{{ countdownDisplay || "0" }}</span>
        </div>
        <p class="bet-timer-label">{{ isBettingOpen ? "請投注" : "等待開始" }}</p>
      </div>
    </div>

    <div class="bet-zone" :class="{ closed: !isBettingOpen }">
      <div class="bet-row side-row">
        <button
          v-for="option in sideBetRow"
          :key="option.key"
          type="button"
          class="bet-cell"
          :class="option.accent"
          :disabled="!isBettingOpen || isPlacingBet"
          :aria-label="betAreaAriaLabel(option)"
          @click="stageBet(option.key)"
        >
          <h3>{{ option.label }}</h3>
          <p>{{ option.payout }}</p>
          <span
            class="bet-cell-amount"
            :class="{ empty: !currentBetAmount(option.key), staged: stagedBetAmounts[option.key] > 0 }"
          >
            {{ currentBetAmount(option.key) ? formatBetDisplayAmount(currentBetAmount(option.key)) : "" }}
          </span>
        </button>
      </div>
      <div class="bet-row main-row">
        <button
          v-for="option in mainBetRow"
          :key="option.key"
          type="button"
          class="bet-cell"
          :class="option.accent"
          :disabled="!isBettingOpen || isPlacingBet"
          :aria-label="betAreaAriaLabel(option)"
          @click="stageBet(option.key)"
        >
          <h3>{{ option.label }}</h3>
          <p>{{ option.payout }}</p>
          <span
            class="bet-cell-amount"
            :class="{ empty: !currentBetAmount(option.key), staged: stagedBetAmounts[option.key] > 0 }"
          >
            {{ currentBetAmount(option.key) ? formatBetDisplayAmount(currentBetAmount(option.key)) : "" }}
          </span>
        </button>
      </div>

      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ hasStagedBets ? `已選下注總額 ${totalStagedAmount.toLocaleString()}` : "尚未選擇下注" }}
      </p>

      <transition name="confirm-fab-pop">
        <div v-if="hasStagedBets" class="confirm-actions">
          <button
            type="button"
            class="confirm-fab cancel"
            :disabled="isPlacingBet"
            @click="clearStagedBets"
            aria-label="取消下注"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 7l10 10M17 7L7 17"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="confirm-fab confirm"
            :disabled="!isBettingOpen || isPlacingBet"
            @click="confirmStagedBets"
            aria-label="確認下注"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 12.5l4.5 4.5L19 7"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </transition>
    </div>

    <section class="chip-rack">
      <button
        v-for="chip in availableChips"
        :key="chip"
        type="button"
        class="chip"
        :class="{ active: selectedChip === chip }"
        :disabled="!isBettingOpen"
        :aria-pressed="selectedChip === chip"
        :aria-label="`選擇 ${chip.toLocaleString()} 籌碼`"
        @click="selectedChip = chip"
      >
        {{ chipLabel(chip) }}
      </button>
      <button
        type="button"
        class="rebet-button"
        :disabled="!canRepeatLastBets || isPlacingBet"
        @click="repeatLastBets"
      >
        重複上<br />次投注
      </button>
    </section>

    <footer class="wallet-bar">
      <div class="wallet-panel" aria-label="玩家餘額" aria-live="polite" aria-atomic="true">
        <span class="coin-symbol">$</span>
        <div class="wallet-copy">
          <span>餘額</span>
          <strong>{{ authStore.user?.balance?.toLocaleString() ?? "--" }}</strong>
        </div>
      </div>
      <div class="wallet-panel" :aria-label="dailyProfitAccessibleLabel">
        <div class="wallet-copy">
          <span :title="dailyProfitAccessibleLabel">{{ dailyProfitPeriodLabel }}</span>
          <strong :class="{ gain: todayProfit !== null && todayProfit >= 0, loss: todayProfit !== null && todayProfit < 0 }">
            {{ todayProfit?.toLocaleString() ?? "--" }}
          </strong>
        </div>
      </div>
    </footer>

    <div v-if="isRoadmapOpen" class="modal-backdrop" @click.self="closeRoadmap">
      <section
        ref="roadmapDialogRef"
        class="road-modal panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="road-modal-title"
        tabindex="-1"
        @keydown="onRoadmapDialogKeydown"
      >
        <button
          ref="roadmapCloseButtonRef"
          class="settings-close-button"
          type="button"
          @click="closeRoadmap"
          aria-label="關閉路圖"
        >
          ✕
        </button>

        <div class="settings-modal-head">
          <p class="topbar-label">Roadmap</p>
          <h2 id="road-modal-title">路單</h2>
        </div>

        <div class="road-modal-body">
          <RoadmapPanel :rounds="roadmapRounds" />
        </div>
      </section>
    </div>

    <div v-if="isRoadSettingsOpen" class="modal-backdrop" @click.self="closeRoadSettings">
      <section
        ref="settingsDialogRef"
        class="settings-modal panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="road-settings-title"
        tabindex="-1"
        @keydown="onSettingsDialogKeydown"
      >
        <button
          ref="settingsCloseButtonRef"
          class="settings-close-button"
          type="button"
          @click="closeRoadSettings"
          aria-label="關閉設定"
        >
          ✕
        </button>

        <div class="settings-modal-head">
          <p class="topbar-label">Settings</p>
          <h2 id="road-settings-title">設定</h2>
        </div>

        <div class="settings-section">
          <p class="settings-section-label">語音播報</p>
          <div class="settings-list">
            <button
              type="button"
              class="settings-item"
              :class="{ active: isVoiceAnnouncementEnabled }"
              :aria-pressed="isVoiceAnnouncementEnabled"
              @click="isVoiceAnnouncementEnabled = !isVoiceAnnouncementEnabled"
            >
              <span>點數播報</span>
              <strong>{{ isVoiceAnnouncementEnabled ? "已開啟" : "已關閉" }}</strong>
            </button>
            <button type="button" class="settings-item settings-item-test" @click="testVoiceAnnouncement">
              <span>測試語音</span>
              <strong>點我試聽</strong>
            </button>
          </div>
          <p class="settings-hint">
            若按「測試語音」沒有聲音，請確認手機未開靜音（iPhone 側邊靜音鍵）並將媒體音量調高。
          </p>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped lang="scss">
.game-page {
  display: flex;
  flex-direction: column;
  gap: $space-2;
  overflow: hidden;
  height: 100vh;
  height: 100dvh;
  padding: 8px 16px 10px;
  background: $gradient-felt;
}

.table-nav,
.table-toolbar,
.score-row,
.bet-zone,
.chip-rack,
.wallet-bar {
  flex: 0 0 auto;
}

.table-nav {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 48px;
  align-items: center;
  gap: $space-2;
}

.nav-icon-button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.14);
  color: #fff;
  font-size: 26px;
  line-height: 1;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.table-nav-title {
  text-align: center;
  min-width: 0;
}

.table-nav-title h1 {
  margin: 0;
  color: #fff;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 19px;
  font-weight: 900;
  letter-spacing: 0.06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.table-nav-title p {
  margin: 2px 0 0;
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-text-button {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  padding: $space-2 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.88);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
}

.last-hand-pill {
  padding: $space-2 $space-4;
  border-radius: 999px;
  background:
    linear-gradient(180deg, rgba(117, 18, 18, 0.96), rgba(77, 8, 8, 0.92));
  border: 1px solid rgba(255, 210, 124, 0.45);
  color: #ffe5a8;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.08em;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.22);
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-left: auto;
}

.toolbar-round-button {
  width: 44px;
  height: 44px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: #8c2f23;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.2);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: transform 120ms ease;
}

.toolbar-round-button:active {
  transform: scale(0.94);
}

.road-dots {
  display: grid;
  grid-template-columns: repeat(2, 6px);
  gap: 2px;
}

.road-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
}

.road-dots .dot.player {
  background: $color-player;
}

.road-dots .dot.banker {
  background: $color-banker;
}

.road-dots .dot.tie {
  background: $color-tie;
}

.road-dots .dot.gold {
  background: $color-gold-deep;
}

.toolbar-round-label {
  font-size: 8px;
  font-weight: 900;
  letter-spacing: 0.08em;
  line-height: 1;
}

.sound-button svg {
  width: 20px;
  height: 20px;
  fill: #c0392b;
  color: #c0392b;
}

.sound-button.muted svg {
  fill: rgba(140, 47, 35, 0.5);
  color: rgba(140, 47, 35, 0.5);
}

.score-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: $space-5;
}

.score-flaps {
  display: flex;
  gap: $space-4;
}

.score-gap {
  width: clamp(120px, 40vw, 160px);
}

.score-side {
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 30px;
  font-weight: 900;
  color: rgba(9, 48, 32, 0.5);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.14);
}

.score-flap {
  width: 48px;
  height: 58px;
  border-radius: 10px;
  background: linear-gradient(180deg, #333 0%, #191919 48%, #262626 52%, #101010 100%);
  border: 1px solid rgba(0, 0, 0, 0.55);
  box-shadow:
    0 8px 18px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.score-flap::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  top: 50%;
  height: 1px;
  background: rgba(0, 0, 0, 0.6);
}

.score-flap strong {
  color: #fff;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: 36px;
  font-weight: 800;
  line-height: 1;
}

.table-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $space-3;
  overflow: hidden;
}

.bet-timer {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $space-2;
  height: 100%;
}

.alarm-clock {
  position: relative;
  height: 76%;
  max-height: 124px;
  width: auto;
  aspect-ratio: 120 / 128;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.28));
}

.alarm-clock-art {
  width: 100%;
  height: 100%;
  display: block;
}

.alarm-metal {
  fill: #f0a92f;
}

.alarm-ring {
  fill: #ea9418;
}

.alarm-face {
  fill: #fdf3d6;
}

.alarm-clock.warning {
  animation: alarm-shake 0.5s ease-in-out infinite;
}

.alarm-clock.warning .alarm-metal {
  fill: #e8623f;
}

.alarm-clock.warning .alarm-ring {
  fill: #d8452c;
}

.alarm-clock.idle {
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.24)) saturate(0.7);
  opacity: 0.85;
}

.alarm-count {
  position: absolute;
  top: 51.5%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: 34px;
  font-weight: 900;
  color: #c76a15;
  line-height: 1;
}

.alarm-clock.warning .alarm-count {
  color: #c0341f;
}

.bet-timer-label {
  margin: 0;
  color: #fff;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.16em;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.32);
}

.felt-cards {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: $space-4;
  padding: $space-2 $space-1;
}

.felt-hand {
  position: relative;
  display: flex;
  gap: 6px;
}

.felt-hand.has-bonus {
  min-height: 108px;
}

.banker-hand {
  justify-content: flex-end;
}

.playing-card.card-bonus {
  position: absolute;
  left: 28px;
  top: 48px;
  margin: 0;
  transform: rotate(90deg);
  animation: deal-in-bonus 240ms ease-out;
  z-index: 1;
}

.stage-status {
  margin: 0;
  min-height: 38px;
  min-width: 60%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 $space-5;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.2);
  color: #fff;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.1em;
}

.stage-status.player-win {
  background: rgba(35, 92, 176, 0.6);
}

.stage-status.banker-win {
  background: rgba(176, 44, 38, 0.6);
}

.stage-status.tie-win {
  background: rgba(30, 120, 66, 0.66);
}

@keyframes alarm-shake {
  0%,
  100% {
    transform: rotate(-4deg);
  }
  50% {
    transform: rotate(4deg);
  }
}

.table-loading-overlay {
  @include loading-overlay();
}

.table-loading-panel {
  width: 100%;
  max-width: 280px;
  padding: $space-6 $space-5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
  text-align: center;
}

.table-loading-spinner {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 3px solid rgba(244, 222, 155, 0.2);
  border-top-color: $color-gold;
  border-right-color: rgba(244, 222, 155, 0.64);
  animation: table-loading-spin 0.82s linear infinite;
  box-shadow: 0 0 18px rgba(244, 222, 155, 0.12);
}

.table-loading-panel strong {
  color: $color-text-primary;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.table-loading-panel span {
  color: $color-text-muted;
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

.wallet-bar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: $space-3;
  padding-top: $space-1;
}

.wallet-panel {
  min-height: 56px;
  padding: $space-2 $space-4;
  border-radius: 14px;
  display: flex;
  align-items: center;
  gap: $space-3;
  background: $gradient-accent;
  border: 1px solid $color-accent-border;
  box-shadow:
    0 10px 20px rgba(0, 0, 0, 0.22),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

.wallet-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wallet-copy span {
  color: rgba(255, 249, 235, 0.86);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wallet-copy strong {
  color: #fff;
  font-size: 19px;
  font-weight: 900;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wallet-copy strong.gain {
  color: #eafff1;
}

.wallet-copy strong.loss {
  color: #ffd9d4;
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

.last-hand-fade-enter-active,
.last-hand-fade-leave-active {
  transition:
    opacity 220ms ease,
    transform 220ms ease;
}

.last-hand-fade-enter-from,
.last-hand-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.road-modal {
  position: relative;
  width: min(100%, 420px);
  padding: $space-6 $space-4 $space-4;
  display: flex;
  flex-direction: column;
  gap: $space-4;
}

.road-modal-body {
  height: min(46vh, 380px);
  min-height: 0;
}

.playing-card {
  width: 50px;
  height: 70px;
  border-radius: 10px;
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
  font-size: 22px;
  font-weight: 800;
}

.playing-card small {
  font-size: 15px;
  margin-top: 3px;
}

.bet-zone {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

.bet-zone.closed .bet-cell {
  filter: saturate(0.72) brightness(0.9);
}

.bet-row {
  display: grid;
  gap: $space-2;
}

.side-row {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.main-row {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.main-row .bet-cell {
  min-height: 90px;
}

.bet-cell {
  width: 100%;
  min-height: 78px;
  padding: $space-2;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.14);
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  color: inherit;
  font: inherit;
  text-align: center;
  transition: transform 120ms ease, filter 120ms ease, background 120ms ease;
}

.bet-cell * {
  pointer-events: none;
}

.bet-cell:active {
  transform: scale(0.985);
  filter: brightness(1.1);
}

.bet-cell h3 {
  margin: 0;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 21px;
  font-weight: 900;
  line-height: 1.05;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

.main-row .bet-cell h3 {
  font-size: 27px;
}

.bet-cell p {
  margin: 0;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.66);
}

.bet-cell.player h3 {
  color: #cfe4ff;
}

.bet-cell.banker h3 {
  color: #ffd2cd;
}

.bet-cell-amount {
  min-height: 17px;
  margin-top: 1px;
  padding: 0 $space-2;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: 13px;
  font-weight: 800;
  color: #ffe9ad;
  background: rgba(0, 0, 0, 0.28);
}

.bet-cell-amount.empty {
  background: transparent;
}

.bet-cell-amount.staged {
  color: #23150a;
  background: linear-gradient(180deg, #ffe9ad, #f3ca6c);
  box-shadow:
    0 0 0 1px rgba(255, 233, 173, 0.55),
    0 4px 10px rgba(0, 0, 0, 0.24);
  animation: staged-pulse 1.15s ease-in-out infinite;
}

@keyframes staged-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.07);
  }
}

.confirm-actions {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  gap: $space-4;
}

.confirm-fab {
  width: 54px;
  height: 54px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid rgba(255, 255, 255, 0.85);
  border-radius: 999px;
  color: #fff;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: transform 120ms ease, filter 120ms ease;
}

.confirm-fab.confirm {
  background: linear-gradient(180deg, #34b46a, #1f8a4c);
  box-shadow:
    0 8px 18px rgba(0, 0, 0, 0.32),
    0 0 0 4px rgba(47, 125, 79, 0.28);
  animation: confirm-fab-pulse 1.3s ease-in-out infinite;
}

.confirm-fab.cancel {
  background: linear-gradient(180deg, #e2685f, #c0392b);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.32);
}

.confirm-fab svg {
  width: 28px;
  height: 28px;
  display: block;
}

.confirm-fab:disabled {
  opacity: 0.5;
  animation: none;
}

.confirm-fab:active:not(:disabled) {
  transform: scale(0.94);
  filter: brightness(1.06);
}

@keyframes confirm-fab-pulse {
  0%,
  100% {
    box-shadow:
      0 8px 18px rgba(0, 0, 0, 0.32),
      0 0 0 4px rgba(47, 125, 79, 0.28);
  }
  50% {
    box-shadow:
      0 8px 18px rgba(0, 0, 0, 0.32),
      0 0 0 9px rgba(47, 125, 79, 0.12);
  }
}

.confirm-fab-pop-enter-active {
  transition:
    transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 160ms ease;
}

.confirm-fab-pop-leave-active {
  transition:
    transform 140ms ease,
    opacity 140ms ease;
}

.confirm-fab-pop-enter-from,
.confirm-fab-pop-leave-to {
  opacity: 0;
  transform: translateX(-50%) scale(0.4);
}

.chip-rack {
  display: flex;
  align-items: center;
  gap: $space-2;
  flex-wrap: nowrap;
}

.chip {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 3px dashed rgba(120, 128, 138, 0.65);
  background:
    radial-gradient(circle at 32% 28%, #ffffff, #e7eaef 46%, #b9c0c9 100%);
  color: #3d434b;
  font-size: 14px;
  font-weight: 900;
  box-shadow:
    0 6px 12px rgba(0, 0, 0, 0.24),
    inset 0 0 0 6px rgba(255, 255, 255, 0.75);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
}

.chip.active {
  transform: translateY(-4px);
  border-color: $color-gold-deep;
  color: #7a5410;
  box-shadow:
    0 10px 20px rgba(0, 0, 0, 0.28),
    0 0 0 3px rgba(244, 222, 155, 0.5),
    inset 0 0 0 6px rgba(255, 255, 255, 0.8);
}

.chip:disabled {
  opacity: 0.55;
}

.chip:active:not(:disabled) {
  transform: scale(0.96);
  filter: brightness(1.05);
}

.rebet-button {
  flex: 0 0 auto;
  margin-left: auto;
  min-width: 68px;
  min-height: 56px;
  padding: $space-2 $space-3;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 14px;
  background: linear-gradient(180deg, #fdf8ee, #e9ddc4);
  color: #5b4420;
  font-size: 14px;
  font-weight: 900;
  line-height: 1.3;
  letter-spacing: 0.04em;
  box-shadow:
    0 8px 16px rgba(0, 0, 0, 0.22),
    inset 0 1px 0 rgba(255, 255, 255, 0.8);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: transform 120ms ease, filter 120ms ease;
}

.rebet-button:disabled {
  opacity: 0.55;
}

.rebet-button:active:not(:disabled) {
  transform: scale(0.97);
  filter: brightness(1.04);
}

.settlement-screen {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $space-6;
  background: rgba(3, 9, 7, 0.34);
  pointer-events: auto;
}

.settlement-card {
  position: relative;
  width: min(100%, 300px);
  padding: $space-6 $space-5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-3;
  text-align: center;
}

.settlement-close-button {
  position: absolute;
  top: $space-3;
  right: $space-3;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 999px;
  background: rgba(8, 18, 14, 0.12);
  color: $color-text-primary;
  font-size: 18px;
  font-weight: 900;
}

.settlement-eyebrow {
  margin: 0;
  color: $color-text-subtle;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.18em;
}

.settlement-result {
  margin: 0;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 40px;
  font-weight: 900;
  letter-spacing: 0.08em;
}

.settlement-result.player {
  color: #6aa9ff;
}

.settlement-result.banker {
  color: #ff6a62;
}

.settlement-result.tie {
  color: #53db84;
}

.settlement-score {
  display: flex;
  align-items: center;
  gap: $space-3;
  font-size: 16px;
  font-weight: 800;
  color: $color-text-muted;
}

.settlement-score strong {
  color: $color-text-primary;
  font-size: 20px;
}

.settlement-score .ss.player strong {
  color: #6aa9ff;
}

.settlement-score .ss.banker strong {
  color: #ff6a62;
}

.settlement-score .ss-vs {
  color: $color-text-faint;
  font-size: 12px;
}

.settlement-tags {
  display: flex;
  gap: $space-2;
}

.settlement-tag {
  padding: $space-1 $space-3;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
}

.settlement-tag.player {
  background: rgba(90, 155, 255, 0.2);
  color: #a7cbff;
}

.settlement-tag.banker {
  background: rgba(255, 95, 87, 0.2);
  color: #ffb0ab;
}

.settlement-outcome {
  margin-top: $space-2;
  width: 100%;
  padding: $space-3 $space-4;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-1;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.settlement-outcome strong {
  font-size: 15px;
  color: $color-text-primary;
}

.settlement-outcome span {
  font-size: 13px;
  color: $color-text-subtle;
}

.settlement-outcome .amt {
  font-size: 30px;
  font-weight: 900;
}

.settlement-outcome.win {
  border-color: rgba(114, 242, 165, 0.3);
  background: rgba(114, 242, 165, 0.08);
}

.settlement-outcome.win .amt {
  color: #72f2a5;
}

.settlement-outcome.lose {
  border-color: rgba(255, 127, 127, 0.3);
  background: rgba(255, 127, 127, 0.08);
}

.settlement-outcome.lose .amt {
  color: #ff7f7f;
}

.settlement-outcome.push .amt {
  color: $color-text-muted;
}

.settlement-pop-enter-active,
.settlement-pop-leave-active {
  transition: opacity 240ms ease;
}

.settlement-pop-enter-active .settlement-card,
.settlement-pop-leave-active .settlement-card {
  transition: transform 240ms ease;
}

.settlement-pop-enter-from,
.settlement-pop-leave-to {
  opacity: 0;
}

.settlement-pop-enter-from .settlement-card,
.settlement-pop-leave-to .settlement-card {
  transform: scale(0.9) translateY(10px);
}

.game-message-toast {
  position: fixed;
  top: 92px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 85;
  max-width: min(80vw, 320px);
  padding: $space-3 $space-4;
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
  padding: $space-5;
  background: rgba(3, 9, 7, 0.66);
  backdrop-filter: blur(6px);
}

.settings-modal {
  position: relative;
  width: min(100%, 360px);
  padding: $space-6 $space-5 $space-5;
}

.settings-modal-head h2 {
  margin: 4px 0 0;
}

.settings-close-button {
  position: absolute;
  top: $space-4;
  right: $space-4;
  width: 44px;
  height: 44px;
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
  gap: $space-3;
}

.settings-section {
  margin-top: $space-5;
}

.settings-section:first-of-type {
  margin-top: $space-5;
}

.settings-section-label {
  margin: 0 0 $space-3;
  color: rgba(247, 244, 233, 0.62);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.settings-item {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.05);
  padding: $space-4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
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

.settings-item-test strong {
  color: #f4de9b;
}

.settings-hint {
  margin: $space-3 0 0;
  color: rgba(247, 244, 233, 0.5);
  font-size: 11px;
  line-height: 1.5;
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

@keyframes deal-in-bonus {
  from {
    transform: translateY(-24px) rotate(90deg) scale(0.9);
    opacity: 0;
  }
  to {
    transform: translateY(0) rotate(90deg) scale(1);
    opacity: 1;
  }
}

</style>
