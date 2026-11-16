<script setup lang="ts">
import AppIcon from "../components/ui/AppIcon.vue";
import AppButton from "../components/ui/AppButton.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import StormSymbol from "../components/StormSymbol.vue";
import StormGuardian from "../components/StormGuardian.vue";
import WinCelebration from "../components/WinCelebration.vue";
import axios from "axios";
import {
  initialStormProgress,
  STORM_LABELS as LABELS,
  STORM_PAY as PAY,
  STORM_STAKES,
  STORM_BALANCED_SETTINGS,
  type StormTile as Tile,
  type StormSpinResult,
} from "@baccarat/contracts";
import { useAuthStore } from "../stores/auth";
import { useStormStore } from "../stores/storm";
import { useLiveChannel } from "../composables/useLiveChannel";
import { usePortraitBlocked } from "../composables/usePortraitGuard";
import { previewBoard, WEIGHTS } from "../lib/storm-demo";
const router = useRouter();
const auth = useAuthStore();
const store = useStormStore();
const portraitBlocked = usePortraitBlocked();
const featureAutoPaused = ref(false);
const mathProfile = computed(() =>
  store.session ? (store.session.mathProfile ?? null) : (store.config?.mathProfile ?? null),
);
const ruleSettings = computed(() => mathProfile.value?.settings ?? STORM_BALANCED_SETTINGS);
const effectivePay = computed(() =>
  mathProfile.value
    ? (Object.fromEntries(
        Object.entries(ruleSettings.value.paytable).map(([kind, pay]) => [kind, pay / 10]),
      ) as Record<keyof typeof PAY, number>)
    : PAY,
);
const maxWinFactor = computed(() => mathProfile.value?.maxWinFactor ?? 25000);
const payScale = computed(() => (mathProfile.value?.payoutScale ?? 1000000) / 1000000);
const rulePay = (value: number) => Number((value * payScale.value).toFixed(6));
const state = ref<StormSpinResult["state"]>({
    ...initialStormProgress(),
    balance: auth.user?.balance ?? 0,
  }),
  board = ref<Tile[]>(previewBoard());
const stake = ref<number>(STORM_STAKES[0]),
  busy = ref(false),
  phase = ref("idle"),
  winning = ref<number[]>([]),
  lastWin = ref(0);
const shownBalance = ref(state.value.balance),
  shownMultiplier = ref(0),
  shownFeatureWin = ref(0);
const status = ref("任意位置 8 個相同符號即可消除"),
  auto = ref(0),
  freeRun = ref(false),
  fast = ref(false);
const rules = ref<HTMLDialogElement | null>(null),
  autoDialog = ref<HTMLDialogElement | null>(null);
const overlayPanel = ref<HTMLElement | null>(null);
const overlay = ref<"intro" | "outro" | "big" | null>(null);
const listedStake = (amount: number) =>
  (STORM_STAKES as readonly number[]).includes(amount) ? amount : STORM_STAKES[0];
const fromRows = ref<Record<number, number>>({}),
  autoCount = ref(10),
  stopSingle = ref(0),
  stopGain = ref(0),
  stopLoss = ref(0);
const upgraded = ref<number[]>([]);
const cappedResult = ref(false);
const awaiting = ref(false);
let autoStart = 0;
let viewGeneration = 0;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let releaseDelay: (() => void) | undefined;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const format = (n: number) => new Intl.NumberFormat("zh-TW").format(Math.round(n));
const canPlay = computed(
  () =>
    !!store.session &&
    !!auth.user &&
    live.connected.value &&
    !store.storageError &&
    (!!store.pending ||
      state.value.freeLeft > 0 ||
      (!!store.config?.enabled && (auth.user?.balance ?? 0) >= stake.value)),
);
const running = computed(() => auto.value > 0 || freeRun.value);
const stakeLocked = computed(
  () =>
    busy.value ||
    running.value ||
    state.value.freeLeft > 0 ||
    !!store.pending ||
    !store.session ||
    !!overlay.value,
);
const stakeIndex = computed(() => STORM_STAKES.findIndex((amount) => amount === stake.value));
function changeStake(direction: -1 | 1) {
  if (stakeLocked.value || stakeIndex.value < 0) return;
  const amount = STORM_STAKES[stakeIndex.value + direction];
  if (amount !== undefined) stake.value = amount;
}
watch(
  portraitBlocked,
  (blocked) => {
    if (!blocked) return;
    auto.value = 0;
    freeRun.value = false;
    featureAutoPaused.value = true;
  },
  { flush: "sync", immediate: true },
);
const isFeature = computed(
  () => state.value.freeLeft > 0 || overlay.value === "outro" || freeRun.value,
);
const multiplierOrbs = computed(() =>
  board.value.flatMap((t, index) => (t.kind === "orb" ? [{ ...t, index }] : [])),
);
function hydrate(force = false) {
  if (!store.session || (busy.value && !force) || disposed) return;
  state.value = { ...store.session.progress, balance: auth.user?.balance ?? 0 };
  stake.value =
    store.pending?.action.amount ??
    (state.value.freeLeft ? store.session.amount : listedStake(store.session.amount));
  board.value = store.lastRound?.result.board ?? previewBoard();
  shownBalance.value = auth.user?.balance ?? 0;
  shownMultiplier.value = state.value.multiplier;
  shownFeatureWin.value = state.value.featureWin;
  lastWin.value = store.lastRound?.result.payout ?? 0;
  status.value =
    store.storageError ||
    (store.pending
      ? "確認上一筆投注結果"
      : !store.config?.enabled && !state.value.freeLeft
        ? "暫停接受新投注"
        : "任意位置 8 個相同符號即可消除");
}
async function synchronize(recover = false) {
  const generation = viewGeneration;
  try {
    await store.refresh();
    if (disposed || generation !== viewGeneration) return;
    hydrate();
    if (recover && store.pending && !busy.value && !store.requestInFlight) void play();
  } catch {
    if (!disposed && generation === viewGeneration && !busy.value)
      status.value = "連線暫時中斷，正在重新同步";
  }
}
const live = useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_user" }),
  onMessage: () => {},
  onConnected: () => synchronize(true),
});
store.transport = live.requestStorm;
watch(
  () => auth.user?.id,
  (id) => {
    viewGeneration++;
    clearTimeout(timer);
    releaseDelay?.();
    releaseDelay = undefined;
    store.bind(id ?? "");
    busy.value = false;
    awaiting.value = false;
    auto.value = 0;
    freeRun.value = false;
    overlay.value = null;
    state.value = { ...initialStormProgress(), balance: auth.user?.balance ?? 0 };
    board.value = previewBoard();
    shownBalance.value = state.value.balance;
    shownMultiplier.value = shownFeatureWin.value = lastWin.value = 0;
    phase.value = "idle";
    status.value = "正在同步遊戲狀態";
  },
  { immediate: true },
);
watch(
  () => auth.user?.balance,
  (balance) => {
    shownBalance.value = balance ?? 0;
  },
);
watch(live.connected, (connected) => {
  if (!connected) {
    auto.value = 0;
    freeRun.value = false;
  }
});
onMounted(() => {
  void synchronize();
});
watch(overlay, async (value) => {
  await nextTick();
  if (disposed) return;
  if (value) overlayPanel.value?.querySelector<HTMLButtonElement>("button")?.focus();
  else document.querySelector<HTMLButtonElement>(".storm-demo .spin-button")?.focus();
});
watch(
  [overlay, canPlay, portraitBlocked, featureAutoPaused],
  ([value, ready, blocked, paused], _previous, onCleanup) => {
    if (value !== "intro" || !ready || blocked || paused) return;
    const generation = viewGeneration;
    // Keep the reading delay independent of animation speed and cancel it with the overlay.
    const startTimer = setTimeout(() => {
      if (generation === viewGeneration) continueFeature();
    }, 3000);
    onCleanup(() => clearTimeout(startTimer));
  },
);
watch(overlay, (value, _previous, onCleanup) => {
  if (value !== "outro") return;
  const generation = viewGeneration;
  const closeTimer = setTimeout(() => {
    if (generation === viewGeneration) finishFeature();
  }, 3000);
  onCleanup(() => clearTimeout(closeTimer));
});
function pause(ms: number, respectSpeed = true) {
  return new Promise<void>((resolve) => {
    releaseDelay = resolve;
    timer = setTimeout(
      () => {
        releaseDelay = undefined;
        resolve();
      },
      respectSpeed ? (reduced.matches ? 1 : fast.value ? ms / 3 : ms) : ms,
    );
  });
}
async function countTo(target: number, duration = 440) {
  const generation = viewGeneration;
  const start = lastWin.value;
  for (let i = 1; i <= 10; i++) {
    await pause(duration / 10);
    if (disposed || generation !== viewGeneration) return;
    lastWin.value = Math.round(start + (target - start) * (1 - (1 - i / 10) ** 3));
  }
}
function place(next: Tile[], initial = false) {
  const old = new Map(board.value.map((t, i) => [t.id, Math.floor(i / 6)]));
  fromRows.value = Object.fromEntries(
    next.map((t, i) => [t.id, initial ? -6 : (old.get(t.id) ?? -1) - Math.floor(i / 6)]),
  );
  board.value = next;
  phase.value = "falling";
}
function stop() {
  auto.value = 0;
  freeRun.value = false;
  status.value = busy.value ? "本回合結束後停止" : "已停止自動";
}
async function play() {
  if (busy.value || disposed || !canPlay.value || overlay.value) return;
  // An uncertain existing action may still be confirmed while landscape blocks new play.
  if (portraitBlocked.value && !store.pending) return;
  if (!portraitBlocked.value && !state.value.freeLeft && !store.pending)
    featureAutoPaused.value = false;
  busy.value = true;
  const generation = viewGeneration;
  const aborted = () => disposed || generation !== viewGeneration;
  try {
    do {
      awaiting.value = true;
      const response = await store.spin(stake.value);
      awaiting.value = false;
      if (aborted()) return;
      if (!response) {
        hydrate(true);
        break;
      }
      const result = response.round.result;
      cappedResult.value = result.capped;
      // Single immutable settlement. Presentation counters never feed back into game math.
      state.value = result.state;
      shownBalance.value = auth.user?.balance ?? result.state.balance;
      lastWin.value = 0;
      winning.value = [];
      upgraded.value = [];
      phase.value = "exiting";
      status.value = "風暴正在聚集";
      await pause(800);
      if (aborted()) return;
      let subtotal = 0;
      for (let i = 0; i < result.frames.length; i++) {
        const frame = result.frames[i]!;
        place(frame.board, i === 0);
        await pause(i === 0 ? 900 : 560);
        if (aborted()) return;
        phase.value = "settled";
        if (!frame.winners.length) continue;
        winning.value = frame.winners;
        phase.value = "winning";
        subtotal += frame.win;
        status.value = `贏得 ${format(subtotal)}`;
        await countTo(subtotal, 540);
        if (aborted()) return;
        await pause(260);
        if (aborted()) return;
        if (result.capped && i === result.frames.length - 1) {
          winning.value = [];
          break;
        }
        phase.value = "clearing";
        await pause(350);
        if (aborted()) return;
        winning.value = [];
      }
      for (let i = 0; i < result.upgrades.length; i++) {
        const upgrade = result.upgrades[i]!;
        phase.value = "settled";
        upgraded.value = [];
        await pause(80);
        if (aborted()) return;
        board.value = board.value.map((t) =>
          t.id === upgrade.id ? { ...t, value: upgrade.to } : t,
        );
        upgraded.value = [upgrade.id];
        phase.value = "upgrading";
        status.value = `倍數升級 ${i + 1} · ×${upgrade.from} → ×${upgrade.to}`;
        await pause(650);
        if (aborted()) return;
      }
      board.value = result.board;
      if (result.bonusWin) {
        phase.value = "bonus";
        status.value = `超級神殿 ${result.bonusCount} 個 · ${format(result.bonusWin)} 點`;
        await pause(1000);
        if (aborted()) return;
      }
      if (result.collected) {
        phase.value = "collecting";
        status.value = `${format(result.baseWin)} × ${result.factor}`;
        await pause(900);
        if (aborted()) return;
      }
      shownMultiplier.value = result.state.multiplier;
      upgraded.value = [];
      phase.value = "counting";
      await countTo(result.payout, 600);
      if (aborted()) return;
      shownBalance.value = auth.user?.balance ?? result.state.balance;
      shownFeatureWin.value = result.state.featureWin;
      status.value = result.payout
        ? `共贏得 ${format(result.payout)}${result.factor > 1 ? " · ×" + result.factor : ""}`
        : "任意位置 8 個相同符號即可消除";
      if (result.awarded && result.wasFree) status.value += ` · 免費 +${result.awarded} 回合`;
      if (result.capped) {
        auto.value = 0;
        freeRun.value = false;
        status.value = `已達 ${format(maxWinFactor.value)} 倍上限 · 本次探索結束`;
      }
      if (result.limited) status.value += " · 已達連消上限";
      // Infinity is only a local run limit; each round still uses the normal server action.
      if (auto.value > 0 && Number.isFinite(auto.value)) auto.value--;
      const net = result.state.balance - autoStart;
      if (
        (stopSingle.value > 0 && result.payout >= stopSingle.value) ||
        (stopGain.value > 0 && net >= stopGain.value) ||
        (stopLoss.value > 0 && -net >= stopLoss.value)
      )
        auto.value = 0;
      if (result.payout >= stake.value * 20) {
        overlay.value = "big";
        // Leave enough time to read the prize, even with reduced motion.
        await pause(fast.value ? 1800 : 3000, false);
        if (aborted()) return;
        overlay.value = null;
      }
      if (result.awarded && !result.wasFree) {
        auto.value = 0;
        freeRun.value = false;
        overlay.value = "intro";
        break;
      }
      if (result.wasFree && !result.state.freeLeft) {
        freeRun.value = false;
        auto.value = 0;
        overlay.value = "outro";
        break;
      }
      await pause(result.payout ? 1100 : 180);
      if (aborted()) return;
      phase.value = "idle";
    } while ((auto.value > 0 || freeRun.value) && canPlay.value && !portraitBlocked.value);
  } catch (error) {
    if (aborted()) return;
    status.value = store.pending
      ? "結果待確認，請按轉動確認原投注"
      : axios.isAxiosError(error)
        ? (error.response?.data?.message ?? "連線中斷，請稍後再試")
        : error instanceof Error
          ? error.message
          : "遊戲暫時無法使用";
    auto.value = 0;
    freeRun.value = false;
  } finally {
    if (!aborted()) {
      busy.value = false;
      awaiting.value = false;
      if (store.session)
        state.value = { ...store.session.progress, balance: auth.user?.balance ?? 0 };
      shownBalance.value = auth.user?.balance ?? 0;
      if (!state.value.freeLeft && !store.pending && !overlay.value)
        stake.value = listedStake(stake.value);
      phase.value = "idle";
      winning.value = [];
      if (!canPlay.value) auto.value = 0;
    }
  }
}
function dismissBigWin() {
  if (overlay.value !== "big") return;
  overlay.value = null;
  clearTimeout(timer);
  releaseDelay?.();
  releaseDelay = undefined;
}
function finishFeature() {
  if (disposed || overlay.value !== "outro") return;
  overlay.value = null;
  shownMultiplier.value = 0;
  stake.value = listedStake(stake.value);
}
function continueFeature() {
  if (
    disposed ||
    portraitBlocked.value ||
    overlay.value !== "intro" ||
    busy.value ||
    !canPlay.value ||
    state.value.freeLeft <= 0
  )
    return;
  overlay.value = null;
  freeRun.value = true;
  void play();
}
function mainAction() {
  if (portraitBlocked.value) return;
  if (running.value) {
    stop();
    return;
  }
  if (state.value.freeLeft) freeRun.value = true;
  void play();
}
function startAuto() {
  if (busy.value || portraitBlocked.value) return;
  autoDialog.value?.close();
  autoStart = auth.user?.balance ?? 0;
  auto.value = autoCount.value;
  void play();
}
onUnmounted(() => {
  disposed = true;
  if (store.transport === live.requestStorm) store.transport = null;
  auto.value = 0;
  freeRun.value = false;
  clearTimeout(timer);
  releaseDelay?.();
});
</script>
<template>
  <main
    class="player-page storm-demo"
    :class="{
      'free-mode': isFeature,
      'reduced-motion': reduced.matches,
      'fast-mode': fast,
      'is-busy': busy,
    }"
  >
    <AppPageHeader
      :inert="!!overlay"
      title="沙海神殿"
      back-label="返回遊戲大廳"
      @back="router.push('/lobby')"
    >
      <template #actions>
        <AppButton variant="ghost" aria-label="開啟遊戲規則" @click="rules?.showModal()">
          規則
        </AppButton>
      </template>
    </AppPageHeader>
    <section class="temple-stage" aria-label="沙海神殿遊戲">
      <div class="scene" aria-hidden="true" />
      <div class="scene-shade" aria-hidden="true" />
      <div class="game-layout" :inert="!!overlay">
        <aside class="side-panel">
          <div class="portrait-guardian" aria-hidden="true" />
          <StormGuardian :active="isFeature" :paused="portraitBlocked" />
          <div class="game-title">
            <small>TEMPLE OF THE DUNES</small>
            <h1>沙海<span>神殿</span></h1>
            <p>日 曜 風 暴</p>
          </div>
          <template v-if="isFeature"
            ><div class="multiplier-badge" :class="{ pulse: phase === 'collecting' }">
              <small>累積倍數</small
              ><strong
                :style="{ '--digits': Math.max(5, format(shownMultiplier).length + 1) }"
                data-testid="multiplier"
                >×{{ shownMultiplier }}</strong
              >
            </div>
            <div class="free-counter" data-testid="free-left">
              <span>免費回合剩餘</span><strong>{{ state.freeLeft }}</strong>
            </div></template
          >
        </aside>
        <div class="game-core">
          <div class="result-banner" aria-live="polite">
            <span>{{ status }}</span>
          </div>
          <div class="reel-frame" :class="phase">
            <div class="corner tl" aria-hidden="true"><AppIcon name="diamond" /></div>
            <div class="corner tr" aria-hidden="true"><AppIcon name="diamond" /></div>
            <div class="corner bl" aria-hidden="true"><AppIcon name="diamond" /></div>
            <div class="corner br" aria-hidden="true"><AppIcon name="diamond" /></div>
            <div
              class="reel-grid"
              data-testid="storm-board"
              role="img"
              aria-label="六欄五列遊戲盤面"
              :aria-busy="busy"
            >
              <div
                v-for="(cell, index) in board"
                :key="cell.id"
                class="symbol-cell"
                :class="[
                  cell.kind,
                  {
                    matched: winning.includes(index),
                    dimmed: winning.length > 0 && !winning.includes(index),
                    upgraded: upgraded.includes(cell.id),
                  },
                ]"
                :style="{
                  '--col': index % 6,
                  '--row': Math.floor(index / 6),
                  '--from': fromRows[cell.id] ?? 0,
                  '--delay': (index % 6) * 65 + 'ms',
                }"
                :aria-label="`${LABELS[cell.kind]}${cell.value ? ' ×' + cell.value : ''}`"
              >
                <div class="symbol-art">
                  <StormSymbol :kind="cell.kind" /><b
                    v-if="cell.kind === 'orb'"
                    class="orb-value"
                    :style="{ '--digits': String(cell.value).length + 1 }"
                    ><span>{{ cell.value }}</span
                    ><small>×</small></b
                  ><span
                    v-if="cell.kind === 'scatter' || cell.kind === 'gold'"
                    class="scatter-label"
                    >{{ cell.kind === "gold" ? "SUPER" : "SCATTER" }}</span
                  >
                </div>
                <i class="hit-frame" /><i class="burst" />
              </div>
            </div>
            <div v-if="phase === 'collecting'" class="orb-flights" aria-hidden="true">
              <b
                v-for="orb in multiplierOrbs"
                :key="orb.id"
                class="flying-orb"
                :style="{
                  '--x': (((orb.index % 6) + 0.5) / 6) * 100 + '%',
                  '--y': ((Math.floor(orb.index / 6) + 0.5) / 5) * 100 + '%',
                }"
                >×{{ orb.value }}</b
              >
            </div>
          </div>
        </div>
        <div class="guardian-space" aria-hidden="true"><span>THE SUN SENTINEL</span></div>
      </div>
      <div class="console" :inert="!!overlay">
        <div class="balance">
          <small>遊戲幣餘額</small
          ><strong
            :style="{ '--digits': Math.max(6, format(shownBalance).length) }"
            data-testid="demo-balance"
            >{{ format(shownBalance) }}</strong
          >
        </div>
        <div class="win-meter">
          <small>{{ isFeature ? "本局獻禮" : "本局派彩" }}</small
          ><strong
            :style="{ '--digits': Math.max(6, format(lastWin).length) }"
            data-testid="last-win"
            >{{ format(lastWin) }}</strong
          >
        </div>
        <div class="stake">
          <label for="demo-stake">每次探索</label
          ><select id="demo-stake" v-model.number="stake" :disabled="stakeLocked">
            <option v-for="n in STORM_STAKES" :key="n" :value="n">{{ n }}</option>
            <option v-if="stake === 20" :value="20">20</option>
          </select>
        </div>
        <div class="spin-controls">
          <button
            class="quick-button"
            :aria-pressed="fast"
            aria-label="快速動畫"
            @click="fast = !fast"
          >
            <AppIcon name="bolt" />
          </button>
          <button
            class="stake-step"
            :class="{ 'at-limit': stakeIndex <= 0 }"
            :disabled="stakeLocked || stakeIndex <= 0"
            aria-label="減少投注金額"
            @click="changeStake(-1)"
          >
            <AppIcon name="minus" />
          </button>
          <button
            class="spin-button"
            :disabled="(busy && !running) || !canPlay || !!overlay"
            :aria-label="
              running
                ? '停止自動'
                : store.pending && !busy
                  ? '確認投注結果'
                  : state.freeLeft
                    ? '開始免費回合'
                    : '開始探索'
            "
            :aria-busy="busy"
            @click="mainAction"
          >
            <AppIcon :name="running ? 'stop' : 'rotate'" /><small>{{
              auto ? auto : freeRun ? "停止" : awaiting ? "確認中" : busy ? "探索中" : "轉動"
            }}</small>
          </button>
          <button
            class="stake-step"
            :class="{ 'at-limit': stakeIndex < 0 || stakeIndex === STORM_STAKES.length - 1 }"
            :disabled="stakeLocked || stakeIndex < 0 || stakeIndex === STORM_STAKES.length - 1"
            aria-label="增加投注金額"
            @click="changeStake(1)"
          >
            <AppIcon name="plus" />
          </button>
          <button
            class="auto-button"
            :disabled="!running && (busy || !canPlay || !!store.pending)"
            :aria-label="running ? '停止自動模式' : '設定自動模式'"
            @click="running ? stop() : autoDialog?.showModal()"
          >
            <AppIcon :name="running ? 'stop' : 'play'" /><small>AUTO</small>
          </button>
        </div>
      </div>
      <div
        v-if="overlay"
        ref="overlayPanel"
        class="feature-overlay"
        :class="{ 'big-win-overlay': overlay === 'big' }"
        role="dialog"
        aria-modal="true"
        :aria-label="
          overlay === 'intro' ? '免費回合開始' : overlay === 'outro' ? '免費回合完成' : 'BIG WIN'
        "
        @keydown.tab.prevent="overlayPanel?.querySelector<HTMLButtonElement>('button')?.focus()"
        @keydown.esc="
          overlay === 'big'
            ? dismissBigWin()
            : overlay === 'outro'
              ? finishFeature()
              : (overlay = null)
        "
      >
        <template v-if="overlay === 'big'">
          <WinCelebration
            class="storm-big-win"
            :style="{ '--prize-digits': format(lastWin).length }"
            tier="big"
            :payout="lastWin"
            :multiplier="lastWin / stake"
            :count="1"
            payout-prefix=""
          />
          <div class="big-win-actions">
            <p>
              {{
                cappedResult
                  ? `${format(maxWinFactor)} 倍封頂 · 本次探索已結束`
                  : "本局派彩 · 遊戲幣"
              }}
            </p>
            <button class="gold-button" @click="dismissBigWin">繼續</button>
          </div>
        </template>
        <template v-else>
          <div class="feature-rays" aria-hidden="true" />
          <div class="feature-card">
            <span class="feature-kicker">TEMPLE OF THE DUNES</span>
            <h2>
              {{
                overlay === "intro"
                  ? state.feature === "super"
                    ? "獲得超級免費回合"
                    : "獲得免費回合"
                  : "神殿探索完成"
              }}
            </h2>
            <strong
              class="feature-number"
              :style="{
                '--digits': Math.max(
                  4,
                  format(overlay === 'intro' ? state.freeLeft : shownFeatureWin).length,
                ),
              }"
              >{{ overlay === "intro" ? state.freeLeft : format(shownFeatureWin) }}</strong
            >
            <p>
              {{
                overlay === "intro"
                  ? canPlay
                    ? "3 秒後自動開始，也可點擊立即開始"
                    : "等待連線恢復後自動開始"
                  : "本輪派發的遊戲幣"
              }}
            </p>
            <button
              v-if="overlay === 'intro'"
              class="gold-button"
              :disabled="busy || !canPlay || state.freeLeft <= 0"
              @click="continueFeature"
            >
              開始免費回合</button
            ><button v-else class="gold-button" @click="finishFeature">返回神殿</button>
          </div>
        </template>
      </div>
    </section>
    <dialog ref="autoDialog" class="settings-dialog" aria-labelledby="auto-title">
      <div class="dialog-heading">
        <h2 id="auto-title">自動模式</h2>
        <button aria-label="關閉自動設定" @click="autoDialog?.close()">
          <AppIcon name="close" />
        </button>
      </div>
      <div class="auto-counts">
        <button
          v-for="n in [10, 50, 100, Infinity]"
          :key="n"
          :aria-pressed="autoCount === n"
          :aria-label="Number.isFinite(n) ? undefined : '無限'"
          @click="autoCount = n"
        >
          <template v-if="Number.isFinite(n)">{{ n }}</template>
          <AppIcon v-else name="infinity" />
        </button>
      </div>
      <h3>停止自動模式</h3>
      <label class="threshold"
        >單局贏得達到<input v-model.number="stopSingle" type="number" min="0" step="10" /></label
      ><label class="threshold"
        >累計淨贏達到<input v-model.number="stopGain" type="number" min="0" step="10" /></label
      ><label class="threshold"
        >累計淨損達到<input v-model.number="stopLoss" type="number" min="0" step="10"
      /></label>
      <p>
        無限不限制回合數，仍適用停止條件。停止條件填 0 表示關閉。觸發免費回合時顯示提示，3
        秒後自動開始；停止後當局仍完整結算。
      </p>
      <button class="gold-button" @click="startAuto">開始自動</button>
    </dialog>
    <dialog ref="rules" class="rules-dialog" aria-labelledby="storm-rules-title">
      <div class="dialog-heading">
        <h2 id="storm-rules-title">探索指南</h2>
        <button autofocus aria-label="關閉遊戲規則" @click="rules?.close()">
          <AppIcon name="close" />
        </button>
      </div>
      <p>
        使用帳戶共用遊戲幣投注，投注與派彩在伺服器一次結算。重新整理會恢復最新盤面與免費回合；未確認的投注會先確認原結果。動畫不改變已結算金額。本遊戲僅供測試幣遊玩。
      </p>
      <h3>消除與結算</h3>
      <p>
        6 欄 × 5 列，任意 8+ 相同符號消除，存留符號依原順序落下，上方補位。8–9 個依下表；10–11 個乘
        {{ mathProfile ? ruleSettings.count10Factor : 2 }}，12+ 乘
        {{ mathProfile ? ruleSettings.count12Factor : 3 }}。每局最多
        {{ mathProfile ? ruleSettings.maxCascades : 12 }} 次消除。
      </p>
      <div class="pay-table">
        <div v-for="(pay, kind) in effectivePay" :key="kind">
          <StormSymbol :kind="kind" /><span>{{ LABELS[kind] }}</span
          ><b>×{{ rulePay(pay / 10) }}</b>
        </div>
      </div>
      <template v-if="mathProfile">
        <h3>
          {{ mathProfile.settings ? "自訂配率 v3" : "平穩型 v2" }} · 目標 RTP
          {{ mathProfile.targetRtp }}%
        </h3>
        <p>
          上表為付費局倍率；免費局基礎倍率為上表除以
          {{
            ruleSettings.freePayDivisor
          }}。只在本局最終派彩四捨五入至分，畫面顯示值不參與計算。目標 RTP
          經離線抽樣校準，並非短期回報保證。
        </p>
        <h3>倍數與免費回合</h3>
        <p>
          任一盤面 {{ ruleSettings.scatterTrigger }}+ 神殿觸發
          {{ ruleSettings.freeInitial }} 回合；免費期間 {{ ruleSettings.scatterRetrigger }}+
          神殿增加 {{ ruleSettings.freeRetrigger }} 回合，系列總授予上限
          {{ ruleSettings.freeMax }}。免費系列保留觸發時的投注額與配率版本。
        </p>
        <p>
          本局有新倍數球且基礎得分大於 0，才套用倍數。當局球值加上免費系列累積值，套用上限
          {{ format(ruleSettings.factorCap) }} 倍；免費系列累積值上限
          {{ format(ruleSettings.accumulatorCap) }}。沒有新球時只派基礎得分。
        </p>
        <p>
          免費局有贏分時，每顆球以 {{ ruleSettings.normalUpgradeChance / 100 }}%（強化
          {{ ruleSettings.superUpgradeChance / 100 }}%）機率加倍，{{
            ruleSettings.upgradeMode === "once" ? "每轉每球最多升級一次" : "成功後可連續升級"
          }}，單球最高 {{ format(ruleSettings.orbMax) }}。{{
            ruleSettings.capScope === "cycle" ? "一次付費局與全部免費回合合計" : "每一轉"
          }}最高 {{ format(maxWinFactor) }} 倍；達上限結束剩餘免費回合。
        </p>
        <p>
          付費局同盤 {{ ruleSettings.scatterTrigger }}+ 神殿且有超級神殿時，1／2／3／4
          個超級神殿分別給
          {{ ruleSettings.superBonus.map((pay) => rulePay(pay / 100)).join("／") }}
          倍獎勵，只計一次，並進入強化之境。一般神殿與超級神殿分開計數。本版不含 JP 或額外投注。
        </p>
        <h3>符號機率</h3>
        <p>
          {{
            Object.entries(ruleSettings.symbolWeights)
              .map(
                ([kind, weight]) => LABELS[kind as keyof typeof LABELS] + " " + weight / 100 + "%",
              )
              .join("、")
          }}。球值 2／3／5／10 的機率分別為
          {{
            Object.values(ruleSettings.orbWeights)
              .map((w) => w / 100 + "%")
              .join("／")
          }}。每局獨立抽選，不依近期輸贏調整機率。
        </p>
      </template>
      <template v-else>
        <h3>倍數與免費回合</h3>
        <p>
          任一盤面 4+ 神殿觸發 15 回合；免費期間 3+ 神殿增加 5 回合，系列總授予上限
          100。維持觸發時探索點數，免費回合自動進行，可隨時停止並稍後繼續。
        </p>
        <p>
          只有本局有新倍數球且基礎得分大於
          0，才收集最終盤面的球並套用累積倍數；沒有新球時只派基礎得分。免費回合總倍數＝本局收集值＋先前累積值；一般回合不保留倍數。
        </p>
        <p>
          免費回合有贏分時，每顆球每次以自訂 20%（強化 60%）機率加倍，可連續升級至
          1000，再收集結算。每局最高派分為探索點數的 25,000
          倍；達上限立即停止本局及剩餘免費回合，派分一次。
        </p>
        <p>
          同盤 4+ 神殿觸發免費回合時，超級神殿 1／2／3／4 個分別給 100／500／5000／25000
          倍獎勵，只計一次；有超級神殿則進入強化之境。一般神殿與超級神殿分開計數，觸發獎勵不加入後續免費系列總分，這兩點為本遊戲的規則。本版不含
          JP 或額外投注。
        </p>
        <h3>符號機率</h3>
        <p>
          {{ WEIGHTS.map(([kind, weight]) => LABELS[kind] + " " + weight + "%").join("、") }}。球值
          2／3／5／10 等機率。每局獨立抽選，目前尚未校準 RTP；不依近期輸贏調整機率。
        </p>
      </template>
    </dialog>
  </main>
</template>
<style scoped>
#bonus-count {
  color: #f6e8c7;
  background: #142c46;
  border: 1px solid #a8915d;
  border-radius: 4px;
  min-height: 28px;
  padding: 2px 8px;
  font: inherit;
}
.storm-demo {
  width: 100%;
  max-width: 430px;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  margin: 0 auto;
  padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px);
  display: flex;
  flex-direction: column;
  gap: 0;
  background: #081827;
  color: #f6e8c7;
  isolation: isolate;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  --ui-title-color: #e8d3a0;
  --speed: 1;
}
.storm-demo:deep(.ui-page-header) {
  padding-inline: var(--ui-page-gutter);
  width: 100%;
  margin: 0;
}
.temple-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  isolation: isolate;
  overflow: hidden;
  background: #1c405e;
}
.scene,
.scene-shade {
  position: absolute;
  inset: 0;
  z-index: -2;
}
.scene {
  background: url("/images/games/storm-temple.webp") 25% center/auto 100% no-repeat;
  transition: filter 1s;
}
.scene-shade {
  z-index: -1;
  background: linear-gradient(#10253b22, #06172999 45%, #071322 100%);
}
.free-mode .scene {
  filter: brightness(0.4) saturate(0.85);
}
.game-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0 12px;
}
.side-panel {
  position: relative;
  flex: 1;
  min-height: 48px;
  isolation: isolate;
}
.portrait-guardian {
  position: absolute;
  inset: 0 -12px 0 25%;
  z-index: -1;
  background: url("/images/games/storm-temple.webp") right 20% / auto 260% no-repeat;
  mask-image: linear-gradient(90deg, transparent, #000 24%);
  opacity: 0.95;
}
.side-panel::before {
  content: "";
  position: absolute;
  inset: 0 -12px;
  z-index: -1;
  background: linear-gradient(90deg, #071d3877, transparent 85%);
}
.game-title {
  position: absolute;
  top: 12px;
  left: 3px;
  z-index: 1;
  text-shadow: 0 1px 4px #061320;
}
.game-title small {
  font-size: 7px;
  letter-spacing: 1px;
}
.game-title h1 {
  font: 800 30px/1.15 serif;
  margin: 6px 0;
  color: #ffe9a2;
  text-shadow:
    0 2px #6e471b,
    0 0 10px #162436;
}
.game-title h1 span {
  display: inline;
}
.game-title p {
  font-size: 9px;
  margin: 7px 0;
  color: #e5f6ff;
  letter-spacing: 2px;
}
.feature-button {
  position: absolute;
  bottom: 12px;
  left: 0;
  width: 145px;
  padding: 8px 5px;
  border: 2px ridge #d7aa58;
  background: linear-gradient(#1c5289, #092242);
  color: #d5f8ff;
  font-weight: 800;
  font-size: 11px;
  border-radius: 5px;
}
.feature-button small {
  display: block;
  font-size: 8px;
  letter-spacing: 0.5px;
  margin-top: 3px;
  font-weight: 400;
  color: #e4d6b7;
}
.side-caption,
.guardian-space {
  display: none;
}
.free-mode .game-title {
  display: none;
}
.multiplier-badge {
  position: absolute;
  left: 8px;
  top: 12px;
  width: 80px;
  height: 80px;
  border: 4px ridge #eac673;
  border-radius: 50%;
  background: radial-gradient(#226f9c, #10264a 60%, #0b142a);
  box-shadow: 0 0 18px #58b4e04d;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.multiplier-badge small {
  font-size: 9px;
}
.multiplier-badge strong {
  font: 900 clamp(12px, calc(110px / var(--digits, 5)), 27px)/1.3 Georgia;
  color: #fff0a4;
  white-space: nowrap;
}
.multiplier-badge.pulse {
  animation: upgrade calc(0.8s * var(--speed));
}
.free-counter {
  position: absolute;
  bottom: 14px;
  left: 8px;
  width: 80px;
  text-align: center;
}
.free-counter span {
  font-size: 9px;
  display: block;
}
.free-counter strong {
  font: 900 32px/1.1 Georgia;
  color: #ffdc7d;
}
.game-core {
  flex: none;
  min-width: 0;
  width: min(100%, calc((100dvh - 330px) * 1.2));
  align-self: center;
}
.result-banner {
  position: relative;
  z-index: 2;
  min-height: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px 12px;
  margin: 0 5% -2px;
  background: linear-gradient(#172549, #243e75 50%, #101833);
  border: 2px ridge #dfbd77;
  clip-path: polygon(0 0, 100% 0, 97% 50%, 100% 100%, 0 100%, 3% 50%);
}
.result-banner span {
  font-size: 11px;
  line-height: 12px;
  font-weight: 700;
  text-align: center;
  color: #ffe6a9;
  text-shadow: 0 1px 2px #1a0a00;
  overflow-wrap: anywhere;
  min-width: 0;
}
.reel-frame {
  position: relative;
  padding: 3px;
  border: 4px ridge #e6bd70;
  background: linear-gradient(120deg, #fff0b0, #916127 30%, #ffe69d 55%, #8e591a 80%, #fff2ae);
  box-shadow:
    0 0 0 1px #764c20,
    0 4px 10px #06132699;
  z-index: 1;
}
.corner {
  position: absolute;
  z-index: 3;
  color: #ffe5a0;
  font-size: 14px;
  text-shadow: 0 1px #76501e;
  line-height: 1;
}
.tl {
  left: -8px;
  top: -8px;
}
.tr {
  right: -8px;
  top: -8px;
}
.bl {
  left: -8px;
  bottom: -8px;
}
.br {
  right: -8px;
  bottom: -8px;
}
.reel-grid {
  position: relative;
  aspect-ratio: 6/5;
  background: repeating-linear-gradient(
    90deg,
    #1c2633 0%,
    #1b2635 16.4%,
    #0006 16.5%,
    #1c2633 16.6667%
  );
  box-shadow: inset 0 0 14px #0009;
  overflow: hidden;
}
.symbol-cell {
  position: absolute;
  left: calc(var(--col) * 100% / 6);
  top: calc(var(--row) * 20%);
  width: calc(100% / 6);
  height: 20%;
  padding: 2px;
  will-change: transform;
}
.symbol-art {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  transition:
    filter 0.12s,
    opacity 0.12s;
}
.symbol-art:deep(.storm-symbol) {
  width: 85%;
  height: 85%;
}
.symbol-cell.dimmed .symbol-art {
  filter: brightness(0.35);
  opacity: 0.75;
}
.orb-value {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff5a2;
  text-shadow: 0 2px 2px #241000;
  font:
    900 min(22px, calc(50px / var(--digits, 2)))/1 Georgia,
    serif;
  filter: drop-shadow(0 0 4px #edb83d);
}
.orb-value > * {
  display: block;
  line-height: 1;
}
.orb-value small {
  font-size: 0.6em;
}
.scatter-label {
  position: absolute;
  bottom: 5%;
  font: 800 6px/1 sans-serif;
  letter-spacing: 0.2px;
  color: #fff2bc;
  text-shadow: 0 1px #422913;
}
.hit-frame,
.burst {
  position: absolute;
  inset: 4px;
  opacity: 0;
  pointer-events: none;
}
.matched .hit-frame {
  opacity: 1;
  border: 2px solid #d2f9ff;
  box-shadow:
    inset 0 0 7px #4daaff,
    0 0 7px #4f9bff;
  background: linear-gradient(140deg, #9be7ff33, transparent 60%);
}
.winning .matched .symbol-art {
  animation: hit calc(0.7s * var(--speed)) ease-in-out infinite;
}
.clearing .matched .symbol-art {
  animation: shatter calc(0.35s * var(--speed)) ease-in forwards;
}
.clearing .matched .hit-frame {
  animation: shatter calc(0.3s * var(--speed)) ease-in forwards;
}
.clearing .matched .burst {
  opacity: 1;
  background: repeating-conic-gradient(
    from 15deg,
    transparent 0 21deg,
    #d5f4ff 23deg 25deg,
    transparent 28deg 45deg
  );
  mask-image: radial-gradient(transparent 0 20%, #000 30% 40%, transparent 70%);
  animation: burst calc(0.35s * var(--speed)) ease-out forwards;
}
.exiting .symbol-cell {
  animation: exit calc(0.45s * var(--speed)) cubic-bezier(0.5, 0, 1, 0.6) both;
  animation-delay: calc(var(--delay) * var(--speed));
}
.falling .symbol-cell {
  animation: drop calc(0.5s * var(--speed)) cubic-bezier(0.2, 0.6, 0.3, 1.1) both;
  animation-delay: calc(var(--delay) * var(--speed));
}
.upgrading .upgraded .symbol-art {
  animation: upgrade calc(0.8s * var(--speed)) ease-in-out;
}
.collecting .orb .symbol-art {
  opacity: 0.3;
}
.orb-flights {
  position: absolute;
  inset: 3px;
  pointer-events: none;
  z-index: 8;
}
.flying-orb {
  position: absolute;
  left: var(--x);
  top: var(--y);
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(#ffffb9, #ab6b0c);
  color: #45230c;
  border: 2px solid #ffffb4;
  box-shadow: 0 0 15px #ffda63;
  font: 900 14px Georgia;
  animation: collect calc(0.85s * var(--speed)) cubic-bezier(0.3, 0.1, 0.3, 1) forwards;
}
.board-caption {
  display: none;
}
.console {
  flex: none;
  height: 110px;
  padding: 5px 12px 3px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: 35px 67px;
  gap: 0;
  background: linear-gradient(#081b30d9, #061322);
  border-top: 1px solid #cda96466;
  position: relative;
  z-index: 4;
}
.balance,
.win-meter,
.stake {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 0;
}
.balance small,
.win-meter small,
.stake label {
  font-size: 8px;
  color: #bbc8d4;
  line-height: 1;
  white-space: nowrap;
}
.balance strong,
.win-meter strong {
  display: block;
  width: 100%;
  text-align: center;
  font-size: clamp(10px, calc(135px / var(--digits, 6)), 20px);
  line-height: 1.1;
  color: #fff3d3;
  white-space: nowrap;
}
.win-meter strong {
  color: #ffe18b;
}
.stake select {
  appearance: none;
  -webkit-appearance: none;
  font-size: 18px;
  line-height: 1;
  background: #10243a;
  color: #fff1c9;
  border: 0;
  padding: 0 3px;
  width: 68px;
  max-width: 100%;
  height: 23px;
  text-align: center;
  text-align-last: center;
  cursor: pointer;
}
.spin-controls {
  grid-column: 1/-1;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.quick-button,
.stake-step,
.auto-button {
  background: #0d263d;
  color: #edce83;
  border: 1px solid #be974d;
  border-radius: 50%;
  width: 38px;
  height: 38px;
  flex: none;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.quick-button,
.stake-step {
  font-size: 23px;
  line-height: 1;
}
.quick-button[aria-pressed="true"] {
  background: #c49837;
  color: #111d2b;
}
.auto-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  line-height: 1;
}
.auto-button small {
  font-size: 6px;
  letter-spacing: 0.5px;
  margin-top: 1px;
}
.spin-button {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  flex: none;
  border: 4px ridge #ffdb75;
  border-radius: 50%;
  background: radial-gradient(at 35% 20%, #bc7c2a, #6c370c 60%, #281308);
  color: #fff0b1;
  box-shadow: 0 2px 8px #0009;
  font-weight: 800;
  margin: 0;
  padding: 0;
}
.spin-controls :deep(.app-icon::before) {
  display: block;
}
.spin-button > .app-icon {
  font-size: 30px;
  line-height: 1;
  display: block;
}
.spin-button > small {
  font-size: 7px;
  line-height: 1;
  margin-top: 2px;
}
.feature-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  background: #020c23ec;
  min-width: 0;
  min-height: 0;
  overflow: clip;
  contain: paint;
  padding: 12px;
}
.feature-rays {
  position: absolute;
  inset: 0;
  overflow: clip;
  pointer-events: none;
}
.feature-rays::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 170%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  background: repeating-conic-gradient(
    from 15deg,
    transparent 0deg 12deg,
    #87d6e622 14deg 19deg,
    transparent 22deg 30deg
  );
  animation: rays 35s linear infinite;
  mask-image: radial-gradient(#000, transparent 65%);
}
.big-win-overlay {
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 16px;
  background: #051221d9;
}
.big-win-overlay .storm-big-win {
  position: relative;
  inset: auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: clip;
}
.storm-big-win:deep(.win-copy) {
  padding: 8px;
  transform: none;
  animation: storm-prize-enter 750ms cubic-bezier(0.16, 0.8, 0.3, 1) both;
}
.storm-big-win:deep(.win-crown) {
  width: clamp(28px, 12cqh, 62px);
  height: clamp(18px, 7cqh, 34px);
}
.storm-big-win:deep(.win-title) {
  font-size: clamp(24px, min(14cqw, 14cqh), 64px);
}
.storm-big-win:deep(.win-multiplier) {
  font-size: clamp(18px, min(8cqw, 12cqh), 32px);
  margin-top: min(12px, 3cqh);
}
.storm-big-win:deep(.win-payout) {
  font-size: clamp(20px, min(calc(140cqw / var(--prize-digits, 4)), 14cqh), 64px);
  line-height: 1.2;
  white-space: nowrap;
}
.big-win-actions {
  position: relative;
  width: 100%;
  min-width: 0;
  z-index: 4;
  text-align: center;
}
.big-win-actions p {
  margin: 0;
  font-size: 12px;
  color: #ffe9b3;
}
.big-win-actions .gold-button {
  margin-top: 12px;
}
.feature-card {
  text-align: center;
  z-index: 1;
  padding: 16px 6px;
  width: 100%;
  min-width: 0;
  max-width: 360px;
  color: #ffebad;
  text-shadow: 0 2px 3px #351b0c;
}
.feature-kicker {
  font-size: 8px;
  letter-spacing: 2px;
  color: #c4ecff;
}
.feature-card h2 {
  font: 900 28px/1.25 serif;
  margin: 16px 0;
  overflow-wrap: anywhere;
}
.feature-number {
  display: block;
  width: 100%;
  font: 900 clamp(22px, calc(350px / var(--digits, 4)), 88px)/1.2 Georgia;
  white-space: nowrap;
  background: linear-gradient(#fff8c5, #f7c94f 50%, #b47722);
  background-clip: text;
  color: transparent;
  text-shadow: none;
  filter: drop-shadow(0 3px #603d0d);
}
.feature-card p {
  font-size: 12px;
  margin: 18px 0 10px;
}
.feature-card > small {
  display: block;
  color: #b6cdd7;
  font-size: 9px;
  margin-bottom: 16px;
  line-height: 1.5;
}
.gold-button {
  display: block;
  margin: 18px auto 0;
  padding: 10px 24px;
  max-width: 100%;
  background: linear-gradient(#f2cf74, #b77b23);
  border: 2px ridge #ffe6a0;
  color: #251607;
  border-radius: 5px;
  font-size: 14px;
  font-weight: 800;
}
.settings-dialog,
.rules-dialog {
  box-sizing: border-box;
  border: 1px solid #b5965c;
  border-radius: 10px;
  background: #0d1b2d;
  color: #d8e4e9;
  width: calc(100% - 24px);
  max-width: 406px;
  max-height: calc(100dvh - 32px);
  padding: 18px;
  box-shadow: 0 12px 80px #0009;
  overflow: auto;
  overscroll-behavior: contain;
}
.settings-dialog::backdrop,
.rules-dialog::backdrop {
  background: #020916c9;
}
.dialog-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  position: sticky;
  top: -18px;
  background: #0d1b2d;
  padding-block: 5px;
  z-index: 1;
}
.dialog-heading h2 {
  font-size: 18px;
  margin: 0;
  color: #f6dc9e;
  min-width: 0;
}
.dialog-heading button {
  background: transparent;
  color: #c4cdd4;
  border: 0;
  padding: 5px;
  font-size: 18px;
  flex: none;
}
.settings-dialog p,
.rules-dialog p,
.rules-dialog li {
  font-size: 11px;
  line-height: 1.7;
  color: #b5c5d1;
  overflow-wrap: anywhere;
}
.settings-dialog h3,
.rules-dialog h3 {
  font-size: 13px;
  color: #eed2a2;
  margin-top: 18px;
}
.auto-counts {
  display: flex;
  gap: 7px;
  margin: 18px 0;
}
.auto-counts button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  flex: 1;
  border: 1px solid #4e5e6e;
  background: #243446;
  color: #eee;
  padding: 10px 4px;
  border-radius: 4px;
  font-size: 13px;
}
.auto-counts .app-icon {
  font-size: 20px;
}
.auto-counts button[aria-pressed="true"] {
  border-color: #f1c66a;
  color: #ffe4a1;
  background: #534225;
}
.threshold {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  padding: 7px 0;
}
.threshold input {
  width: 90px;
  min-width: 0;
  background: #15283b;
  color: #fff;
  border: 1px solid #4e5e6e;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
}
.feature-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.feature-options button {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  border: 2px ridge #c7a560;
  background: radial-gradient(#283d63, #091931);
  color: #ffe6b0;
  padding: 14px 5px;
  white-space: normal;
}
.feature-options:deep(.storm-symbol) {
  width: 55px;
  height: 55px;
}
.feature-options strong {
  font-size: 14px;
}
.feature-options span {
  font-size: 9px;
  line-height: 1.5;
  color: #bbcdd8;
}
.pay-table {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.pay-table > div {
  display: flex;
  align-items: center;
  font-size: 9px;
  gap: 5px;
  background: #172a3b;
  padding: 4px;
  min-width: 0;
}
.pay-table:deep(.storm-symbol) {
  width: 25px;
  height: 25px;
  flex: none;
}
.pay-table b {
  margin-left: auto;
  color: #f4d08a;
}
.rules-dialog a {
  font-size: 11px;
  color: #a3d8ed;
}
.reset-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
}
.reset-actions button {
  margin: 10px 0 0;
  padding: 9px 17px;
}
.cancel-button {
  border: 1px solid #788b9d;
  background: #1a3048;
  color: #d9e6f0;
  border-radius: 5px;
  font-size: 13px;
}
button {
  cursor: pointer;
  font-family: inherit;
  transition: none;
  white-space: nowrap;
}
button:disabled {
  cursor: default;
  opacity: 0.55;
}
.is-busy .spin-button:disabled,
.is-busy .auto-button:disabled,
.is-busy .stake-step:disabled:not(.at-limit),
.is-busy .stake select:disabled {
  opacity: 1;
}
button:focus,
button:focus-visible,
select:focus,
select:focus-visible {
  outline: none;
  box-shadow: none;
}
button:active:not(:disabled) {
  filter: brightness(0.88);
}
.fast-mode {
  --speed: 0.3333;
}
@keyframes exit {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(600%);
    opacity: 0.4;
  }
}
@keyframes drop {
  from {
    transform: translateY(calc(var(--from) * 100%));
    filter: blur(2px);
  }
  to {
    transform: translateY(0);
    filter: blur(0);
  }
}
@keyframes hit {
  50% {
    transform: scale(1.08);
    filter: brightness(1.4);
  }
}
@keyframes shatter {
  30% {
    transform: scale(1.1);
    filter: brightness(3);
  }
  to {
    transform: scale(0.1);
    opacity: 0;
  }
}
@keyframes burst {
  from {
    transform: scale(0.4);
    opacity: 1;
  }
  to {
    transform: scale(2.2);
    opacity: 0;
  }
}
@keyframes collect {
  0% {
    transform: translate(-50%, -50%) scale(1);
  }
  30% {
    transform: translate(-50%, -50%) scale(1.3);
  }
  100% {
    left: 18%;
    top: -17%;
    transform: translate(-50%, -50%) scale(0.2);
    opacity: 0;
  }
}
@keyframes upgrade {
  50% {
    transform: scale(1.2);
    filter: brightness(2);
  }
}
@keyframes rays {
  from {
    transform: translate(-50%, -50%) rotate(0deg);
  }
  to {
    transform: translate(-50%, -50%) rotate(360deg);
  }
}
@keyframes storm-prize-enter {
  from {
    opacity: 0;
    transform: scale(0.78);
  }
  65% {
    opacity: 1;
    transform: scale(1);
  }
  82% {
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@media (max-height: 700px) {
  .game-title {
    top: 8px;
    left: 2px;
  }
  .game-title small {
    font-size: 6px;
  }
  .game-title h1 {
    font-size: 24px;
    margin: 3px 0;
  }
  .game-title h1 span {
    display: inline;
  }
  .game-title p {
    font-size: 7px;
    margin: 3px 0;
  }
  .feature-button {
    left: auto;
    right: 0;
    bottom: 10px;
    width: 135px;
    font-size: 10px;
    padding: 7px 4px;
  }
  .portrait-guardian {
    inset: 0 -12px 0 20%;
    opacity: 0.65;
  }
  .multiplier-badge {
    left: 3px;
    top: 50%;
    transform: translateY(-50%);
    width: 53px;
    height: 53px;
    border-width: 3px;
  }
  .multiplier-badge small {
    font-size: 7px;
  }
  .multiplier-badge strong {
    font-size: clamp(10px, calc(75px / var(--digits, 5)), 20px);
  }
  .free-counter {
    left: 70px;
    bottom: auto;
    top: 50%;
    transform: translateY(-50%);
    width: 70px;
  }
  .free-counter span {
    font-size: 8px;
  }
  .free-counter strong {
    font-size: 26px;
  }
  .feature-card h2 {
    font-size: 25px;
  }
  .feature-card p {
    font-size: 11px;
  }
  .multiplier-badge.pulse {
    animation: none;
  }
}
@media (max-height: 650px) {
  .game-title p {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .feature-rays::before {
    animation: none;
  }
  .storm-demo * {
    animation: none !important;
    transition: none !important;
  }
  .exiting .symbol-cell,
  .clearing .matched .symbol-art {
    opacity: 0;
  }
  .flying-orb {
    display: none;
  }
}
:global(body:has(.storm-demo)) {
  min-width: 320px;
  background: #06111e;
}
:global(#app:has(.storm-demo)) {
  width: 100% !important;
  max-width: none !important;
  background: #06111e;
}
</style>
