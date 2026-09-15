<script setup lang="ts">
import AppSelect from "../components/ui/AppSelect.vue";
import AppButton from "../components/ui/AppButton.vue";
import StakeControl from "../components/ui/StakeControl.vue";
import BalanceBar from "../components/ui/BalanceBar.vue";
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import axios from "axios";
import { useRouter } from "vue-router";
import { useLiveChannel } from "../composables/useLiveChannel";
import { formatMoney } from "../lib/money";
import { useAuthStore } from "../stores/auth";
import { isValidMinesStake, useMinesStore } from "../stores/mines";

const router = useRouter();
const authStore = useAuthStore();
const minesStore = useMinesStore();
const amount = ref(100);
const mineCount = ref(3);
const loading = ref(true);
const pending = ref(false);
const synchronizing = ref(false);
const controlsBusy = computed(
  () =>
    !live.connected.value || pending.value || synchronizing.value || Boolean(minesStore.pending),
);
let activeOperation: Promise<void> | null = null;
const error = ref("");
const walletElement = ref<InstanceType<typeof BalanceBar> | null>(null);
let disposed = false;
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
const round = computed(() => minesStore.round);
const config = computed(() => minesStore.config);
const cells = Array.from({ length: 25 }, (_, index) => index);
const canCashout = computed(
  () => round.value?.status === "ACTIVE" && round.value.revealedCells.length > 0,
);
const statusLabel = computed(() =>
  round.value?.status === "LOST"
    ? "踩到地雷"
    : round.value?.status === "CASHED_OUT"
      ? "已收款"
      : "進行中",
);
const isActive = computed(() => round.value?.status === "ACTIVE");
const selectedAmount = computed({
  get: () => (isActive.value ? round.value!.amount : amount.value),
  set: (value: number) => {
    amount.value = value;
  },
});
const selectedMines = computed({
  get: () => (isActive.value ? round.value!.mineCount : mineCount.value),
  set: (value: number) => {
    mineCount.value = value;
  },
});
const nextMultiplier = computed(() =>
  round.value ? round.value.nextMultiplier : (0.95 * 25) / (25 - mineCount.value),
);
const userId = computed(() => authStore.user?.id ?? "");
let restorePromise: Promise<void> | null = null;

function apiError(errorValue: unknown, fallback: string) {
  return axios.isAxiosError(errorValue)
    ? (errorValue.response?.data?.message ?? fallback)
    : fallback;
}
// A response from an uncertain mutation may arrive after a newer live snapshot.
async function refreshWallet() {
  await authStore.fetchMe({ preserveNewerLiveSnapshot: true });
}
async function runOperation(operation: () => Promise<unknown>, fallback: string) {
  clearWalletWarning();
  pending.value = true;
  error.value = "";
  const running = (async () => {
    try {
      await operation();
    } catch (cause) {
      if (isInsufficientBalance(cause)) warnInsufficientBalance();
      else error.value = apiError(cause, fallback);
    } finally {
      pending.value = false;
    }
  })();
  activeOperation = running;
  await running;
  if (activeOperation === running) activeOperation = null;
}
async function start() {
  if (!userId.value || controlsBusy.value || !config.value?.enabled) return;
  if (!isValidMinesStake(amount.value, config.value)) {
    error.value = "投注額需為 100 至 5,000 幣，並以 100 幣遞增。";
    return;
  }
  if ((authStore.user?.balance ?? 0) < amount.value) {
    warnInsufficientBalance();
    return;
  }
  await runOperation(
    () => minesStore.start(userId.value, amount.value, mineCount.value),
    "開局結果尚未確認，請重試上一個操作。",
  );
}
async function reveal(cellIndex: number) {
  if (
    !userId.value ||
    !round.value ||
    round.value.status !== "ACTIVE" ||
    round.value.revealedCells.includes(cellIndex) ||
    controlsBusy.value
  )
    return;
  const id = round.value.id;
  await runOperation(
    () => minesStore.reveal(userId.value, id, cellIndex),
    "翻格結果尚未確認，請重試上一個操作。",
  );
}
async function cashout() {
  if (!userId.value || !round.value || !canCashout.value || controlsBusy.value) return;
  const id = round.value.id;
  await runOperation(
    () => minesStore.cashout(userId.value, id),
    "收款結果尚未確認，請重試上一個操作。",
  );
}
async function retryPending() {
  if (!userId.value || pending.value || synchronizing.value) return;
  await runOperation(async () => {
    await minesStore.reconcilePending(userId.value);
    await refreshWallet();
  }, "仍無法確認上一個操作，請稍後重試。");
}
function cellClass(cell: number) {
  if (!round.value) return "";
  if (round.value.status !== "ACTIVE" && round.value.mineCells?.includes(cell)) return "mine";
  if (round.value.revealedCells.includes(cell)) return "safe";
  return "";
}
function cellLabel(cell: number) {
  const currentRound = round.value;
  if (currentRound && currentRound.status !== "ACTIVE" && currentRound.mineCells?.includes(cell))
    return "地雷";
  if (currentRound?.revealedCells.includes(cell)) return "安全格";
  return `翻開第 ${cell + 1} 格`;
}

async function restoreMinesState() {
  if (restorePromise) return restorePromise;
  synchronizing.value = true;
  restorePromise = (async () => {
    // A reconnect must not replace an in-flight mutation with an older read.
    if (activeOperation) await activeOperation;
    if (!userId.value) return;
    minesStore.restorePending(userId.value);
    if (minesStore.pending) await minesStore.reconcilePending(userId.value);
    else {
      const previousRoundId = minesStore.round?.id;
      const active = await minesStore.fetchActive();
      if (!active && previousRoundId) await minesStore.fetchRound(previousRoundId);
    }
    await refreshWallet();
    error.value = "";
  })().finally(() => {
    restorePromise = null;
    synchronizing.value = false;
  });
  return restorePromise;
}

const live = useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_user" }),
  onMessage: () => {},
  onConnected: () =>
    restoreMinesState().catch(() => {
      error.value = "遊戲同步失敗，請重試載入。";
    }),
});
minesStore.transport = live.requestMines;
onMounted(async () => {
  try {
    if (!userId.value) return;
    await minesStore.fetchConfig();
    await restoreMinesState();
  } catch {
    error.value = "Mines 資料載入失敗，請重新整理後再試。";
  } finally {
    loading.value = false;
  }
});
watch(userId, clearWalletWarning);
onUnmounted(() => {
  if (minesStore.transport === live.requestMines) minesStore.transport = null;
  disposed = true;
  clearWalletWarning();
});
</script>

<template>
  <main class="player-page mines-page">
    <AppPageHeader class="mines-header" back-label="返回遊戲選擇" @back="router.push('/lobby')"
      ><span class="brand-spark" aria-hidden="true">✦</span> Mines</AppPageHeader
    >
    <p v-if="loading" class="mines-status" role="status">載入遊戲中…</p>
    <template v-else>
      <section class="game-summary" aria-label="本局倍率與派彩" aria-live="polite">
        <div>
          <span>目前倍率</span
          ><strong>{{ round ? round.multiplier.toFixed(4) + "×" : "—" }}</strong>
        </div>
        <div class="next-multiplier">
          <span>下一格</span
          ><strong>{{ nextMultiplier !== null ? nextMultiplier.toFixed(4) + "×" : "—" }}</strong>
        </div>
        <div>
          <span>{{ round && !isActive ? "本局派彩" : "可收款" }}</span
          ><strong>{{
            formatMoney(round ? (isActive ? round.cashoutAmount : round.payout) : 0)
          }}</strong>
        </div>
      </section>
      <section class="board-panel">
        <div
          class="mines-board"
          :aria-label="round ? `Mines 棋盤，${statusLabel}` : 'Mines 棋盤，尚未開局'"
          :aria-busy="controlsBusy"
        >
          <button
            v-for="cell in cells"
            :key="cell"
            type="button"
            class="mine-cell"
            :class="cellClass(cell)"
            :disabled="!isActive || round?.revealedCells.includes(cell) || controlsBusy"
            :aria-label="cellLabel(cell)"
            @click="reveal(cell)"
          >
            <svg
              v-if="cellClass(cell) === 'safe'"
              class="cell-icon diamond"
              viewBox="0 0 48 48"
              aria-hidden="true"
            >
              <path d="M11 9h26l8 12-21 23L3 21Z" fill="currentColor" />
              <path
                d="m11 9 5 12 8-12 8 12 5-12M3 21h42M16 21l8 23 8-23"
                fill="none"
                stroke="#fff"
                stroke-opacity=".55"
                stroke-width="1.5"
              />
            </svg>
            <svg
              v-else-if="cellClass(cell) === 'mine'"
              class="cell-icon"
              viewBox="0 0 48 48"
              aria-hidden="true"
            >
              <path
                d="m31 15 4-4m-3-5 5 1 3-4m-1 9 5 1"
                fill="none"
                stroke="#ffc489"
                stroke-width="3"
                stroke-linecap="round"
              />
              <circle cx="22" cy="28" r="15" fill="currentColor" />
              <path
                d="M13 26a9 9 0 0 1 7-7"
                fill="none"
                stroke="#fff"
                stroke-opacity=".5"
                stroke-width="3"
                stroke-linecap="round"
              />
            </svg>
            <span v-else class="cell-mark" aria-hidden="true">✦</span>
          </button>
        </div>
      </section>
      <section class="mines-controls" aria-label="投注設定">
        <StakeControl
          v-model="selectedAmount"
          compact-landscape
          :disabled="controlsBusy || isActive"
        />
        <div class="mine-settings">
          <label for="mine-count">地雷數</label>
          <div class="mine-presets">
            <AppButton
              v-for="value in [3, 5, 10, 20]"
              :key="value"
              variant="secondary"
              size="control"
              type="button"
              :aria-label="`${value} 顆地雷`"
              :aria-pressed="selectedMines === value"
              :disabled="controlsBusy || isActive"
              @click="mineCount = value"
            >
              {{ value }}
            </AppButton>
          </div>
          <AppSelect
            id="mine-count"
            v-model.number="selectedMines"
            :disabled="controlsBusy || isActive"
          >
            <option v-if="isActive && selectedMines < 3" :value="selectedMines">
              {{ selectedMines }}
            </option>
            <option v-for="value in 22" :key="value + 2" :value="value + 2">{{ value + 2 }}</option>
          </AppSelect>
        </div>
        <AppButton
          v-if="!isActive"
          variant="primary"
          size="action"
          class="button-primary"
          type="button"
          :disabled="controlsBusy || !config?.enabled"
          @click="start"
        >
          {{
            pending ? "處理中…" : !config?.enabled ? "暫停開放" : round ? "再玩一局" : "開始遊戲"
          }}
        </AppButton>
        <AppButton
          v-else
          variant="primary"
          size="action"
          class="button-primary cashout-button"
          type="button"
          :disabled="controlsBusy || !canCashout"
          @click="cashout"
        >
          {{
            pending
              ? "處理中…"
              : canCashout
                ? `收款 ${formatMoney(round?.cashoutAmount)}`
                : "翻開一格後收款"
          }}
        </AppButton>
      </section>
      <div
        v-if="!live.connected.value || error || (minesStore.pending && !pending && !synchronizing)"
        class="mines-feedback"
      >
        <p v-if="!live.connected.value" role="status">連線中，正在同步遊戲…</p>
        <p v-else-if="error" class="mines-error" role="alert">{{ error }}</p>
        <AppButton
          v-if="minesStore.pending"
          variant="secondary"
          size="control"
          class="button-secondary retry-pending"
          type="button"
          :disabled="!live.connected.value || pending || synchronizing"
          @click="retryPending"
        >
          重試上一個操作
        </AppButton>
        <AppButton
          v-else-if="error"
          variant="secondary"
          size="control"
          class="button-secondary"
          type="button"
          :disabled="!live.connected.value || pending || synchronizing"
          @click="
            restoreMinesState()
              .then(() => (error = ''))
              .catch(() => (error = '遊戲同步失敗，請稍後重試。'))
          "
        >
          重試載入
        </AppButton>
      </div>
    </template>
    <BalanceBar ref="walletElement" class="mines-wallet" :balance="authStore.user?.balance" />
  </main>
</template>

<style scoped lang="scss">
:global(body:has(.mines-page)) {
  background: #171b23;
}

.mines-page {
  --mines-muted: #a5adb9;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  gap: 8px;
  padding: env(safe-area-inset-top, 0px) 16px max(8px, env(safe-area-inset-bottom, 0px));
  color: #f3f4f7;
  background: radial-gradient(ellipse at 50% 15%, #303743 0, #1b2029 55%, #171b23 100%);
}
// Reserve the controls first; the board takes exactly the remaining viewport height.
.mines-page > * {
  flex-shrink: 0;
}
.mines-header {
  --ui-title-spacing: 0.12em;
  --ui-title-transform: uppercase;
  position: static;
  min-height: 46px;
}

.brand-spark {
  color: #f5ac69;
}
.coin-tag {
  margin-left: 4px;
  font-size: 10px;
  color: #818b99;
}
.mines-wallet {
  margin-top: auto;
}
.game-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  text-align: center;
}
.game-summary > div {
  min-width: 0;
  padding: 7px 2px;
  border: 1px solid #ffffff0c;
  border-radius: 8px;
  background: #171b2380;
}
.game-summary span {
  display: block;
  font-size: 10px;
  color: var(--mines-muted);
}
.game-summary strong {
  display: block;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.game-summary .next-multiplier {
  border-color: #e4a36d66;
  background: #c9843710;
}
.next-multiplier strong {
  color: #ffbe85;
}
.board-panel {
  flex: 1 1 0;
  min-height: 0;
  container-type: size;
  display: grid;
  place-items: center;
  width: 100%;
  padding: 9px 9px 13px;
  border-radius: 16px;
  background: #14181f70;
  border: 1px solid #ffffff08;
}
.mines-board {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
  width: min(100cqw, 100cqh);
  aspect-ratio: 1;
  grid-template-rows: repeat(5, minmax(0, 1fr));
  margin: 0 auto;
}
.mine-cell {
  min-height: 0;
  display: grid;
  place-items: center;
  width: 100%;
  min-width: 0;
  padding: 0;
  aspect-ratio: 1;
  border: 1px solid #ffffff08;
  border-radius: 10px;
  background: linear-gradient(145deg, #3a424e, #292f39);
  box-shadow:
    0 4px 0 #10151d,
    0 6px 8px #0003,
    inset 0 1px 1px #ffffff0d;
  color: #48515e;
  transition:
    transform 0.15s,
    background 0.15s,
    box-shadow 0.15s;
  touch-action: manipulation;
}
.mine-cell:not(:disabled):hover {
  background: linear-gradient(145deg, #4b5360, #343c48);
  transform: translateY(-2px);
}
.mine-cell:not(:disabled):active {
  transform: translateY(2px);
  box-shadow: 0 1px 0 #10151d;
}
.mine-cell:disabled {
  opacity: 1;
  cursor: default;
}
.cell-mark {
  font-size: 16px;
}
.cell-icon {
  width: 64%;
  height: 64%;
  filter: drop-shadow(0 3px 4px #0004);
}
.mine-cell.safe {
  color: #ffc285;
  border-color: #eaaa6855;
  background: radial-gradient(circle at 50% 30%, #70523a, #3a3029);
}
.mine-cell.mine {
  color: #ff7d75;
  border-color: #b9555266;
  background: radial-gradient(circle at 50% 30%, #703f43, #3c262d);
}
.mines-controls {
  display: grid;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid #ffffff0d;
  background: #14181fa6;
}
.mine-settings {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 54px;
  align-items: center;
  gap: 10px;
}
.mine-settings label {
  color: var(--mines-muted);
  font-size: 11px;
}
.mine-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}
.mines-page :is(button, select, summary):focus-visible {
  outline: 2px solid #ffd1a1;
  outline-offset: 3px;
}
.mines-status,
.mines-error {
  text-align: center;
  margin: 4px 0;
  font-size: 12px;
}
.mines-error {
  color: #ffaca5;
}
.mines-feedback {
  display: grid;
  gap: 4px;
}
.mines-status {
  flex: 1;
  display: grid;
  place-items: center;
}
@media (max-height: 650px) {
  .mines-page {
    gap: 5px;
  }
  .mines-header {
    min-height: 36px;
  }

  .game-summary > div {
    padding-block: 4px;
  }
  .board-panel {
    padding: 6px 6px 10px;
  }
  .mines-board {
    gap: 5px;
  }
  .mines-controls {
    gap: 6px;
    padding: 8px;
  }
  .mines-wallet {
    padding-block: 4px;
  }
}
// Short landscape screens put controls beside the board to retain usable cells.
@media (max-height: 520px) and (min-width: 520px) {
  .mines-page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
    gap: 6px;
  }
  .mines-header,
  .game-summary,
  .mines-feedback,
  .mines-wallet,
  .mines-status {
    grid-column: 1 / -1;
  }
  .mines-header {
    grid-row: 1;
  }
  .game-summary {
    grid-row: 2;
  }
  .board-panel {
    grid-column: 1;
    grid-row: 3;
    height: 100%;
  }
  .mines-controls {
    grid-column: 2;
    grid-row: 3;
    align-self: center;
    padding: 6px;
    gap: 5px;
  }
  .mine-settings {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px;
  }
  .mine-presets {
    display: none;
  }
  .mines-controls select {
    font-size: 12px;
    padding-block: 2px;
  }
  .mines-feedback {
    grid-row: 4;
  }
  .mines-wallet {
    grid-row: 5;
    margin-top: 0;
  }
  .cell-mark {
    font-size: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mine-cell {
    transition: none;
  }
}
</style>
