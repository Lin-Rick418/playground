<script setup lang="ts">
import AppSelect from "../components/ui/AppSelect.vue";
import AppButton from "../components/ui/AppButton.vue";
import StakeControl from "../components/ui/StakeControl.vue";
import BalanceBar from "../components/ui/BalanceBar.vue";
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import axios from "axios";
import { useRouter } from "vue-router";
import type { PlinkoRisk, PlinkoRound } from "@baccarat/contracts";
import PlinkoWin from "../components/PlinkoWin.vue";
import { getRollingMoneyValue } from "../composables/useSettledDailyProfit";
import { useLiveChannel } from "../composables/useLiveChannel";
import { formatMoney, sumMoney } from "../lib/money";
import { useAuthStore } from "../stores/auth";
import { isValidPlinkoStake, PendingPlinkoMutationError, usePlinkoStore } from "../stores/plinko";

type AnimatedBall = {
  round: PlinkoRound;
  x: number;
  y: number;
  done: boolean;
  startedAt: number;
  hitPin: string | null;
};
const router = useRouter();
const auth = useAuthStore();
const store = usePlinkoStore();
const amount = ref(100);
const rows = ref(16);
const risk = ref<PlinkoRisk>("medium");
const autoCounts = [30, 50, 100, 300, 500, 1000];
const infiniteAutoCount = -1;
const autoCount = ref(0);
const autoRunning = ref(false);
const celebration = ref<{ multiplier: number; payout: number; count: number } | null>(null);
let celebrationTimer: ReturnType<typeof setTimeout> | undefined;
function clearCelebration() {
  clearTimeout(celebrationTimer);
  celebration.value = null;
}
function celebrate(round: PlinkoRound) {
  if (round.multiplier < 10) return;
  const previous = celebration.value;
  celebration.value = {
    multiplier: Math.max(previous?.multiplier ?? 0, round.multiplier),
    payout: sumMoney([previous?.payout ?? 0, round.payout]),
    count: (previous?.count ?? 0) + 1,
  };
  clearTimeout(celebrationTimer);
  celebrationTimer = setTimeout(clearCelebration, 3600);
}
const autoRemaining = ref(0);
let autoTimer: ReturnType<typeof setTimeout> | undefined;
let autoGeneration = 0;
function stopAuto() {
  autoGeneration++;
  clearTimeout(autoTimer);
  autoRunning.value = false;
  autoRemaining.value = 0;
}
async function runAuto(version: number) {
  if (!autoRunning.value || version !== autoGeneration || disposed) return;
  // Wait for animation capacity without submitting overlapping requests.
  if (activeBalls.value.length < 12) {
    const accepted = await submit();
    if (!autoRunning.value || version !== autoGeneration || disposed) return;
    if (!accepted) {
      stopAuto();
      return;
    }
    if (autoRemaining.value > 0) {
      autoRemaining.value--;
      if (autoRemaining.value === 0) {
        stopAuto();
        return;
      }
    }
  }
  autoTimer = setTimeout(() => void runAuto(version), 350);
}
async function togglePlay() {
  if (autoRunning.value) {
    stopAuto();
    return;
  }
  if (controlsBusy.value || !config.value?.enabled || !table.value || disposed) return;
  if (autoCount.value === 0) {
    await submit();
    return;
  }
  if (autoCount.value !== infiniteAutoCount && !autoCounts.includes(autoCount.value)) return;
  autoRemaining.value = autoCount.value;
  autoRunning.value = true;
  void runAuto(++autoGeneration);
}
const loading = ref(true);
const settingsDialog = ref<HTMLDialogElement | null>(null);
const settingsOpen = ref(false);
function openSettings() {
  settingsDialog.value?.showModal();
  settingsOpen.value = true;
}
function trapSettingsTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || !settingsDialog.value) return;
  const elements = [...settingsDialog.value.querySelectorAll<HTMLElement>("button, select")].filter(
    (element) => !element.matches(":disabled"),
  );
  const first = elements[0];
  const last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
function closeSettings() {
  settingsDialog.value?.close();
  settingsOpen.value = false;
}
const submitting = ref(false);
const syncing = ref(false);
const error = ref("");
const walletElement = ref<InstanceType<typeof BalanceBar> | null>(null);
function clearWalletWarning() {
  walletElement.value?.clearWarning();
}
function warnInsufficientBalance() {
  if (disposed) return;
  error.value = "";
  walletElement.value?.warn();
}
function isInsufficientBalance(cause: unknown) {
  if (!axios.isAxiosError(cause)) return false;
  const data = cause.response?.data;
  return (
    data?.code === "INSUFFICIENT_BALANCE" ||
    (data?.code === "VALIDATION_ERROR" && /^餘額不足[。.]?$/.test(data.message ?? ""))
  );
}
const balls = ref<AnimatedBall[]>([]);
const reducedMotion = ref(false);
const pinImpacts = ref<Record<string, number>>({});
const slotImpacts = ref<Record<number, number>>({});
const effectTime = ref(0);
function clearImpacts() {
  pinImpacts.value = {};
  slotImpacts.value = {};
}
function slotY(index: number) {
  const startedAt = slotImpacts.value[index];
  if (startedAt === undefined) return 86;
  const progress = Math.min(1, (effectTime.value - startedAt) / 420);
  return 86 + Math.sin(progress * Math.PI * 2) * 1.7 * (1 - progress);
}
// The authoritative wallet stays current; only its presentation waits for each ball.
const walletSnapshot = ref(auth.user?.balance ?? 0);
const reservedStake = ref(0);
const payoutAnimations = ref<
  { id: string; payout: number; remaining: number; startedAt: number | null }[]
>([]);
const displayedBalance = computed(() =>
  Math.max(
    0,
    sumMoney([
      walletSnapshot.value,
      -reservedStake.value,
      ...payoutAnimations.value.map((payout) => -payout.remaining),
    ]),
  ),
);
const walletRolling = computed(() =>
  payoutAnimations.value.some((payout) => payout.startedAt !== null),
);
watch(
  [() => auth.user?.balance, submitting, () => store.requestInFlight, () => store.pending],
  () => {
    // A WebSocket notification can arrive before POST supplies this ball's payout.
    if (!submitting.value && !store.requestInFlight && !store.pending) {
      reservedStake.value = 0;
      walletSnapshot.value = auth.user?.balance ?? 0;
    }
  },
);
let raf = 0;
let generation = 0;
let disposed = false;
let attemptedOnThisPage = false;
const userId = computed(() => auth.user?.id ?? "");
const config = computed(() => store.config);
const activeBalls = computed(() => balls.value.filter((ball) => !ball.done));
const recentResults = computed(() => {
  const fallingIds = new Set(activeBalls.value.map((ball) => ball.round.id));
  return store.history.filter((round) => !fallingIds.has(round.id)).slice(0, 10);
});
const controlsBusy = computed(
  () =>
    !live.connected.value ||
    submitting.value ||
    syncing.value ||
    store.requestInFlight ||
    Boolean(store.pending) ||
    Boolean(store.storageError),
);
const showPendingRecovery = computed(
  () => Boolean(store.pending) && !submitting.value && !store.requestInFlight,
);
const settingsLocked = computed(
  () => autoRunning.value || controlsBusy.value || activeBalls.value.length > 0,
);
const table = computed(() =>
  config.value?.tables.find((entry) => entry.rows === rows.value && entry.risk === risk.value),
);
const multipliers = computed(() => table.value?.multipliers ?? []);
const slotLegend = ref<HTMLElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
function updateLegendHints() {
  const legend = slotLegend.value;
  canScrollLeft.value = Boolean(legend && legend.scrollLeft > 1);
  canScrollRight.value = Boolean(
    legend && legend.scrollWidth - legend.clientWidth - legend.scrollLeft > 1,
  );
}
watch(
  [slotLegend, multipliers],
  ([legend], _previous, onCleanup) => {
    updateLegendHints();
    if (!legend || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLegendHints);
    observer.observe(legend);
    onCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);
const pins = computed(() =>
  Array.from({ length: rows.value }, (_, row) =>
    Array.from({ length: row + 3 }, (_, column) => ({
      id: `${row}:${column - 1}`,
      x: 50 + ((column - 1 - row / 2) * 82) / rows.value,
      y: 12 + (row * 74) / rows.value,
    })),
  ).flat(),
);
const litPins = computed(() => new Set(Object.keys(pinImpacts.value)));
const pinRipples = computed(() =>
  pins.value
    .filter((pin) => litPins.value.has(pin.id))
    .map((pin) => ({
      ...pin,
      progress: Math.min(1, (effectTime.value - pinImpacts.value[pin.id]!) / 320),
    })),
);
const litSlots = computed(
  () => new Set(balls.value.filter((ball) => ball.done).map((ball) => ball.round.slotIndex)),
);
function multiplierText(value: number) {
  return `${value.toFixed(2)}×`;
}
function riskLabel(value: PlinkoRisk) {
  return value === "low" ? "低風險" : value === "medium" ? "中風險" : "高風險";
}
function apiMessage(cause: unknown, fallback: string) {
  return axios.isAxiosError(cause) ? (cause.response?.data?.message ?? fallback) : fallback;
}
function current(user: string, version: number) {
  return !disposed && auth.user?.id === user && generation === version;
}
function pointFor(path: number[], progress: number) {
  const n = path.length;
  if (progress < 0.08) return { x: 50, y: 2 + (progress / 0.08) * 8.3, hitPin: null };
  const step = Math.min(n, Math.max(0, (progress - 0.08) / 0.82) * n);
  const completed = Math.floor(step);
  const fraction = step - completed;
  const rights = path.slice(0, completed).reduce((sum, direction) => sum + direction, 0);
  const x = 50 + ((rights - completed / 2) * 82) / n;
  if (progress >= 0.9)
    return { x, y: 84.3 + Math.min(1, (progress - 0.9) / 0.1) * 5.2, hitPin: null };
  return {
    x: x + ((((path[completed] ?? 0) - 0.5) * 82) / n) * fraction,
    y: 10.3 + (step * 74) / n - Math.sin(fraction * Math.PI) * 1.8,
    hitPin: fraction < 0.35 ? `${completed}:${rights}` : null,
  };
}
function renderAnimations(now: number) {
  raf = 0;
  effectTime.value = now;
  const next = balls.value.map((ball) => {
    if (ball.done) return ball;
    const progress = Math.min(1, Math.max(0, (now - ball.startedAt) / 2500));
    const point = pointFor(ball.round.path, progress);
    if (point.hitPin && point.hitPin !== ball.hitPin) pinImpacts.value[point.hitPin] = now;
    if (progress === 1) {
      slotImpacts.value[ball.round.slotIndex] = now;
      celebrate(ball.round);
    }
    return { ...ball, ...point, done: progress === 1 };
  });
  pinImpacts.value = Object.fromEntries(
    Object.entries(pinImpacts.value).filter(([, started]) => now - started < 320),
  );
  slotImpacts.value = Object.fromEntries(
    Object.entries(slotImpacts.value).filter(([, started]) => now - started < 420),
  );
  const landed = new Set(next.filter((ball) => ball.done).map((ball) => ball.round.id));
  payoutAnimations.value = payoutAnimations.value.flatMap((payout) => {
    const startedAt = payout.startedAt ?? (landed.has(payout.id) ? now : null);
    if (startedAt === null) return [payout];
    const progress = Math.min(1, (now - startedAt) / 800);
    if (progress === 1) return [];
    return [
      {
        ...payout,
        startedAt,
        remaining: getRollingMoneyValue(Math.round(payout.payout * 100), 0, progress) / 100,
      },
    ];
  });
  // Keep every active ball, and only the four latest landed balls.
  const keep = new Set(
    next
      .filter((ball) => ball.done)
      .slice(-4)
      .map((ball) => ball.round.id),
  );
  balls.value = next.filter((ball) => !ball.done || keep.has(ball.round.id));
  if (
    (activeBalls.value.length ||
      payoutAnimations.value.length ||
      Object.keys(pinImpacts.value).length ||
      Object.keys(slotImpacts.value).length) &&
    !disposed
  )
    raf = requestAnimationFrame(renderAnimations);
}
function animate(round: PlinkoRound, skip = false) {
  if (balls.value.some((ball) => ball.round.id === round.id)) return;
  const done = reducedMotion.value || skip;
  if (done && !skip) celebrate(round);
  if (!done)
    payoutAnimations.value.push({
      id: round.id,
      payout: round.payout,
      remaining: round.payout,
      startedAt: null,
    });
  const previous = [...balls.value.filter((ball) => ball.done).slice(-3), ...activeBalls.value];
  balls.value = [
    ...previous,
    { round, ...pointFor(round.path, done ? 1 : 0), done, startedAt: performance.now() },
  ];
  if (!done && !raf) raf = requestAnimationFrame(renderAnimations);
}
async function refreshWallet() {
  await auth.fetchMe({ preserveNewerLiveSnapshot: true });
}
function accept(round: PlinkoRound, balance: number, walletVersion: number, replay = false) {
  auth.patchBalance(balance, walletVersion);
  if (replay) {
    clearCelebration();
    clearImpacts();
    payoutAnimations.value = [];
    balls.value = [];
    rows.value = round.rows;
    risk.value = round.risk;
  }
  animate(round, replay);
  reservedStake.value = 0;
  walletSnapshot.value = auth.user?.balance ?? balance;
  store.history = [round, ...store.history.filter((item) => item.id !== round.id)].slice(0, 50);
}
async function submit(): Promise<boolean> {
  if (
    !userId.value ||
    controlsBusy.value ||
    !config.value?.enabled ||
    !table.value ||
    activeBalls.value.length >= 12
  )
    return false;
  if (!isValidPlinkoStake(amount.value, config.value)) {
    error.value = "投注額需為 100 至 5,000 幣，並以 100 幣遞增。";
    return false;
  }
  if ((auth.user?.balance ?? 0) < amount.value) {
    warnInsufficientBalance();
    return false;
  }
  clearWalletWarning();
  const requestUser = userId.value,
    version = generation;
  submitting.value = true;
  reservedStake.value = amount.value;
  error.value = "";
  try {
    attemptedOnThisPage = true;
    const result = await store.place(requestUser, {
      amount: amount.value,
      rows: rows.value,
      risk: risk.value,
      ruleVersion: config.value.ruleVersion,
    });
    if (!current(requestUser, version)) return false;
    accept(result.round, result.balance, result.walletVersion);
    return true;
  } catch (cause) {
    if (current(requestUser, version)) {
      if (isInsufficientBalance(cause)) warnInsufficientBalance();
      else
        error.value =
          cause instanceof PendingPlinkoMutationError
            ? cause.message
            : apiMessage(cause, "投注結果尚未確認，請確認上一筆投注。");
    }
    return false;
  } finally {
    if (current(requestUser, version)) submitting.value = false;
  }
}
async function reconcile() {
  if (
    !live.connected.value ||
    !userId.value ||
    submitting.value ||
    syncing.value ||
    store.requestInFlight ||
    !store.pending
  )
    return;
  const requestUser = userId.value,
    version = generation;
  submitting.value = true;
  error.value = "";
  try {
    attemptedOnThisPage = true;
    const result = await store.reconcilePending(requestUser);
    if (result && current(requestUser, version)) {
      accept(result.round, result.balance, result.walletVersion, true);
      await refreshWallet();
    }
  } catch (cause) {
    if (current(requestUser, version)) {
      if (isInsufficientBalance(cause)) warnInsufficientBalance();
      else error.value = apiMessage(cause, "仍無法確認上一筆投注，請稍後再試。");
    }
  } finally {
    if (current(requestUser, version)) submitting.value = false;
  }
}
async function load() {
  if (!userId.value) return;
  const requestUser = userId.value,
    version = ++generation;
  syncing.value = true;
  try {
    store.restorePending(requestUser);
    await store.fetchConfig();
    if (!current(requestUser, version)) return;
    await Promise.all([store.fetchHistory(), refreshWallet()]);
  } catch (cause) {
    if (current(requestUser, version))
      error.value = apiMessage(cause, "Plinko 資料載入失敗，請重試載入。");
  } finally {
    if (current(requestUser, version)) {
      syncing.value = false;
      loading.value = false;
    }
  }
}
const live = useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_user" }),
  onMessage: () => {},
  onConnected: () => {
    if (!submitting.value && !disposed) void refreshWallet().catch(() => undefined);
  },
});
store.transport = live.requestPlinko;
let recoverAfterReconnect = false;
watch(
  [live.connected, submitting, syncing, loading, () => store.requestInFlight],
  ([connected]) => {
    if (!connected) {
      stopAuto();
      if (store.pending && attemptedOnThisPage) recoverAfterReconnect = true;
      return;
    }
    if (
      recoverAfterReconnect &&
      !loading.value &&
      !syncing.value &&
      !submitting.value &&
      !store.requestInFlight &&
      !disposed
    ) {
      recoverAfterReconnect = false;
      void reconcile();
    }
  },
  { flush: "sync" },
);
onMounted(() => {
  reducedMotion.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  void load();
});
watch(
  [rows, risk],
  () => {
    if (!activeBalls.value.length) {
      balls.value = [];
      clearImpacts();
    }
  },
  { flush: "sync" },
);
watch(
  userId,
  (next) => {
    recoverAfterReconnect = false;
    attemptedOnThisPage = false;
    stopAuto();
    clearCelebration();
    generation++;
    clearWalletWarning();
    clearImpacts();
    payoutAnimations.value = [];
    reservedStake.value = 0;
    walletSnapshot.value = auth.user?.balance ?? 0;
    balls.value = [];
    submitting.value = false;
    syncing.value = false;
    error.value = "";
    store.restorePending(next);
    if (next) void load();
  },
  { flush: "sync" },
);
onUnmounted(() => {
  if (store.transport === live.requestPlinko) store.transport = null;
  stopAuto();
  clearCelebration();
  clearWalletWarning();
  disposed = true;
  generation++;
  cancelAnimationFrame(raf);
  raf = 0;
});
</script>

<template>
  <main class="player-page plinko-page">
    <AppPageHeader
      class="plinko-header"
      title="PLINKO"
      back-label="返回遊戲選擇"
      @back="router.push('/lobby')"
    />
    <p v-if="loading" class="plinko-status" role="status">載入遊戲中…</p>
    <template v-else>
      <div class="plinko-toolbar">
        <section class="recent-results" aria-label="最近 10 顆倍率（最新在前）">
          <ol v-if="recentResults.length">
            <li v-for="round in recentResults" :key="round.id">
              {{ multiplierText(round.multiplier) }}
            </li>
          </ol>
          <p v-else>尚無落槽結果</p>
        </section>
        <AppButton
          variant="secondary"
          size="control"
          icon
          class="settings-trigger"
          type="button"
          aria-haspopup="dialog"
          :aria-expanded="settingsOpen"
          aria-controls="plinko-settings"
          aria-label="投注設定"
          :title="`投注設定：${formatMoney(amount)} 幣 · ${rows} 排 · ${riskLabel(risk)}`"
          @click="openSettings"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h5m4 0h7M4 17h9m4 0h3" />
            <circle cx="11" cy="7" r="2" />
            <circle cx="15" cy="17" r="2" />
          </svg>
        </AppButton>
      </div>
      <section class="plinko-layout">
        <section class="plinko-board-panel" aria-label="Plinko 釘板">
          <div class="plinko-board-viewport">
            <PlinkoWin v-if="celebration" v-bind="celebration" />
            <svg
              class="plinko-board"
              viewBox="0 0 100 100"
              role="img"
              :aria-label="`Plinko ${rows} 排 ${riskLabel(risk)}釘板`"
            >
              <g class="pin-ripples" aria-hidden="true">
                <circle
                  v-for="pin in pinRipples"
                  :key="pin.id"
                  :cx="pin.x"
                  :cy="pin.y"
                  :r="1.05 + pin.progress * 1.8"
                  :opacity="0.75 * (1 - pin.progress)"
                />
              </g>
              <g class="pins" aria-hidden="true">
                <circle
                  v-for="pin in pins"
                  :key="pin.id"
                  :cx="pin.x"
                  :cy="pin.y"
                  :r="litPins.has(pin.id) ? 1.05 : 0.75"
                  :class="{ hit: litPins.has(pin.id) }"
                />
              </g>
              <g
                v-for="ball in balls"
                :key="ball.round.id"
                class="plinko-ball"
                :class="{ settled: ball.done, colliding: !ball.done && Boolean(ball.hitPin) }"
                :transform="`translate(${ball.x} ${ball.y})`"
              >
                <circle r="1.3" />
              </g>
              <g class="slots" aria-hidden="true">
                <g
                  v-for="(multiplier, index) in multipliers"
                  :key="index"
                  class="plinko-slot"
                  :class="{ impacting: slotImpacts[index] !== undefined }"
                  :transform="`translate(${9 + (index * 82) / rows} ${slotY(index)})`"
                >
                  <rect
                    :x="-(82 / rows - 0.6) / 2"
                    y="0"
                    :width="82 / rows - 0.6"
                    height="7"
                    rx="1.2"
                    :class="{
                      hot: multiplier >= 10,
                      cold: multiplier < 1,
                      landed: litSlots.has(index),
                    }"
                  />
                  <text y="4.8">{{ index + 1 }}</text>
                </g>
              </g>
            </svg>
          </div>
          <div class="legend-heading">落槽倍率 <span>由左至右 · 含本金</span></div>
          <div class="slot-legend-scroll">
            <span v-show="canScrollLeft" class="legend-hint legend-hint-left" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6" /></svg>
            </span>
            <div
              ref="slotLegend"
              class="slot-legend"
              aria-label="落槽倍率"
              tabindex="0"
              @scroll.passive="updateLegendHints"
            >
              <span
                v-for="(multiplier, index) in multipliers"
                :key="index"
                :class="{ landed: litSlots.has(index) }"
              >
                <small>{{ String(index + 1).padStart(2, "0") }}</small
                ><strong>{{ multiplierText(multiplier) }}</strong>
              </span>
            </div>
            <span v-show="canScrollRight" class="legend-hint legend-hint-right" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
            </span>
          </div>
        </section>
      </section>
      <div class="plinko-bet-action">
        <AppSelect
          v-model.number="autoCount"
          class="auto-count"
          size="action"
          aria-label="自動投球"
          :disabled="autoRunning || controlsBusy"
        >
          <option :value="0">自動：關閉</option>
          <option v-for="count in autoCounts" :key="count" :value="count">{{ count }} 球</option>
          <option :value="infiniteAutoCount" aria-label="無限">∞</option>
        </AppSelect>
        <AppButton
          variant="primary"
          size="action"
          class="plinko-play"
          type="button"
          :disabled="
            !autoRunning && (controlsBusy || !config?.enabled || activeBalls.length >= 12 || !table)
          "
          @click="togglePlay"
        >
          {{
            autoRunning
              ? `停止投球（${autoRemaining === infiniteAutoCount ? "∞" : autoRemaining}）`
              : submitting
                ? "處理中…"
                : !config?.enabled
                  ? "暫停開放"
                  : "投球"
          }}
        </AppButton>
      </div>
      <dialog
        id="plinko-settings"
        ref="settingsDialog"
        class="plinko-settings-dialog"
        aria-labelledby="plinko-settings-title"
        @close="settingsOpen = false"
        @keydown="trapSettingsTab"
        @click.self="closeSettings"
      >
        <section class="plinko-controls" aria-label="投注設定">
          <header class="settings-heading">
            <h2 id="plinko-settings-title">投注設定</h2>
            <AppButton
              variant="secondary"
              size="control"
              icon
              type="button"
              aria-label="關閉投注設定"
              @click="closeSettings"
              >✕</AppButton
            >
          </header>
          <StakeControl v-model="amount" stacked :disabled="controlsBusy || autoRunning" />
          <label
            >排數
            <AppSelect v-model.number="rows" aria-label="排數" :disabled="settingsLocked">
              <option v-for="value in 9" :key="value" :value="value + 7">{{ value + 7 }} 排</option>
            </AppSelect>
          </label>
          <fieldset :disabled="settingsLocked">
            <legend>風險</legend>
            <div class="risk-buttons">
              <AppButton
                v-for="value in config?.risks ?? []"
                :key="value"
                variant="secondary"
                size="control"
                type="button"
                :aria-pressed="risk === value"
                @click="risk = value"
              >
                {{ riskLabel(value) }}
              </AppButton>
            </div>
          </fieldset>
          <AppButton
            variant="primary"
            size="action"
            class="settings-done"
            type="button"
            @click="closeSettings"
            >完成</AppButton
          >
        </section>
      </dialog>
      <section
        v-if="!live.connected.value || error || showPendingRecovery || store.storageError"
        class="plinko-feedback"
      >
        <p v-if="!live.connected.value" role="status">連線中，自動投球已停止…</p>
        <p v-else-if="error || store.storageError" role="alert">
          {{ error || store.storageError }}
        </p>
        <AppButton
          v-if="store.pending"
          variant="secondary"
          size="control"
          type="button"
          :disabled="!live.connected.value || submitting || syncing || store.requestInFlight"
          @click="reconcile"
        >
          確認上一筆投注
        </AppButton>
        <AppButton
          v-else-if="error"
          variant="secondary"
          size="control"
          type="button"
          :disabled="syncing"
          @click="load"
          >重試載入</AppButton
        >
      </section>
    </template>
    <BalanceBar
      ref="walletElement"
      class="plinko-wallet"
      :balance="displayedBalance"
      :rolling="walletRolling"
    />
  </main>
</template>

<style scoped lang="scss">
:global(html:has(.plinko-page)),
:global(body:has(.plinko-page)) {
  min-height: 100dvh;
  background: var(--ui-outer-background, #1b283d);
}
.plinko-page {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  padding: env(safe-area-inset-top, 0px) var(--ui-page-gutter)
    max(14px, env(safe-area-inset-bottom, 0px));
  color: #eef4ff;
  background: radial-gradient(ellipse at 50% 0, #273855, #101827 65%, #0b101a);
  gap: 12px;
}
.plinko-header {
  --ui-title-spacing: 0.16em;
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  max-width: 1040px;
  width: 100%;
  margin: 0 auto;
  position: static;
  min-height: 46px;
}
.plinko-layout {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  max-width: 1040px;
  width: 100%;
  margin: 0 auto;
}
.plinko-board-panel {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  min-height: 0;
  min-width: 0;
  border: 1px solid #ffffff12;
  border-radius: 18px;
  background: #07101ddd;
  box-shadow: inset 0 0 40px #78b7ff0b;
  padding: 8px;
}
.plinko-board-viewport {
  // Keep SVG percentage sizing out of the flex/grid track calculation in Safari.
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.plinko-board {
  position: absolute;
  inset: 0;
  width: 100%;
  display: block;
  height: 100%;
  min-height: 0;
}
.pins circle {
  fill: #edf5ff;
  filter: drop-shadow(0 0 1px #fff);
}
.plinko-ball circle {
  fill: #64d9ff;
  stroke: #e6fbff;
  stroke-width: 0.5;
  filter: drop-shadow(0 0 2px #4cd8ff);
}
.plinko-ball.colliding circle {
  fill: #fff1a8;
  stroke: #ffffff;
  filter: drop-shadow(0 0 2.5px #ffdc78);
}
.pin-ripples circle {
  fill: none;
  stroke: #70e5ff;
  stroke-width: 0.3;
  pointer-events: none;
}
.plinko-ball.settled circle {
  fill: #ffcc72;
}
.slots rect {
  fill: #4f9b70;
  stroke: #bfffd6;
  stroke-width: 0.25;
}
.slots rect.hot {
  fill: #cd7a4f;
}
.slots rect.cold {
  fill: #59668f;
}
.legend-heading {
  display: flex;
  justify-content: space-between;
  padding: 6px 4px;
  color: #b8c8df;
  font-size: 12px;
}
.legend-heading span {
  color: #8ca0bc;
  font-size: 11px;
}
.slot-legend-scroll {
  position: relative;
  min-width: 0;
  padding-inline: 20px;
}
.legend-hint {
  position: absolute;
  top: 0;
  bottom: 5px;
  display: flex;
  align-items: center;
  width: 20px;
  color: #7de4ff;
  pointer-events: none;
}
.legend-hint-left {
  left: 0;
  --hint-travel: -3px;
}
.legend-hint-right {
  right: 0;
  --hint-travel: 3px;
}
.legend-hint svg {
  width: 20px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 4px #7de4ff80);
  animation: legend-hint-bounce 1.1s ease-in-out infinite;
}
@keyframes legend-hint-bounce {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(var(--hint-travel));
  }
}
@media (prefers-reduced-motion: reduce) {
  .legend-hint svg {
    animation: none;
  }
}
.slot-legend {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 4px 0 9px;
  scrollbar-color: #48627e #101c2c;
}
.slot-legend > span {
  flex: 0 0 auto;
  min-width: 94px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid #33495f;
  border-radius: 7px;
  background: #172638;
  text-align: center;
}
.slot-legend small {
  color: #8babc5;
  font-size: 10px;
}
.slot-legend strong {
  color: #f2f6fc;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.slot-legend > .landed {
  border-color: #74dcff;
  background: #224e65;
}
.pins circle.hit {
  fill: #ffe5a1;
  filter: drop-shadow(0 0 2px #ffdd78);
}
.plinko-slot.impacting rect {
  fill: #e9b85d;
}
.slots rect.landed {
  stroke: #fff7c5;
  stroke-width: 0.8;
  filter: drop-shadow(0 0 1px #ffdd6c);
}
.slots text {
  fill: white;
  font-size: 2.5px;
  text-anchor: middle;
  font-weight: 700;
}
.plinko-toolbar,
.plinko-bet-action {
  flex: 0 0 auto;
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
}
.plinko-bet-action {
  display: grid;
  grid-template-columns: 144px minmax(0, 1fr);
  gap: 8px;
}
.plinko-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.recent-results {
  flex: 1;
  min-width: 0;
  color: #f1c76b;
  font-variant-numeric: tabular-nums;
}
.recent-results ol {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
}
@media (max-width: 360px) {
  .recent-results ol {
    column-gap: 2px;
    font-size: 10px;
  }
}
.recent-results p {
  margin: 0;
  font-size: 12px;
}
.settings-trigger {
  --ui-radius: 50%;
  --ui-control-bg: #fffffff0;
  --ui-control-text: #19374c;
  --ui-control-border: #ffffff57;
  flex: 0 0 auto;
  box-shadow: 0 6px 14px #0003;
}
.settings-trigger svg {
  width: 24px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.plinko-settings-dialog {
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  border: 1px solid #52647f;
  border-radius: 15px;
  background: #172337;
  color: #eef4ff;
  overscroll-behavior: contain;
}
.plinko-settings-dialog::backdrop {
  background: #030914b8;
  backdrop-filter: blur(4px);
}
.settings-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.settings-heading h2 {
  margin: 0;
  font-size: 18px;
}
.plinko-controls {
  display: grid;
  gap: 9px;
  padding: 13px;
  border: 1px solid #ffffff12;
  border-radius: 15px;
  background: #172337e8;
}
.plinko-controls label {
  display: grid;
  gap: 4px;
  color: #b9c4d4;
  font-size: 12px;
}
.risk-buttons {
  display: grid;
  gap: 5px;
  grid-template-columns: repeat(3, 1fr);
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
legend {
  color: #b9c4d4;
  font-size: 12px;
  padding: 0 0 4px;
}
.plinko-feedback {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 10px;
  color: #ffb0ad;
  font-size: 12px;
}
.plinko-feedback p {
  margin: 0;
}
.plinko-wallet {
  width: 100%;
  max-width: 1040px;
  margin: auto auto 0;
}
.plinko-status {
  flex: 1;
  display: grid;
  place-items: center;
}
</style>
