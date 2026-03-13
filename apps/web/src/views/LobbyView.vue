<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import BigRoadBoard from "../components/BigRoadBoard.vue";
import { BET_TYPE_LABELS, WINNER_LABELS } from "../const/game";
import { useLiveChannel } from "../composables/useLiveChannel";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import type { ActiveRound, BaccaratPairType, BetType, RoundHistoryItem } from "../types/domain";

const authStore = useAuthStore();
const gameStore = useGameStore();
const router = useRouter();

const tables = computed(() => gameStore.tables);
const isHistoryOpen = ref(false);
const isLobbyLoading = ref(true);

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

function closeHistory() {
  isHistoryOpen.value = false;
}

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

function toBaccaratPairType(round: { playerPair: boolean; bankerPair: boolean }): BaccaratPairType {
  if (round.playerPair && round.bankerPair) {
    return "BOTH_PAIR";
  }

  if (round.playerPair) {
    return "PLAYER_PAIR";
  }

  if (round.bankerPair) {
    return "BANKER_PAIR";
  }

  return "NO_PAIR";
}

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

function betLabel(type: BetType | string) {
  return BET_TYPE_LABELS[type as BetType] ?? String(type);
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
        <div class="lobby-loading-panel panel">
          <div class="lobby-loading-spinner" aria-hidden="true" />
          <p class="topbar-label">Loading Lobby</p>
          <strong>載入大廳中</strong>
          <span>正在同步最新桌況與路圖</span>
        </div>
      </div>
    </transition>

    <button class="back-button" @click="logout" aria-label="返回登入">
      ←
    </button>
    <button class="history-button" @click="openHistory" aria-label="最近 20 筆下注紀錄">
      📖
    </button>

    <section class="table-cards">
      <article v-for="item in tables" :key="item.table.id" class="panel table-card" @click="openTable(item.table.id)">
        <div class="card-head">
          <div>
            <p class="topbar-label">{{ item.table.code }}</p>
            <h2>{{ item.table.name }}</h2>
            <p class="table-meta">
              {{ Math.round(item.table.roundDurationMs / 1000) }} 秒 / 最低 {{ item.table.minBet.toLocaleString() }} / 單種最高
              {{ item.table.maxBet.toLocaleString() }}
            </p>
          </div>
          <span class="table-status-dot" :class="item.activeRound?.status === 'OPEN' ? 'open' : 'locked'" />
        </div>

        <div class="lobby-road">
          <BigRoadBoard :big-road="toBigRoad(item.roadRounds)" :cols="13" :rows="6" />
        </div>
      </article>
    </section>

    <div v-if="isHistoryOpen" class="modal-backdrop">
      <section class="panel history-modal">
        <div class="card-head">
          <div>
            <p class="topbar-label">History</p>
            <h2>最近 20 筆</h2>
          </div>
          <button class="history-close-button" @click="closeHistory" aria-label="關閉下注紀錄">✕</button>
        </div>

        <div class="history-list">
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
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.lobby-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.lobby-loading-overlay {
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

.lobby-loading-panel {
  width: 100%;
  max-width: 280px;
  padding: 26px 20px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.lobby-loading-spinner {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 3px solid rgba(244, 222, 155, 0.2);
  border-top-color: #f4de9b;
  border-right-color: rgba(244, 222, 155, 0.64);
  animation: lobby-loading-spin 0.82s linear infinite;
  box-shadow: 0 0 18px rgba(244, 222, 155, 0.12);
}

.lobby-loading-panel strong {
  color: #f7f4e9;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.lobby-loading-panel span {
  color: rgba(247, 244, 233, 0.68);
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

.topbar-label {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(247, 244, 233, 0.6);
}

.table-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  margin-top: 28px;
}

.back-button {
  position: fixed;
  top: 22px;
  left: 22px;
  z-index: 20;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 999px;
  background: rgba(8, 18, 14, 0.88);
  color: #f7f4e9;
  font-size: 26px;
  line-height: 1;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
}

.history-button {
  position: fixed;
  top: 78px;
  left: 22px;
  z-index: 20;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 999px;
  background: rgba(8, 18, 14, 0.88);
  color: #f7f4e9;
  font-size: 22px;
  line-height: 1;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.2);
}

.table-card {
  padding: 18px;
  cursor: pointer;
}

.card-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.card-head h2 {
  margin: 6px 0 0;
}

.table-meta {
  margin: 8px 0 0;
  color: rgba(247, 244, 233, 0.68);
  font-size: 13px;
}

.lobby-road {
  margin-top: 20px;
}

.table-status-dot {
  width: 14px;
  height: 14px;
  margin-top: 6px;
  border-radius: 999px;
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.06);
}

.table-status-dot.open {
  background: #53db84;
}

.table-status-dot.locked {
  background: #f26d6d;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(4, 10, 8, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 50;
}

.history-modal {
  width: 100%;
  max-height: 80vh;
  padding: 18px;
}

.history-close-button {
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: rgba(192, 48, 48, 0.18);
  color: #ff7f7f;
  font-size: 22px;
  line-height: 1;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 20px;
  max-height: calc(80vh - 140px);
  overflow: auto;
}

.history-item {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  padding: 14px;
}

.history-main,
.history-sub {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.history-sub {
  margin-top: 8px;
  color: rgba(247, 244, 233, 0.65);
  font-size: 14px;
}

.history-payout.positive {
  color: #72f2a5;
}

.history-payout.negative {
  color: #ff7f7f;
}

</style>
