<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import BigRoadBoard from "../components/BigRoadBoard.vue";
import { BET_TYPE_LABELS, WINNER_LABELS, toBaccaratPairType } from "../const/game";
import { useDialogFocus } from "../composables/useDialogFocus";
import { useLiveChannel } from "../composables/useLiveChannel";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import type { ActiveRound, BetType, RoundHistoryItem } from "../types/domain";

const authStore = useAuthStore();
const gameStore = useGameStore();
const router = useRouter();

const tables = computed(() => gameStore.tables);
const isHistoryOpen = ref(false);
const isLobbyLoading = ref(true);
const historyDialogRef = ref<HTMLElement | null>(null);
const historyCloseButtonRef = ref<HTMLElement | null>(null);

function openTable(tableId: string) {
  router.push(`/game/${tableId}`);
}

function logout() {
  authStore.logout();
  router.push("/login");
}

async function openHistory() {
  await gameStore.fetchHistory();
  isHistoryOpen.value = true;
}

async function loadMoreHistory() {
  await gameStore.fetchMoreHistory().catch(() => undefined);
}

function closeHistory() {
  isHistoryOpen.value = false;
}

const { onDialogKeydown: onHistoryDialogKeydown } = useDialogFocus({
  isOpen: () => isHistoryOpen.value,
  dialogRef: historyDialogRef,
  close: closeHistory,
  initialFocusRef: historyCloseButtonRef,
});

useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_lobby" }),
  onMessage: (message) => {
    if (message.type === "lobby_snapshot") {
      gameStore.applyLobbySnapshot(message.data);
      isLobbyLoading.value = false;
    }
  },
});

onMounted(async () => {
  isLobbyLoading.value = true;

  try {
    await gameStore.fetchLobby();
  } finally {
    isLobbyLoading.value = false;
  }
});

function toBigRoad(rounds: Pick<ActiveRound, "winner" | "playerPair" | "bankerPair">[]) {
  return [...rounds]
    .reverse()
    .map((round) => ({
      existBead: "EXIST" as const,
      winType: round.winner,
      fourBit: "ZERO" as const,
      directKilling: "NO" as const,
      baccaratPair: toBaccaratPairType(round),
    }));
}

function betLabel(type: BetType) {
  return BET_TYPE_LABELS[type];
}

function historyNetAmount(item: Pick<RoundHistoryItem, "totalAmount" | "totalPayout">) {
  return item.totalPayout - item.totalAmount;
}

function historyNetText(item: Pick<RoundHistoryItem, "totalAmount" | "totalPayout">) {
  const net = historyNetAmount(item);
  return `${net > 0 ? "+" : ""}${net.toLocaleString()}`;
}

function historyNetClass(item: Pick<RoundHistoryItem, "totalAmount" | "totalPayout">) {
  return historyNetAmount(item) >= 0 ? "positive" : "negative";
}

function historyResultText(item: Pick<RoundHistoryItem, "round">) {
  const parts = [WINNER_LABELS[item.round.winner]];

  if (item.round.playerPair) {
    parts.push(BET_TYPE_LABELS.PLAYER_PAIR);
  }

  if (item.round.bankerPair) {
    parts.push(BET_TYPE_LABELS.BANKER_PAIR);
  }

  return parts.join(" / ");
}

function historyBetSummary(item: Pick<RoundHistoryItem, "bets">) {
  const totals = new Map<BetType, number>();

  for (const bet of item.bets) {
    totals.set(bet.betType, (totals.get(bet.betType) ?? 0) + bet.amount);
  }

  return Array.from(totals.entries())
    .map(([betType, amount]) => `${betLabel(betType)} ${amount.toLocaleString()}`)
    .join(" / ");
}
</script>

<template>
  <main class="page-shell lobby-page">
    <transition name="lobby-loading-fade">
      <div v-if="isLobbyLoading" class="lobby-loading-overlay">
        <div class="lobby-loading-panel panel" role="status" aria-live="polite" aria-atomic="true">
          <div class="lobby-loading-spinner" aria-hidden="true" />
          <p class="topbar-label">Loading Lobby</p>
          <strong>載入大廳中</strong>
          <span>正在同步最新桌況與路圖</span>
        </div>
      </div>
    </transition>

    <header class="lobby-header">
      <button class="back-button" type="button" @click="logout" aria-label="返回登入">‹</button>
      <div class="lobby-title">
        <p>Live Baccarat</p>
        <h1>遊戲大廳</h1>
      </div>
      <div class="header-actions">
        <button class="account-button" type="button" @click="router.push('/account')" aria-label="帳號安全">⚙</button>
        <button class="history-button" type="button" @click="openHistory" aria-haspopup="dialog" aria-label="下注紀錄">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 7v5l3 2M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
          </svg>
        </button>
      </div>
    </header>

    <section class="table-cards">
      <button
        v-for="item in tables"
        :key="item.table.id"
        type="button"
        class="panel table-card"
        @click="openTable(item.table.id)"
      >
        <div class="card-head">
          <div>
            <p class="topbar-label">{{ item.table.code }}</p>
            <h2>{{ item.table.name }}</h2>
            <p class="table-meta">
              {{ Math.round(item.table.roundDurationMs / 1000) }} 秒 / 最低 {{ item.table.minBet.toLocaleString() }} / 單種最高
              {{ item.table.maxBet.toLocaleString() }}
            </p>
          </div>
          <span class="table-status" :class="item.activeRound?.status === 'OPEN' ? 'open' : 'locked'">
            <i aria-hidden="true" />
            {{ item.activeRound?.status === "OPEN" ? "下注中" : "封盤" }}
          </span>
        </div>

        <div class="lobby-road">
          <BigRoadBoard :big-road="toBigRoad(item.roadRounds)" :cols="13" :rows="6" />
        </div>
      </button>
    </section>

    <div v-if="isHistoryOpen" class="modal-backdrop" @click.self="closeHistory">
      <section
        ref="historyDialogRef"
        class="panel history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-modal-title"
        tabindex="-1"
        @keydown="onHistoryDialogKeydown"
      >
        <div class="card-head">
          <div>
            <p class="topbar-label">History</p>
            <h2 id="history-modal-title">下注紀錄</h2>
          </div>
          <button
            ref="historyCloseButtonRef"
            class="history-close-button"
            type="button"
            @click="closeHistory"
            aria-label="關閉下注紀錄"
          >
            ✕
          </button>
        </div>

        <div class="history-list">
          <p v-if="gameStore.history.length === 0" class="history-empty" role="status">目前沒有已結算的下注紀錄。</p>
          <article v-for="item in gameStore.history" :key="item.id" class="history-item">
            <div class="history-main">
              <strong>{{ item.round.id.slice(0, 8) }}</strong>
              <span>{{ item.totalAmount.toLocaleString() }}</span>
            </div>
            <div class="history-sub">
              <span>{{ historyBetSummary(item) }}</span>
            </div>
            <div class="history-sub">
              <span>結果 {{ historyResultText(item) }}</span>
              <span class="history-payout" :class="historyNetClass(item)">派彩 {{ historyNetText(item) }}</span>
            </div>
          </article>
          <div class="history-footer">
            <p v-if="gameStore.historyLoadMoreError" class="history-load-error" role="alert">
              {{ gameStore.historyLoadMoreError }}
            </p>
            <button
              v-if="gameStore.historyNextCursor"
              class="history-load-more"
              type="button"
              :disabled="gameStore.historyLoadingMore"
              @click="loadMoreHistory"
            >
              {{ gameStore.historyLoadingMore ? "載入中…" : "載入更早紀錄" }}
            </button>
            <p v-else-if="gameStore.history.length > 0" class="history-end" role="status">已顯示全部紀錄</p>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped lang="scss">
.lobby-page {
  display: flex;
  flex-direction: column;
  gap: $space-4;
  min-height: 100vh;
  min-height: 100dvh;
  padding: $space-3 $space-4 $space-6;
  background: $gradient-felt;
}

.lobby-loading-overlay {
  @include loading-overlay();
}

.lobby-loading-panel {
  width: 100%;
  max-width: 280px;
  padding: $space-6 $space-5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
  text-align: center;
}

.lobby-loading-spinner {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 3px solid rgba(244, 222, 155, 0.2);
  border-top-color: $color-gold;
  border-right-color: rgba(244, 222, 155, 0.64);
  animation: lobby-loading-spin 0.82s linear infinite;
  box-shadow: 0 0 18px rgba(244, 222, 155, 0.12);
}

.lobby-loading-panel strong {
  color: $color-text-primary;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.lobby-loading-panel span {
  color: $color-text-muted;
  font-size: 13px;
  line-height: 1.5;
}

.lobby-loading-fade-enter-active,
.lobby-loading-fade-leave-active {
  transition: opacity 220ms ease;
}

.lobby-loading-fade-enter-from,
.lobby-loading-fade-leave-to {
  opacity: 0;
}

@keyframes lobby-loading-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.table-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: $space-4;
}

.lobby-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 92px;
  align-items: center;
  gap: $space-2;
  min-height: 64px;
  padding: $space-1 0 $space-2;
}

.lobby-title {
  min-width: 0;
  text-align: center;
}

.lobby-title p {
  margin: 0;
  color: $color-text-muted;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.lobby-title h1 {
  margin: 1px 0 0;
  color: $color-text-primary;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 21px;
  font-weight: 900;
  letter-spacing: 0.1em;
}

.back-button,
.account-button,
.history-button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 999px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform 120ms ease, filter 120ms ease;
}

.header-actions { justify-self: end; display: flex; gap: $space-2; }
.account-button { display: grid; place-items: center; background: $color-surface-soft; color: $color-text-primary; font-size: 18px; }

.back-button {
  justify-self: start;
  background: $color-surface-soft;
  color: $color-text-primary;
  font-size: 26px;
  line-height: 1;
}

.history-button {
  justify-self: end;
  display: grid;
  place-items: center;
  background: $color-surface-raised;
  color: #8c2f23;
  border: 1px solid $color-border-strong;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.2);
}

.history-button svg {
  width: 23px;
  height: 23px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.back-button:active,
.account-button:active,
.history-button:active {
  transform: scale(0.94);
}

.table-card {
  width: 100%;
  padding: $space-5;
  cursor: pointer;
  color: inherit;
  text-align: left;
  background: linear-gradient(180deg, rgba(7, 48, 33, 0.74), rgba(5, 34, 23, 0.82));
  border-color: $color-border-soft;
  transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
}

.table-card:active {
  transform: scale(0.992);
  background: linear-gradient(180deg, rgba(8, 57, 39, 0.78), rgba(5, 38, 26, 0.86));
}

.card-head {
  display: flex;
  justify-content: space-between;
  gap: $space-4;
}

.card-head h2 {
  margin: $space-2 0 0;
  color: $color-text-primary;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 22px;
  letter-spacing: 0.04em;
}

.table-meta {
  margin: $space-2 0 0;
  color: $color-text-muted;
  font-size: 13px;
}

.lobby-road {
  margin-top: $space-5;
}

.table-status {
  flex: 0 0 auto;
  align-self: flex-start;
  margin-top: $space-2;
  min-height: 26px;
  padding: 0 $space-3;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  background: $color-surface-soft;
  border: 1px solid $color-border-soft;
  color: $color-text-muted;
  font-size: 11px;
  font-weight: 800;
}

.table-status i {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.table-status.open i {
  background: $color-open;
}

.table-status.locked i {
  background: $color-lock;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(3, 9, 7, 0.66);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $space-4;
  z-index: 50;
}

.history-modal {
  width: 100%;
  max-height: 80vh;
  padding: $space-5;
}

.history-close-button {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 999px;
  background: rgba(182, 34, 34, 0.92);
  color: $color-text-primary;
  font-size: 22px;
  line-height: 1;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin-top: $space-5;
  max-height: calc(80vh - 140px);
  overflow: auto;
}

.history-item {
  border-radius: 14px;
  background: $color-surface-soft;
  border: 1px solid $color-border-soft;
  padding: $space-4;
}

.history-empty,
.history-end,
.history-load-error {
  margin: 0;
  color: $color-text-muted;
  text-align: center;
}

.history-load-error {
  color: $color-negative;
}

.history-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
}

.history-load-more {
  min-height: 44px;
  padding: 0 $space-5;
  border: 1px solid $color-gold;
  border-radius: 999px;
  background: rgba(244, 222, 155, 0.08);
  color: $color-gold;
  font-weight: 800;
}

.history-load-more:disabled {
  cursor: wait;
  opacity: 0.56;
}

.history-main,
.history-sub {
  display: flex;
  justify-content: space-between;
  gap: $space-4;
  flex-wrap: wrap;
}

.history-sub {
  margin-top: $space-2;
  color: $color-text-muted;
  font-size: 14px;
}

.history-payout.positive {
  color: $color-positive;
}

.history-payout.negative {
  color: $color-negative;
}

</style>
