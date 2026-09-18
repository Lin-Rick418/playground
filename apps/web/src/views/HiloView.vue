<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { HiloAction, HiloChoice } from "@baccarat/contracts";
import WinCelebration from "../components/WinCelebration.vue";
import AppButton from "../components/ui/AppButton.vue";
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import StakeControl from "../components/ui/StakeControl.vue";
import BalanceBar from "../components/ui/BalanceBar.vue";
import { useAuthStore } from "../stores/auth";
import { useHiloStore } from "../stores/hilo";
import { useLiveChannel } from "../composables/useLiveChannel";
import { formatMoney } from "../lib/money";
import axios from "axios";

const router = useRouter(),
  auth = useAuthStore(),
  game = useHiloStore();
const amount = ref(100),
  loading = ref(true),
  syncing = ref(false),
  error = ref("");
const userId = computed(() => auth.user?.id ?? "");
const active = computed(() => game.round?.status === "ACTIVE");
const ended = computed(() => game.round && !active.value);
const cardMotion = ref<"idle" | "leaving" | "revealing">("idle");
const outgoingCard = ref<number | null>(null);
type Celebration = { multiplier: number; payout: number; tier: "big" | "mega" | "super" };
const queuedCelebration = ref<Celebration | null>(null);
const celebration = ref<Celebration | null>(null);
let celebrationTimer: ReturnType<typeof setTimeout> | undefined;
function clearCelebration() {
  clearTimeout(celebrationTimer);
  queuedCelebration.value = null;
  celebration.value = null;
}
watch(
  [queuedCelebration, cardMotion],
  ([prize, motion]) => {
    if (!prize || motion !== "idle") return;
    celebration.value = prize;
    queuedCelebration.value = null;
    const duration = prize.tier === "super" ? 5200 : prize.tier === "mega" ? 4400 : 3600;
    celebrationTimer = setTimeout(clearCelebration, duration);
  },
  { flush: "post" },
);
const animatedAction = ref<
  { kind: "skip" | "refresh_preview" } | { kind: "guess"; choice: HiloChoice }
>();
const card = computed(() =>
  cardMotion.value === "leaving"
    ? outgoingCard.value
    : (game.round?.card ?? game.preview?.card ?? null),
);
const stake = computed({
  get: () => (active.value ? game.round!.amount : amount.value),
  set: (n: number) => {
    amount.value = n;
  },
});
const busy = computed(
  () =>
    loading.value ||
    syncing.value ||
    game.busy ||
    Boolean(game.pending) ||
    cardMotion.value !== "idle" ||
    !live.connected.value,
);
const pendingAction = computed(() => (game.busy ? game.pending?.action : animatedAction.value));
const refreshingPreview = computed(() => pendingAction.value?.kind === "refresh_preview");
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function finishReveal() {
  clearTimeout(revealTimer);
  cardMotion.value = "idle";
  animatedAction.value = undefined;
  outgoingCard.value = null;
}
function revealNextCard() {
  clearTimeout(revealTimer);
  outgoingCard.value = null;
  cardMotion.value = "revealing";
  // Also release the controls if the browser cancels the animation without an end event.
  revealTimer = setTimeout(finishReveal, 1080);
}
function finishCardExit() {
  if (cardMotion.value === "leaving") revealNextCard();
}
function replaceCard(previousCard: number, kind: "skip" | "refresh_preview") {
  finishReveal();
  animatedAction.value = { kind };
  outgoingCard.value = previousCard;
  cardMotion.value = "leaving";
  revealTimer = setTimeout(finishCardExit, 320);
}
watch(
  () => game.preview,
  (preview, previous) => {
    if (
      !preview ||
      !previous ||
      preview.id !== previous.id ||
      preview.version <= previous.version ||
      game.round ||
      loading.value ||
      syncing.value ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    replaceCard(previous.card, "refresh_preview");
  },
);
watch(
  () => game.round,
  (round, previous) => {
    const step = round?.steps.at(-1);
    if (!round || round.id !== previous?.id) {
      clearCelebration();
      finishReveal();
      return;
    }
    // Only a fresh, server-confirmed settlement can celebrate; sync/replay must stay quiet.
    if (
      !loading.value &&
      !syncing.value &&
      previous.status === "ACTIVE" &&
      round.status === "CASHED_OUT" &&
      round.version > previous.version &&
      round.payout > 0 &&
      round.multiplier >= 8
    ) {
      queuedCelebration.value = {
        multiplier: round.multiplier,
        payout: round.payout,
        tier: round.multiplier >= 101 ? "super" : round.multiplier >= 16 ? "mega" : "big",
      };
    }
    if (
      loading.value ||
      syncing.value ||
      !step ||
      step.sequence <= (previous.steps.at(-1)?.sequence ?? 0) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    finishReveal();
    if (step.kind === "skip") {
      replaceCard(previous.card, "skip");
    } else if (step.choice) {
      animatedAction.value = { kind: "guess", choice: step.choice };
      revealNextCard();
    }
  },
);
function guessPending(choice: HiloChoice) {
  return pendingAction.value?.kind === "guess" && pendingAction.value.choice === choice;
}
const labels: Record<HiloChoice, string> = {
  higher_or_equal: "大於或等於",
  lower_or_equal: "小於或等於",
  higher: "更高",
  lower: "更低",
  same: "相同",
};
const choiceDisplay: Record<HiloChoice, { symbol: string; title: string; hint: string }> = {
  higher_or_equal: { symbol: "≥", title: "大於", hint: "含相同" },
  lower_or_equal: { symbol: "≤", title: "小於", hint: "含相同" },
  higher: { symbol: ">", title: "更高", hint: "不含相同" },
  lower: { symbol: "<", title: "更低", hint: "不含相同" },
  same: { symbol: "=", title: "相同", hint: "同點數" },
};
const trail = ref<HTMLOListElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
function updateTrailArrows() {
  const element = trail.value;
  canScrollLeft.value = Boolean(element && element.scrollLeft > 1);
  canScrollRight.value = Boolean(
    element && element.scrollWidth - element.clientWidth - element.scrollLeft > 1,
  );
}
function scrollTrail(direction: -1 | 1) {
  const element = trail.value;
  if (!element) return;
  element.scrollBy({
    left: direction * Math.max(54, element.clientWidth * 0.8),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
  });
}
watch(
  [trail, () => game.round?.steps.length],
  ([element], _previous, onCleanup) => {
    updateTrailArrows();
    if (!element) return;
    const observer = new ResizeObserver(updateTrailArrows);
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);
const suitNames = ["黑桃", "紅心", "方塊", "梅花"];
const suits = ["♠", "♥", "♦", "♣"];
const rankName = (n: number) =>
  ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][Math.floor(n / 4)];
const cardLabel = (n: number) => `${suitNames[n % 4]} ${rankName(n)}`;
const red = (n: number) => n % 4 === 1 || n % 4 === 2;
const returned = computed(() =>
  game.round ? (active.value ? game.round.cashoutAmount : game.round.payout) : 0,
);
const profit = computed(() => (game.round ? returned.value - game.round.amount : 0));
let disposed = false;
let operation: Promise<unknown> | null = null;
let restoring: Promise<void> | null = null;
let restoringUser = "";
function explain(cause: unknown) {
  return axios.isAxiosError(cause)
    ? (cause.response?.data?.message ?? cause.message)
    : cause instanceof Error
      ? cause.message
      : "操作失敗，請重試。";
}
async function act(action: HiloAction) {
  if (busy.value) return;
  if (action.kind === "prepare") clearCelebration();
  error.value = "";
  const task = game.mutate(action);
  operation = task;
  try {
    await task;
  } catch (cause) {
    if (!disposed) error.value = explain(cause);
  } finally {
    if (operation === task) operation = null;
  }
}
function start() {
  if (!game.preview) return;
  return act({
    kind: "start",
    amount: amount.value,
    previewId: game.preview.id,
    expectedVersion: game.preview.version,
  });
}
function refresh() {
  if (!game.preview) return;
  return act({
    kind: "refresh_preview",
    previewId: game.preview.id,
    expectedVersion: game.preview.version,
  });
}
function roundAction(kind: "guess" | "skip" | "cashout", choice?: HiloChoice) {
  if (!game.round) return;
  const ref = { roundId: game.round.id, expectedVersion: game.round.version };
  return kind === "guess" && choice
    ? act({ kind, ...ref, choice })
    : kind !== "guess"
      ? act({ kind, ...ref })
      : undefined;
}
async function restore(): Promise<void> {
  if (restoring) {
    if (restoringUser === userId.value) return restoring;
    await restoring;
    return restore();
  }
  restoringUser = userId.value;
  syncing.value = true;
  const id = userId.value;
  restoring = (async () => {
    if (operation) await operation.catch(() => {});
    if (disposed || !id || id !== userId.value) return;
    game.setUser(id);
    await game.fetchConfig();
    if (disposed || id !== userId.value) return;
    await game.reconcile();
    if (disposed || id !== userId.value) return;
    if (!game.round && !game.preview && game.config?.enabled)
      await game.mutate({ kind: "prepare" });
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
  onError: (message) => {
    error.value = message;
  },
});
game.setUser(userId.value);
game.transport = live.requestHilo;
watch(userId, (id) => {
  clearCelebration();
  finishReveal();
  live.disconnect();
  game.setUser(id);
  error.value = "";
  loading.value = true;
  if (id) live.reconnect();
});
onUnmounted(() => {
  clearCelebration();
  finishReveal();
  disposed = true;
  if (game.transport === live.requestHilo) game.transport = null;
});
</script>

<template>
  <main class="player-page hilo-page">
    <AppPageHeader back-label="返回遊戲選擇" @back="router.push('/lobby')">Hi-Lo</AppPageHeader>
    <section class="hilo-summary" aria-label="本局結果" aria-live="polite">
      <div>
        <span>目前倍率</span
        ><strong>{{
          game.round?.successCount ? game.round.multiplier.toFixed(2) + "×" : "—"
        }}</strong>
      </div>
      <div>
        <span>{{ ended ? "本局派彩" : "可收款" }}</span
        ><strong>{{ formatMoney(returned) }}</strong>
      </div>
      <div>
        <span>淨利</span
        ><strong>{{
          game.round && (game.round.successCount || ended) ? formatMoney(profit) : "—"
        }}</strong>
      </div>
    </section>
    <section class="hilo-table" :aria-busy="busy" aria-label="Hi-Lo 牌桌">
      <WinCelebration v-if="celebration" class="hilo-win" v-bind="celebration" :count="1" />
      <span class="table-watermark" aria-hidden="true">HI / LO</span>
      <div class="hilo-card-slot">
        <div
          class="hilo-card"
          :class="{
            red: card !== null && red(card),
            back: card === null,
            'is-leaving': cardMotion === 'leaving',
          }"
          role="img"
          :aria-label="card === null ? '等待發牌' : cardLabel(card)"
          @animationend.self="finishCardExit"
        >
          <div
            class="card-flipper"
            :class="{ 'is-revealing': cardMotion === 'revealing' }"
            @animationend.self="finishReveal"
          >
            <div class="card-face card-front" aria-hidden="true">
              <template v-if="card !== null">
                <span class="card-corner"
                  >{{ rankName(card) }}<small>{{ suits[card % 4] }}</small></span
                >
                <span class="card-suit">{{ suits[card % 4] }}</span>
                <span class="card-corner bottom"
                  >{{ rankName(card) }}<small>{{ suits[card % 4] }}</small></span
                >
              </template>
            </div>
            <div class="card-face card-back" aria-hidden="true"></div>
          </div>
        </div>
      </div>
      <div v-if="game.round" class="hilo-trail-scroll">
        <button
          v-show="canScrollLeft"
          type="button"
          class="trail-arrow trail-arrow-left"
          aria-label="查看較早的牌"
          aria-controls="hilo-trail"
          @click="scrollTrail(-1)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <ol
          id="hilo-trail"
          ref="trail"
          class="hilo-trail"
          aria-label="本局牌序"
          tabindex="0"
          @scroll.passive="updateTrailArrows"
        >
          <li :class="{ red: red(game.round.initialCard) }">
            <b>{{ rankName(game.round.initialCard) }}{{ suits[game.round.initialCard % 4] }}</b
            ><small>起始</small>
          </li>
          <li
            v-for="step in game.round.steps"
            :key="step.sequence"
            :class="{ red: red(step.card), lost: step.won === false }"
            :aria-label="`${cardLabel(step.card)}，${step.kind === 'skip' ? '跳牌' : step.won ? '猜對' : '猜錯'}`"
          >
            <b>{{ rankName(step.card) }}{{ suits[step.card % 4] }}</b
            ><small>{{ step.kind === "skip" ? "↷ 跳牌" : step.won ? "✓ 猜對" : "✕ 猜錯" }}</small>
          </li>
        </ol>
        <button
          v-show="canScrollRight"
          type="button"
          class="trail-arrow trail-arrow-right"
          aria-label="查看較新的牌"
          aria-controls="hilo-trail"
          @click="scrollTrail(1)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </section>
    <section
      class="hilo-controls"
      :class="{ 'preview-pending': refreshingPreview }"
      aria-label="投注與猜牌"
    >
      <template v-if="active && game.round">
        <div class="hilo-choices">
          <!-- These are two persistent control slots; A/K only change their contents/actions. -->
          <AppButton
            v-for="(option, slot) in game.round.options"
            :key="slot"
            class="hilo-choice"
            :class="{ 'is-waiting': pendingAction && option.enabled }"
            :busy="guessPending(option.choice)"
            :disabled="busy || !option.enabled"
            :aria-label="labels[option.choice]"
            @click="roundAction('guess', option.choice)"
          >
            <span class="choice-heading">
              <span class="choice-symbol" aria-hidden="true">{{
                choiceDisplay[option.choice].symbol
              }}</span>
              <strong>{{ choiceDisplay[option.choice].title }}</strong>
              <span class="choice-hint">{{ choiceDisplay[option.choice].hint }}</span>
            </span>
            <span class="choice-metrics">
              <span
                ><small>勝率</small>
                {{ ((option.winningRanks / option.totalRanks) * 100).toFixed(2) }}%</span
              >
              <strong>{{ option.multiplier.toFixed(2) }}×</strong>
            </span>
            <small class="choice-payout">{{
              guessPending(option.choice)
                ? "確認中…"
                : option.enabled
                  ? `派彩 ${formatMoney(option.payout)}`
                  : "超過最高倍率"
            }}</small>
          </AppButton>
        </div>
        <div class="hilo-actions">
          <AppButton
            :class="{ 'is-waiting': pendingAction && game.round.skipCount < 52 }"
            :busy="pendingAction?.kind === 'skip'"
            :disabled="busy || game.round.skipCount >= 52"
            @click="roundAction('skip')"
            >{{
              pendingAction?.kind === "skip" ? "跳牌中…" : `跳牌（${52 - game.round.skipCount}）`
            }}</AppButton
          ><AppButton
            variant="primary"
            :class="{ 'is-waiting': pendingAction && game.round.successCount > 0 }"
            :busy="pendingAction?.kind === 'cashout'"
            :disabled="busy || !game.round.successCount"
            @click="roundAction('cashout')"
            >收款 {{ formatMoney(game.round.cashoutAmount) }}</AppButton
          >
        </div>
      </template>
      <template v-else-if="ended"
        ><AppButton
          variant="primary"
          class="next-round"
          :disabled="busy || !game.config?.enabled"
          @click="act({ kind: 'prepare' })"
          >下一局</AppButton
        ></template
      >
      <template v-else
        ><div class="hilo-actions">
          <AppButton
            :busy="refreshingPreview"
            :disabled="busy || !game.preview || !game.config?.enabled"
            @click="refresh"
            >{{ refreshingPreview ? "換牌中…" : "免費換牌" }}</AppButton
          ><AppButton
            variant="primary"
            :disabled="busy || !game.preview || !game.config?.enabled"
            @click="start"
            >下注</AppButton
          >
        </div></template
      >
      <StakeControl
        v-model="stake"
        :disabled="(busy && !refreshingPreview) || active"
        :inert="refreshingPreview || undefined"
      />
      <p v-if="game.config && !game.config.enabled" role="status">
        暫停接受新投注，已開局仍可繼續與收款。
      </p>
      <p v-if="!live.connected.value && !loading" role="status">連線中斷，正在重新連線…</p>
      <p v-if="error" class="hilo-error" role="alert">{{ error }}</p>
      <AppButton
        v-if="error || (game.pending && !game.busy && !syncing)"
        :disabled="game.busy || syncing || !live.connected.value"
        @click="restore"
        >{{ game.pending ? "確認上一個操作" : "重新同步" }}</AppButton
      >
    </section>
    <BalanceBar :balance="auth.user?.balance" />
  </main>
</template>

<style scoped>
.hilo-page {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto auto;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  gap: 8px;
  padding: env(safe-area-inset-top, 0px) var(--ui-page-gutter)
    max(8px, env(safe-area-inset-bottom, 0px));
  background: radial-gradient(ellipse at 50% 28%, #244d3e, #10271f 52%, #091612);
  color: #f2ead7;
}
.hilo-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 8px;
  border-block: 1px solid #dbbd6e33;
  text-align: center;
}
.hilo-summary div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.hilo-summary span {
  font-size: 12px;
  color: #b9c8bc;
}
.hilo-summary strong {
  color: #f2d798;
  font-size: clamp(14px, 3.8vw, 22px);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.hilo-table {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  justify-items: center;
  gap: 8px;
  padding: 4px 0;
  min-width: 0;
  min-height: 0;
}
.hilo-card-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.table-watermark {
  position: absolute;
  top: 35%;
  color: #fff;
  opacity: 0.04;
  z-index: 0;
  font-size: 76px;
  letter-spacing: 0.12em;
  white-space: nowrap;
  pointer-events: none;
}
.hilo-card {
  position: relative;
  z-index: 1;
  width: auto;
  height: min(100%, 170px);
  aspect-ratio: 142 / 198;
  flex: 0 0 auto;
  container-type: size;
  border-radius: 14px;
  color: #142b23;
  perspective: 800px;
}
.hilo-card.is-leaving {
  animation: hilo-skip-exit 260ms ease-in both;
}
.hilo-card.red {
  color: #af3739;
}
.card-flipper {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  transform-style: preserve-3d;
}
.card-flipper.is-revealing {
  animation: hilo-reveal 1000ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}
.hilo-card.back .card-flipper {
  transform: rotateY(180deg);
}
.card-face {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1px solid #e7d9b4;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  box-shadow:
    0 16px 32px #0005,
    0 0 0 5px #dfc9910c;
}
.card-front {
  display: grid;
  place-items: center;
  background: #fff9e9;
}
.card-back {
  transform: rotateY(180deg);
  /* Same burgundy striped back used by Baccarat's masked playing cards. */
  background:
    repeating-linear-gradient(
      45deg,
      rgba(234, 231, 222, 0.18),
      rgba(234, 231, 222, 0.18) 8px,
      rgba(122, 25, 34, 0.82) 8px,
      rgba(122, 25, 34, 0.82) 16px
    ),
    linear-gradient(135deg, #43151b, #912735);
}
@keyframes hilo-skip-exit {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-100vw);
  }
}
@keyframes hilo-reveal {
  from {
    transform: rotateY(180deg);
  }
  to {
    transform: rotateY(0deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .card-flipper.is-revealing,
  .hilo-card.is-leaving {
    animation: none;
  }
}
.card-corner {
  position: absolute;
  top: 6%;
  left: 8%;
  font-size: clamp(12px, 14cqh, 24px);
  line-height: 1;
  font-weight: 700;
  text-align: center;
}
.card-corner small {
  display: block;
  font-size: clamp(10px, 11cqh, 18px);
  margin-top: 2px;
}
.card-corner.bottom {
  inset: auto 8% 6% auto;
  transform: rotate(180deg);
}
.card-suit {
  font-size: 40cqh;
}
.hilo-trail-scroll {
  position: relative;
  width: 100%;
  min-width: 0;
  padding-inline: 28px;
}
.trail-arrow {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 28px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #f2d798;
  cursor: pointer;
}
.trail-arrow-left {
  left: 0;
}
.trail-arrow-right {
  right: 0;
}
.hilo-trail:focus-visible {
  outline: 2px solid #f2d798;
  outline-offset: -2px;
}
.trail-arrow svg {
  width: 20px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hilo-trail {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  width: 100%;
  padding: 2px 0 4px;
  margin: 0;
  list-style: none;
  scrollbar-width: none;
}
.hilo-trail::-webkit-scrollbar {
  display: none;
}
.hilo-trail li {
  flex: 0 0 46px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 3px;
  border-radius: 6px;
  text-align: center;
  background: #ede5d2;
  color: #183a2d;
}
.hilo-trail .red b {
  color: #af3739;
}
.hilo-trail small {
  font-size: 10px;
}
.hilo-trail .lost {
  outline: 2px solid #df6565;
}
.hilo-controls {
  display: grid;
  gap: 8px;
  max-height: 48dvh;
  overflow-y: auto;
}
.hilo-choices,
.hilo-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.hilo-choices .hilo-choice {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  min-height: 90px;
  padding: 8px 10px;
  border: 1px solid #c7a96988;
  background: linear-gradient(145deg, #294b3d, #18352b);
  color: #fff4da;
  box-shadow: inset 0 1px 0 #ffffff0c;
  line-height: 1.2;
}
.choice-heading {
  display: flex;
  align-items: center;
  gap: 6px;
}
.choice-symbol {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: #eacb8520;
  color: #f2d798;
  font-size: 22px;
}
.choice-heading strong {
  font-size: 15px;
}
.choice-hint {
  margin-left: auto;
  font-size: 10px;
  color: #c4d2c6;
  font-weight: 400;
}
.choice-metrics {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.choice-metrics small {
  font-size: 10px;
  font-weight: 400;
  color: #c4d2c6;
}
.choice-metrics strong {
  color: #f2d798;
}
.choice-payout {
  border-top: 1px solid #eacb8526;
  padding-top: 5px;
  font-size: 10px;
  font-weight: 400;
  color: #c4d2c6;
  font-variant-numeric: tabular-nums;
}
.hilo-actions :deep(button) {
  min-height: 44px;
}
.preview-pending .hilo-actions :deep(button:disabled),
.hilo-controls :deep(button.is-waiting:disabled) {
  opacity: 1;
  cursor: wait;
}
.hilo-actions :deep(button:not(:disabled):active),
.hilo-choices :deep(button:not(:disabled):active) {
  transform: none;
}
.next-round {
  width: 100%;
}
.hilo-error {
  color: #ffb4ac;
  margin: 0;
}
</style>
