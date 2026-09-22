<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import axios from "axios";
import type { BlackjackAction, BlackjackRound } from "@baccarat/contracts";
import AppButton from "../components/ui/AppButton.vue";
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import BalanceBar from "../components/ui/BalanceBar.vue";
import StakeControl from "../components/ui/StakeControl.vue";
import { useAuthStore } from "../stores/auth";
import { useBlackjackStore } from "../stores/blackjack";
import { useLiveChannel } from "../composables/useLiveChannel";
import { formatMoney } from "../lib/money";
import { getRollingMoneyValue } from "../composables/useSettledDailyProfit";

const router = useRouter();
const auth = useAuthStore();
const game = useBlackjackStore();
const amount = ref(100);
const loading = ref(true);
const syncing = ref(false);
const error = ref("");
const rulesDialog = ref<HTMLDialogElement | null>(null);
const animatedCards = ref(new Set<string>());
const finishingHandId = ref<string | null>(null);
const celebratingHandId = ref<string | null>(null);
const browsedHandId = ref<string | null>(null);
const handViewport = ref<HTMLElement | null>(null);
const draggingHands = ref(false);
let handDrag: { x: number; left: number; index: number; pointerId: number } | null = null;
const animationTimers = new Set<ReturnType<typeof setTimeout>>();
const dealingRound = ref<BlackjackRound | null>(null);
const visibleDealerCards = ref(0);
const flippingHoleCard = ref(false);
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const animationStep = 480;
const celebrationStep = 2000;
const displayedBalance = ref<number | null>(auth.user?.balance ?? null);
const walletRolling = ref(false);
let walletFrame = 0;
const round = computed(() => dealingRound.value ?? game.round);
const displayedDealerCards = computed(() => {
  const current = round.value;
  if (!current) return [];
  if (dealingRound.value)
    return current.dealerCards.slice(0, Math.max(2, visibleDealerCards.value));
  return current.dealerHidden ? [...current.dealerCards, null] : current.dealerCards;
});
function pointTotals(cards: readonly number[] = []) {
  if (!cards.length) return [];
  let minimum = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = Math.floor((card % 52) / 4) + 1;
    minimum += Math.min(rank, 10);
    if (rank === 1) aces++;
  }
  return Array.from({ length: aces + 1 }, (_, index) => minimum + index * 10).filter(
    (points, index) => index === 0 || points <= 21,
  );
}
function pointOptions(cards: readonly number[]) {
  const options = pointTotals(cards);
  return options.includes(21) ? "21" : options.join("/") || "—";
}
const dealerPoints = computed(() => {
  const cards = round.value?.dealerCards.slice(
    0,
    dealingRound.value ? visibleDealerCards.value : undefined,
  );
  return pointTotals(cards).at(-1) ?? "—";
});
let disposed = false;
let restoring: Promise<void> | null = null;
let restoringUser = "";
let operation: Promise<unknown> | null = null;

const userId = computed(() => auth.user?.id ?? "");
const active = computed(() => round.value?.status === "ACTIVE");
const settled = computed(() => round.value?.status === "SETTLED");
const busy = computed(
  () =>
    loading.value ||
    syncing.value ||
    game.busy ||
    Boolean(game.pending) ||
    animatedCards.value.size > 0 ||
    Boolean(finishingHandId.value) ||
    Boolean(dealingRound.value) ||
    !live.connected.value,
);
const currentHand = computed(
  () => game.round?.hands.find((hand) => hand.id === game.round?.activeHandId) ?? null,
);
const displayedHands = computed(() => {
  const current = round.value;
  if (!current) return [];
  const hand =
    current.hands.find(
      (candidate) =>
        candidate.id === (browsedHandId.value ?? finishingHandId.value ?? current.activeHandId),
    ) ?? (current.status === "SETTLED" ? current.hands.at(-1) : current.hands[0]);
  return hand ? [hand] : [];
});
const viewedHandIndex = computed(() => round.value?.hands.indexOf(displayedHands.value[0]!) ?? -1);
const reviewingOtherHand = computed(
  () =>
    active.value &&
    Boolean(round.value?.activeHandId) &&
    displayedHands.value[0]?.id !== round.value?.activeHandId,
);
const allowed = computed(
  () => new Set(reviewingOtherHand.value ? [] : (round.value?.allowedActions ?? [])),
);
function scrollToHand(index: number, instant = false) {
  const viewport = handViewport.value;
  const hand = round.value?.hands[index];
  if (!viewport || !hand) return;
  browsedHandId.value = hand.id;
  viewport.scrollTo({
    left: index * viewport.clientWidth,
    behavior: instant || motionPreference.matches ? "instant" : "smooth",
  });
}
function updateViewedHand() {
  const viewport = handViewport.value;
  if (!viewport?.clientWidth) return;
  const index = Math.round(viewport.scrollLeft / viewport.clientWidth);
  const hand = round.value?.hands[index];
  if (hand) browsedHandId.value = hand.id;
}
watch(
  [
    userId,
    () => round.value?.id,
    () => round.value?.activeHandId,
    finishingHandId,
    () => round.value?.hands.length,
  ],
  async (_next, _previous, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    browsedHandId.value = null;
    handDrag = null;
    draggingHands.value = false;
    const index = viewedHandIndex.value;
    const instant = loading.value || syncing.value;
    await nextTick();
    if (!cancelled) scrollToHand(index, instant);
  },
);
watch(
  handViewport,
  (viewport, _previous, onCleanup) => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => scrollToHand(viewedHandIndex.value, true));
    observer.observe(viewport);
    onCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);
function browseHand(direction: number) {
  if (busy.value) return;
  scrollToHand(viewedHandIndex.value + direction);
}
function startHandDrag(event: PointerEvent) {
  // Touch and trackpad gestures use native overflow scrolling and scroll snapping.
  if (
    event.pointerType === "touch" ||
    event.button !== 0 ||
    busy.value ||
    (round.value?.hands.length ?? 0) < 2
  )
    return;
  const viewport = handViewport.value;
  const cards = (event.target as HTMLElement).closest(".cards");
  if (!viewport || (cards && cards.scrollWidth > cards.clientWidth + 1)) return;
  handDrag = {
    x: event.clientX,
    left: viewport.scrollLeft,
    index: viewedHandIndex.value,
    pointerId: event.pointerId,
  };
  draggingHands.value = true;
  viewport.setPointerCapture(event.pointerId);
}
function moveHandDrag(event: PointerEvent) {
  if (!handDrag || handDrag.pointerId !== event.pointerId || !handViewport.value) return;
  handViewport.value.scrollLeft = handDrag.left + handDrag.x - event.clientX;
}
async function endHandDrag(event: PointerEvent) {
  const drag = handDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  handDrag = null;
  draggingHands.value = false;
  const distance = drag.x - event.clientX;
  const count = round.value?.hands.length ?? 1;
  const target = Math.max(
    0,
    Math.min(count - 1, drag.index + (Math.abs(distance) >= 40 ? Math.sign(distance) : 0)),
  );
  const id = round.value?.id;
  await nextTick();
  if (id === round.value?.id) scrollToHand(target);
}
function cancelHandDrag() {
  if (!handDrag) return;
  const index = handDrag.index;
  handDrag = null;
  draggingHands.value = false;
  scrollToHand(index, true);
}
const stake = computed({
  get: () => amount.value,
  set: (value: number) => (amount.value = value),
});

const suitNames = ["黑桃", "紅心", "方塊", "梅花"];
const suits = ["♠", "♥", "♦", "♣"];
const rankName = (card: number) =>
  ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][Math.floor((card % 52) / 4)];
const red = (card: number) => card % 4 === 1 || card % 4 === 2;
const cardLabel = (card: number) => `${suitNames[card % 4]} ${rankName(card)}`;
function explain(cause: unknown) {
  return axios.isAxiosError(cause)
    ? (cause.response?.data?.message ?? cause.message)
    : cause instanceof Error
      ? cause.message
      : "操作失敗，請重試。";
}
function clearAnimation() {
  animationTimers.forEach(clearTimeout);
  animationTimers.clear();
  animatedCards.value = new Set();
  finishingHandId.value = null;
  celebratingHandId.value = null;
  dealingRound.value = null;
  flippingHoleCard.value = false;
  visibleDealerCards.value = 0;
}
function later(callback: () => void, delay: number) {
  const timer = setTimeout(() => {
    animationTimers.delete(timer);
    callback();
  }, delay);
  animationTimers.add(timer);
}
function motionChanged() {
  if (motionPreference.matches) {
    clearAnimation();
    clearWalletAnimation();
    displayedBalance.value = auth.user?.balance ?? null;
  }
}
motionPreference.addEventListener("change", motionChanged);
watch(
  () => game.round,
  (round, previous) => {
    if (
      !round ||
      (previous?.id === round.id && round.version <= previous.version) ||
      loading.value ||
      syncing.value
    )
      return;
    clearAnimation();
    if (motionPreference.matches) return;
    const changed = new Set<string>();
    if (!previous || previous.id !== round.id) {
      round.dealerCards.forEach((_card, index) => changed.add(`dealer-${index}`));
      round.hands.forEach((hand) =>
        hand.cards.forEach((_card, index) => changed.add(`${hand.id}-${index}`)),
      );
    } else {
      round.dealerCards.forEach((_card, index) => {
        if (previous.dealerCards[index] !== round.dealerCards[index])
          changed.add(`dealer-${index}`);
      });
      round.hands.forEach((hand) => {
        const old = previous.hands.find((candidate) => candidate.id === hand.id);
        hand.cards.forEach((_card, index) => {
          if (old?.cards[index] !== hand.cards[index]) changed.add(`${hand.id}-${index}`);
        });
      });
    }
    // The server skips completed hands. Present their 21s only once play reaches
    // them, rather than jumping ahead of an earlier hand that is still playable.
    const previousActiveIndex =
      previous?.hands.findIndex((hand) => hand.id === previous.activeHandId) ?? -1;
    const nextActiveIndex = round.hands.findIndex((hand) => hand.id === round.activeHandId);
    const presentationLimit = nextActiveIndex < 0 ? round.hands.length : nextActiveIndex;
    const twentyOneHands = round.hands.filter((hand, index) => {
      const old =
        previous?.id === round.id
          ? previous.hands.find((candidate) => candidate.id === hand.id)
          : undefined;
      return (
        index < presentationLimit &&
        hand.cards.length === 2 &&
        hand.total === 21 &&
        (!(old?.cards.length === 2 && old.total === 21) ||
          (previousActiveIndex >= 0 && old && previous!.hands.indexOf(old) > previousActiveIndex))
      );
    });
    if (!changed.size && !twentyOneHands.length) return;
    // Show the completed hand's final draw before advancing to the next hand.
    const previousHand = previous?.hands.find((hand) => hand.id === previous.activeHandId);
    const completedHand = round.hands.find((hand) => hand.id === previousHand?.id);
    if (
      previous?.id === round.id &&
      previousHand &&
      completedHand &&
      previous.activeHandId !== round.activeHandId &&
      (round.activeHandId || twentyOneHands.length) &&
      completedHand.cards.length > previousHand.cards.length
    )
      finishingHandId.value = previousHand.id;
    if (twentyOneHands.length) {
      finishingHandId.value ??= twentyOneHands[0]!.id;
      twentyOneHands.forEach((hand, index) => {
        const start = animationStep + index * celebrationStep;
        later(() => {
          animatedCards.value = new Set();
          celebratingHandId.value = null;
          finishingHandId.value = hand.id;
        }, start);
        later(() => {
          celebratingHandId.value = hand.id;
        }, start + 200);
      });
    }
    const playerDuration = animationStep + twentyOneHands.length * celebrationStep;
    animatedCards.value = changed;
    if (previous?.id === round.id && previous.dealerHidden && !round.dealerHidden) {
      // Keep controls and outcomes stable while presenting the already committed result.
      dealingRound.value = {
        ...previous,
        dealerCards: round.dealerCards,
        hands: round.hands.map((hand) => ({ ...hand, outcome: "PENDING", payout: 0 })),
      };
      visibleDealerCards.value = 1;
      animatedCards.value = new Set([...changed].filter((key) => !key.startsWith("dealer-")));
      const playerDelay = animatedCards.value.size || twentyOneHands.length ? playerDuration : 0;
      const revealHole = () => {
        finishingHandId.value = null;
        celebratingHandId.value = null;
        visibleDealerCards.value = 2;
        flippingHoleCard.value = true;
      };
      if (playerDelay) later(revealHole, playerDelay);
      else revealHole();
      round.dealerCards.slice(2).forEach((_card, offset) => {
        later(
          () => {
            visibleDealerCards.value = offset + 3;
            animatedCards.value = new Set([`dealer-${offset + 2}`]);
          },
          playerDelay + animationStep * (offset + 1),
        );
      });
      later(clearAnimation, playerDelay + animationStep * (round.dealerCards.length - 1));
    } else {
      later(clearAnimation, playerDuration);
    }
  },
);
function clearWalletAnimation() {
  cancelAnimationFrame(walletFrame);
  walletFrame = 0;
  walletRolling.value = false;
}
watch(
  [
    userId,
    () => auth.user?.balance ?? null,
    loading,
    syncing,
    () =>
      game.busy ||
      Boolean(game.pending) ||
      animatedCards.value.size > 0 ||
      Boolean(finishingHandId.value) ||
      Boolean(dealingRound.value),
  ],
  ([actor, balance, isLoading, isSyncing, presenting], previous) => {
    clearWalletAnimation();
    // Restore/account changes establish a baseline; debits always apply immediately.
    if (
      actor !== previous?.[0] ||
      balance === null ||
      displayedBalance.value === null ||
      isLoading ||
      isSyncing ||
      motionPreference.matches ||
      (previous?.[1] != null && balance < previous[1]) ||
      balance <= displayedBalance.value
    ) {
      displayedBalance.value = balance;
      return;
    }
    // The wallet is authoritative already; only its presentation waits for the cards.
    if (presenting) return;
    const from = Math.round(displayedBalance.value * 100);
    const to = Math.round(balance * 100);
    const startedAt = performance.now();
    walletRolling.value = true;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 800);
      displayedBalance.value = getRollingMoneyValue(from, to, progress) / 100;
      if (progress < 1) walletFrame = requestAnimationFrame(tick);
      else {
        displayedBalance.value = balance;
        clearWalletAnimation();
      }
    };
    walletFrame = requestAnimationFrame(tick);
  },
  { immediate: true },
);
async function act(action: BlackjackAction) {
  if (busy.value) return;
  error.value = "";
  const actor = userId.value,
    generation = game.generation;
  const task = game.mutate(action);
  operation = task;
  try {
    await task;
  } catch (cause) {
    if (!disposed && actor === userId.value && generation === game.generation)
      error.value = explain(cause);
  } finally {
    if (operation === task) operation = null;
  }
}
function roundAction(kind: "hit" | "stand" | "double" | "split") {
  const round = game.round;
  const hand = currentHand.value;
  if (!round || !hand || reviewingOtherHand.value) return;
  return act({ kind, roundId: round.id, expectedVersion: round.version, handId: hand.id });
}
function start() {
  return act({ kind: "start", amount: amount.value });
}
function insurance(accept: boolean) {
  const round = game.round;
  if (!round) return;
  return act({ kind: "insurance", roundId: round.id, expectedVersion: round.version, accept });
}
function showRules() {
  rulesDialog.value?.showModal();
}
async function restore(): Promise<void> {
  if (restoring) {
    if (restoringUser === userId.value) return restoring;
    await restoring;
    return restore();
  }
  const id = userId.value;
  restoringUser = id;
  syncing.value = true;
  clearAnimation();
  restoring = (async () => {
    if (operation) await operation.catch(() => {});
    if (disposed || !id || id !== userId.value) return;
    game.setUser(id);
    await game.fetchConfig();
    if (disposed || id !== userId.value) return;
    await game.reconcile();
    if (id !== userId.value) return;
    await auth.fetchMe({ preserveNewerLiveSnapshot: true });
    error.value = "";
  })()
    .catch((cause) => {
      if (!disposed && id === userId.value) error.value = explain(cause);
    })
    .finally(() => {
      restoring = null;
      syncing.value = false;
      loading.value = false;
    });
  return restoring;
}
const live = useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_user" }),
  onMessage: () => {},
  onConnected: restore,
  onError: (message) => (error.value = message),
});
game.setUser(userId.value);
game.transport = live.requestBlackjack;
watch(userId, (id) => {
  clearAnimation();
  live.disconnect();
  game.setUser(id);
  error.value = "";
  loading.value = true;
  if (id) live.reconnect();
});
onUnmounted(() => {
  disposed = true;
  clearWalletAnimation();
  motionPreference.removeEventListener("change", motionChanged);
  clearAnimation();
  if (game.transport === live.requestBlackjack) game.transport = null;
});
</script>

<template>
  <main class="player-page blackjack-page">
    <AppPageHeader back-label="返回遊戲選擇" @back="router.push('/lobby')">
      Blackjack
      <template #actions>
        <AppButton class="nav-text-button" variant="ghost" @click="showRules">遊戲規則</AppButton>
      </template>
    </AppPageHeader>

    <section class="blackjack-table" :aria-busy="busy" aria-label="Blackjack 牌桌">
      <section class="dealer-area" aria-label="莊家手牌">
        <TransitionGroup
          name="dealer-spread"
          :move-class="dealingRound ? 'dealer-spread-move' : 'dealer-spread-static'"
          tag="div"
          class="cards dealer-cards"
        >
          <div
            v-for="(card, index) in displayedDealerCards"
            :key="`dealer-${index}`"
            class="dealer-slot"
          >
            <article
              v-if="card !== null"
              class="playing-card"
              :class="{
                red: red(card),
                reveal: animatedCards.has(`dealer-${index}`),
                'hole-covered': dealingRound && index === 1 && visibleDealerCards < 2,
                'hole-flip': flippingHoleCard && index === 1,
              }"
              :aria-label="
                dealingRound && index === 1 && visibleDealerCards < 2 ? '莊家暗牌' : cardLabel(card)
              "
            >
              <div class="card-face">
                <span>{{ rankName(card) }}</span
                ><b>{{ suits[card % 4] }}</b>
              </div>
              <div class="card-back-face" aria-hidden="true"></div>
            </article>
            <article v-else class="playing-card card-back" aria-label="莊家暗牌"></article>
          </div>
        </TransitionGroup>
        <p class="seat-label" aria-label="已開牌點數">
          <strong>{{ dealerPoints }}</strong>
        </p>
      </section>
      <section class="hands-scroll" aria-label="玩家手牌">
        <AppButton
          v-if="(round?.hands.length ?? 0) > 1"
          class="hand-arrow hand-arrow-left"
          variant="ghost"
          icon
          aria-label="上一副牌"
          :disabled="busy || viewedHandIndex <= 0"
          @click="browseHand(-1)"
          ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg
        ></AppButton>
        <div
          ref="handViewport"
          class="hand-viewport"
          :class="{
            'has-split-hands': (round?.hands.length ?? 0) > 1,
            'is-dragging': draggingHands,
          }"
          :tabindex="(round?.hands.length ?? 0) > 1 ? 0 : undefined"
          role="group"
          aria-label="玩家牌組，可左右滑動查看"
          @scroll.passive="updateViewedHand"
          @pointerdown="startHandDrag"
          @pointermove="moveHandDrag"
          @pointerup="endHandDrag"
          @pointercancel="cancelHandDrag"
          @keydown.left.prevent="browseHand(-1)"
          @keydown.right.prevent="browseHand(1)"
        >
          <article
            v-for="(hand, handIndex) in round?.hands ?? []"
            :key="hand.id"
            class="player-hand"
            :aria-hidden="handIndex !== viewedHandIndex"
            :aria-label="`玩家牌組 ${(round?.hands.indexOf(hand) ?? 0) + 1}`"
            :class="{
              active: hand.id === round?.activeHandId,
              'twenty-one': hand.id === celebratingHandId,
            }"
            :aria-current="hand.id === round?.activeHandId ? 'step' : undefined"
          >
            <header>
              <strong>{{ pointOptions(hand.cards) }}</strong>
            </header>
            <div class="cards">
              <article
                v-for="(card, index) in hand.cards"
                :key="`${hand.id}-${index}`"
                class="playing-card"
                :class="{ red: red(card), reveal: animatedCards.has(`${hand.id}-${index}`) }"
                :aria-label="cardLabel(card)"
              >
                <span>{{ rankName(card) }}</span
                ><b>{{ suits[card % 4] }}</b>
              </article>
            </div>
            <div v-if="hand.id === celebratingHandId" class="hand-celebration" aria-hidden="true">
              <i v-for="spark in 4" :key="spark" class="celebration-spark">✦</i>
              <div class="celebration-banner">
                <span class="celebration-caption">{{ hand.split ? "兩張 21 點" : "21 點" }}</span>
                <strong class="celebration-title">{{ hand.split ? "21" : "BLACKJACK" }}</strong>
                <span class="celebration-flourish">◆ ━ ◆ ━ ◆</span>
              </div>
            </div>
          </article>
          <p v-if="!round && !loading" class="empty-hands">選擇投注額後開始一局 Blackjack</p>
        </div>
        <AppButton
          v-if="(round?.hands.length ?? 0) > 1"
          class="hand-arrow hand-arrow-right"
          variant="ghost"
          icon
          aria-label="下一副牌"
          :disabled="busy || viewedHandIndex >= (round?.hands.length ?? 0) - 1"
          @click="browseHand(1)"
          ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg
        ></AppButton>
      </section>
      <p v-if="settled" class="settlement" role="status">
        <span
          v-if="round?.hands.some((hand) => hand.outcome === 'PUSH')"
          class="settlement-outcome"
        >
          <span v-if="displayedHands[0]?.outcome === 'PUSH'" class="push-result">
            {{ (round?.hands.length ?? 0) > 1 ? "本手 " : "" }}PUSH · 和局
          </span>
        </span>
        本局派彩 {{ formatMoney(round?.payout ?? 0) }} · 總投注
        {{ formatMoney(round?.totalBet ?? 0) }}
      </p>
    </section>

    <section class="blackjack-controls" aria-label="Blackjack 操作">
      <template v-if="active && round?.phase === 'INSURANCE'">
        <p class="insurance-copy">
          莊家明牌是 A，是否購買保險？投注
          {{ formatMoney(round.insurance.amount || round.amount / 2) }}
        </p>
        <div class="actions two-actions">
          <AppButton
            :class="{ 'is-waiting': busy }"
            :busy="
              game.pending?.action.kind === 'insurance' && game.pending.action.accept === false
            "
            :disabled="busy"
            @click="insurance(false)"
            >{{
              game.pending?.action.kind === "insurance" && game.pending.action.accept === false
                ? "確認中…"
                : "不購買"
            }}</AppButton
          ><AppButton
            variant="primary"
            :class="{ 'is-waiting': busy }"
            :busy="game.pending?.action.kind === 'insurance' && game.pending.action.accept"
            :disabled="busy"
            @click="insurance(true)"
            >{{
              game.pending?.action.kind === "insurance" && game.pending.action.accept
                ? "確認中…"
                : "購買保險"
            }}</AppButton
          >
        </div>
      </template>
      <template v-else-if="active && round?.phase === 'PLAYER_TURN'">
        <p class="turn-copy">
          <template v-if="finishingHandId">{{ celebratingHandId ? "21 點" : "開牌中…" }}</template>
          <template v-else-if="dealingRound">莊家開牌中…</template>
          <AppButton
            v-else-if="reviewingOtherHand"
            class="return-hand"
            variant="ghost"
            @click="
              scrollToHand(round?.hands.findIndex((hand) => hand.id === round?.activeHandId) ?? 0)
            "
            >返回操作牌組</AppButton
          >
          <template v-else>請選擇操作</template>
        </p>
        <div class="actions action-grid">
          <AppButton
            :class="{ 'is-waiting': busy && allowed.has('hit') }"
            :busy="game.pending?.action.kind === 'hit'"
            :disabled="busy || !allowed.has('hit')"
            @click="roundAction('hit')"
            >{{ game.pending?.action.kind === "hit" ? "要牌中…" : "要牌" }}</AppButton
          >
          <AppButton
            :class="{ 'is-waiting': busy && allowed.has('stand') }"
            :busy="game.pending?.action.kind === 'stand'"
            :disabled="busy || !allowed.has('stand')"
            @click="roundAction('stand')"
            >{{ game.pending?.action.kind === "stand" ? "停牌中…" : "停牌" }}</AppButton
          >
          <AppButton
            :class="{ 'is-waiting': busy && allowed.has('double') }"
            :busy="game.pending?.action.kind === 'double'"
            :disabled="busy || !allowed.has('double')"
            @click="roundAction('double')"
            >{{ game.pending?.action.kind === "double" ? "加倍中…" : "加倍" }}</AppButton
          >
          <AppButton
            :class="{ 'is-waiting': busy && allowed.has('split') }"
            :busy="game.pending?.action.kind === 'split'"
            :disabled="busy || !allowed.has('split')"
            @click="roundAction('split')"
            >{{ game.pending?.action.kind === "split" ? "分牌中…" : "分牌" }}</AppButton
          >
        </div>
      </template>
      <template v-else>
        <AppButton
          class="start-button"
          :class="{ 'is-waiting': busy && game.config?.enabled }"
          variant="primary"
          :busy="game.pending?.action.kind === 'start'"
          :disabled="busy || !game.config?.enabled"
          @click="start"
          >{{ game.pending?.action.kind === "start" ? "發牌中…" : settled ? "下一局" : "開始下注" }}
          {{ formatMoney(amount) }}</AppButton
        >
      </template>
      <StakeControl
        v-model="stake"
        :class="{ 'stake-waiting': busy && !active }"
        :min="game.config?.minBet ?? 100"
        :max="game.config?.maxBet ?? 5000"
        :step="game.config?.betStep ?? 100"
        :disabled="busy || active"
      />
      <p v-if="game.config && !game.config.enabled" role="status">
        暫停接受新投注，已開局仍可繼續完成。
      </p>
      <p v-if="!live.connected.value && !loading" role="status">連線中斷，正在重新連線…</p>
      <p v-if="error" class="blackjack-error" role="alert">{{ error }}</p>
      <AppButton
        v-if="error || (game.pending && !game.busy && !syncing)"
        :disabled="game.busy || syncing || !live.connected.value"
        @click="restore"
        >{{ game.pending ? "確認上一個操作" : "重新同步" }}</AppButton
      >
    </section>
    <BalanceBar :balance="displayedBalance" :rolling="walletRolling" />

    <dialog ref="rulesDialog" class="blackjack-dialog">
      <h2>遊戲規則</h2>
      <p>
        每局以 6 副牌重新洗牌。最接近 21 點而不爆牌即獲勝；莊家不足 17 點補牌，達 17 點即停牌（包含
        A 算作 11 點的情況）。
      </p>
      <p>
        原始兩張 Blackjack 賠 3:2，一般勝局賠 1:1，和局退本金。首兩張可加倍；同點數可分牌，最多 4
        手。
      </p>
      <p>
        A 可分一次，每手只補一張且不可再分或加倍。莊家 A 明牌時可買半注保險，莊家 Blackjack 時賠
        2:1。本遊戲不提供固定 RTP。
      </p>
      <AppButton @click="rulesDialog?.close()">關閉</AppButton>
    </dialog>
  </main>
</template>

<style scoped>
/* mobile-ignore-next */
.blackjack-page {
  min-height: 100vh;
  min-height: 100dvh;
  padding: env(safe-area-inset-top, 0px) 0 max(10px, env(safe-area-inset-bottom, 0px));
  gap: 8px;
  color: #f7f0d8;
  background: radial-gradient(ellipse at 50% 34%, #2b7456, #143b2d 56%, #091b15);
}
.blackjack-page :deep(.page-header) {
  margin-inline: var(--ui-page-gutter);
  --ui-title-color: #fff1bd;
  --ui-header-side: 64px;
}
.nav-text-button {
  justify-self: end;
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.88);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.blackjack-table {
  --playing-card-width: clamp(52px, calc(18vh - 50px), 88px);
  --playing-card-width: clamp(52px, calc(18dvh - 50px), 88px);
  --playing-card-height: calc(var(--playing-card-width) * 1.4);
  --playing-card-padding: calc(var(--playing-card-width) * 0.08);
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  flex: 1;
  min-height: 0;
  margin: 0 var(--ui-page-gutter);
  overflow: hidden;
  border: 2px solid #d5a542;
  border-radius: 24px;
  background: radial-gradient(ellipse at 50% 30%, #2c7656, #123d2d);
  box-shadow: inset 0 0 0 7px #fff2ba16;
}
.dealer-area,
.player-hand {
  padding: 8px 12px;
}
.dealer-area {
  min-width: 0;
}
.seat-label,
.player-hand header {
  display: flex;
  justify-content: center;
  margin: 0 0 6px;
  color: #e9d391;
  font-size: 12px;
}
.seat-label strong,
.player-hand header strong {
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: center;
  color: #fff6d2;
  font-size: 16px;
}
.seat-label {
  margin: 6px 0 0;
}
.cards {
  display: flex;
  justify-content: flex-start;
  min-height: calc(var(--playing-card-height) + 4px);
  padding: 2px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.dealer-cards,
.player-hand .cards {
  justify-content: safe center;
}
.player-hand .cards {
  overscroll-behavior-x: auto;
}
.dealer-slot {
  flex: 0 0 var(--playing-card-width);
  height: var(--playing-card-height);
}
.dealer-slot + .dealer-slot {
  margin-left: calc(var(--playing-card-width) * -0.28);
}
.dealer-spread-move {
  transition: transform 0.28s ease;
}
.dealer-cards .playing-card {
  position: relative;
  transform-style: preserve-3d;
}
.dealer-cards .card-face,
.card-back-face {
  position: absolute;
  inset: 0;
  display: grid;
  padding: var(--playing-card-padding);
  border-radius: inherit;
  background: #fffdf6;
  backface-visibility: hidden;
}
.card-back-face {
  transform: rotateY(180deg);
  background: repeating-linear-gradient(45deg, #7d1e31 0 4px, #f4d586 4px 6px);
}
.hole-covered {
  transform: rotateY(-180deg);
}
.playing-card.hole-flip {
  animation: hole-flip 0.42s ease both;
}
.cards::-webkit-scrollbar {
  display: none;
}
.playing-card {
  display: grid;
  flex: 0 0 var(--playing-card-width);
  width: var(--playing-card-width);
  height: var(--playing-card-height);
  margin-left: calc(var(--playing-card-width) * -0.28);
  padding: var(--playing-card-padding);
  border: 1px solid #d5a542;
  border-radius: 6px;
  background: #fffdf6;
  box-shadow: 0 2px 4px #0005;
  color: #15201b;
  font-family: Georgia, serif;
  line-height: 1;
}
.playing-card:first-child {
  margin-left: 0;
}
.playing-card span {
  font-size: calc(var(--playing-card-width) * 0.28);
  font-weight: 700;
}
.playing-card b {
  place-self: center;
  font-size: calc(var(--playing-card-width) * 0.54);
}
.playing-card.red {
  color: #b42435;
}
.playing-card.card-back {
  background: repeating-linear-gradient(45deg, #7d1e31 0 4px, #f4d586 4px 6px);
}
.playing-card.reveal {
  animation: deal 0.42s ease both;
}
.twenty-one .playing-card {
  animation: twenty-one-bounce 0.65s ease both;
}
.hand-celebration {
  position: absolute;
  z-index: 2;
  bottom: 6px;
  left: 50%;
  width: calc(var(--playing-card-width) * 1.72 + 12px);
  height: calc(var(--playing-card-height) + 8px);
  max-width: calc(100% - 16px);
  transform: translateX(-50%);
  border: 2px solid #ffdf82;
  border-radius: 10px;
  box-shadow:
    0 0 8px #ffd773,
    inset 0 0 8px #ffe9a9;
  pointer-events: none;
  animation: celebration-glow 0.8s ease-in-out 2;
}
.celebration-banner {
  position: absolute;
  top: 50%;
  left: 50%;
  width: max-content;
  min-width: 150px;
  padding: 8px 12px 5px;
  border-block: 1px solid #f6d27f;
  color: #ffe8a2;
  text-align: center;
  background: linear-gradient(90deg, #10291c00, #10291cf5 16%, #10291cf5 84%, #10291c00);
  transform: translate(-50%, -36%);
  animation: celebration-pop 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.celebration-caption,
.celebration-flourish {
  display: block;
  font-size: 10px;
  line-height: 1.2;
  letter-spacing: 0.18em;
}
.celebration-title {
  display: block;
  margin-block: 3px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(22px, 5vw, 30px);
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0.04em;
  color: #ffe2a0;
  background: linear-gradient(
    110deg,
    #bd8627 10%,
    #ffe7a0 32%,
    #fffdf0 50%,
    #e1ad44 68%,
    #ffe7a0 90%
  );
  background-size: 240% 100%;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 2px 1px #0009);
  animation: celebration-shine 0.8s ease-in-out 2;
}
.celebration-spark {
  position: absolute;
  color: #fff4c6;
  font-size: 18px;
  font-style: normal;
  line-height: 1;
  text-shadow: 0 0 6px #ffbe4c;
  animation: celebration-sparkle 0.8s ease-in-out 2;
}
.celebration-spark:nth-child(1) {
  top: -5px;
  left: -5px;
}
.celebration-spark:nth-child(2) {
  top: -5px;
  right: -5px;
  animation-delay: 0.15s;
}
.celebration-spark:nth-child(3) {
  bottom: -5px;
  left: -5px;
  animation-delay: 0.15s;
}
.celebration-spark:nth-child(4) {
  bottom: -5px;
  right: -5px;
}
@keyframes celebration-pop {
  from {
    opacity: 0;
    transform: translate(-50%, -20%) scale(0.65);
  }
  65% {
    opacity: 1;
    transform: translate(-50%, -36%) scale(1.08);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -36%) scale(1);
  }
}
@keyframes celebration-glow {
  0%,
  100% {
    box-shadow:
      0 0 8px #ffd773,
      inset 0 0 8px #ffe9a9;
  }
  50% {
    box-shadow:
      0 0 16px #ffcb57,
      inset 0 0 14px #fff0be;
    border-color: #fff9df;
  }
}
@keyframes celebration-shine {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0% 0;
  }
}
@keyframes celebration-sparkle {
  0%,
  100% {
    opacity: 0.5;
    transform: scale(0.65) rotate(-15deg);
  }
  50% {
    opacity: 1;
    transform: scale(1.15) rotate(15deg);
  }
}
@keyframes twenty-one-bounce {
  0%,
  100% {
    transform: none;
  }
  35% {
    transform: translateY(-2px) scale(0.95);
  }
  65% {
    transform: translateY(1px) scale(0.99);
  }
}
.hands-scroll {
  position: relative;
  display: flex;
  justify-content: safe center;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.hands-scroll::-webkit-scrollbar {
  display: none;
}
.hand-viewport {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}
.hand-viewport::-webkit-scrollbar {
  display: none;
}
.hand-viewport.has-split-hands.is-dragging {
  scroll-snap-type: none;
  cursor: grabbing;
}
.hand-viewport.has-split-hands {
  cursor: grab;
  user-select: none;
}
.hand-viewport.has-split-hands .player-hand {
  padding-inline: 32px;
}
.hand-arrow {
  position: absolute;
  bottom: calc(var(--playing-card-height) / 2 - 2px);
  z-index: 1;
  width: 28px;
  min-width: 28px;
  height: 44px;
  padding: 4px;
  color: #7de4ff;
}
.hand-arrow:disabled {
  visibility: hidden;
}
.hand-arrow-left {
  left: 4px;
  --hint-travel: -3px;
}
.hand-arrow-right {
  right: 4px;
  --hint-travel: 3px;
}
.hand-arrow svg {
  width: 20px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 4px #7de4ff80);
  animation: hand-hint-bounce 1.1s ease-in-out infinite;
}
.blackjack-controls .return-hand {
  min-height: 0;
  height: 100%;
  padding: 0;
  border: 0;
  font: inherit;
}
@keyframes hand-hint-bounce {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(var(--hint-travel));
  }
}
.player-hand {
  position: relative;
  flex: 0 0 100%;
  min-width: 0;
  scroll-snap-align: center;
  scroll-snap-stop: always;
}
.empty-hands {
  margin: auto;
  color: #e7d7a9;
  font-size: 14px;
  text-align: center;
}
.settlement {
  margin: 0;
  padding: 8px;
  text-align: center;
  background: #08191177;
  color: #ffebae;
  font-size: 13px;
}
.settlement-outcome {
  display: block;
  min-height: 1.5em;
  font-weight: 700;
}
.blackjack-controls {
  display: grid;
  gap: 8px;
  padding: 0 var(--ui-page-gutter);
}
.actions {
  display: grid;
  gap: 8px;
}
.two-actions {
  grid-template-columns: 1fr 1fr;
}
.action-grid {
  grid-template-columns: repeat(4, 1fr);
}
.action-grid :deep(button) {
  min-width: 0;
  padding-inline: 4px;
}
.blackjack-controls :deep(.is-waiting:disabled),
.blackjack-controls :deep(.stake-waiting button:disabled),
.blackjack-controls :deep(.stake-waiting select:disabled) {
  opacity: 1;
}
.start-button {
  width: 100%;
}
.turn-copy,
.insurance-copy,
.blackjack-controls > p {
  margin: 0;
  text-align: center;
  font-size: 13px;
}
.turn-copy {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  line-height: 20px;
}
.blackjack-error {
  color: #ffcfcb;
}
.blackjack-controls :deep(.stake-row) {
  justify-content: center;
}
.blackjack-page :deep(.ui-balance) {
  margin-inline: var(--ui-page-gutter);
}
.blackjack-dialog {
  max-width: min(360px, calc(100% - 32px));
  border: 1px solid #d5a542;
  border-radius: 16px;
  background: #123b2d;
  color: #fff3ce;
  padding: 20px;
}
.blackjack-dialog::backdrop {
  background: #0009;
}
.blackjack-dialog h2 {
  margin-top: 0;
}
.blackjack-dialog p {
  line-height: 1.6;
}
@keyframes hole-flip {
  from {
    transform: rotateY(-180deg);
  }
  to {
    transform: rotateY(0);
  }
}
@keyframes deal {
  from {
    opacity: 0;
    transform: translateY(-10px) rotateY(90deg);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hand-arrow svg {
    animation: none;
  }
  .dealer-spread-move {
    transition: none;
  }
  .playing-card.reveal,
  .playing-card.hole-flip,
  .twenty-one .playing-card,
  .hand-celebration,
  .celebration-banner,
  .celebration-title,
  .celebration-spark {
    animation: none;
  }
}
@media (max-height: 650px) {
  .dealer-area,
  .player-hand,
  .hands-scroll {
    padding-block: 4px;
  }
  .seat-label {
    margin-top: 4px;
  }
  .player-hand header {
    margin-bottom: 4px;
  }
}
@media (max-width: 360px) {
  .action-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .blackjack-table {
    border-radius: 18px;
  }
}
</style>
