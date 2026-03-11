<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import BigRoadBoard from "../components/BigRoadBoard.vue";
import { createLiveEventSource, type LiveUpdateEvent } from "../lib/live";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";

type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";
type BetKey = "PLAYER" | "BANKER" | "TIE" | "PLAYER_PAIR" | "BANKER_PAIR";

const authStore = useAuthStore();
const gameStore = useGameStore();
const router = useRouter();

const tables = computed(() => gameStore.tables);
const isHistoryOpen = ref(false);
let stream: EventSource | null = null;
let fallbackTimer: number | null = null;
let lobbyRefreshPromise: Promise<void> | null = null;
let lobbyRefreshQueued = false;

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

onMounted(async () => {
  await refreshLobby();
  if (typeof EventSource !== "undefined") {
    stream = createLiveEventSource("/game/stream/lobby", handleLiveEvent);
  } else {
    fallbackTimer = window.setInterval(async () => {
      await refreshLobby();
    }, 2000);
  }
});

onUnmounted(() => {
  stream?.close();
  if (fallbackTimer) {
    window.clearInterval(fallbackTimer);
  }
});

async function refreshLobby() {
  if (lobbyRefreshPromise) {
    lobbyRefreshQueued = true;
    return lobbyRefreshPromise;
  }

  lobbyRefreshPromise = (async () => {
    await gameStore.fetchLobby();
  })();

  try {
    await lobbyRefreshPromise;
  } finally {
    lobbyRefreshPromise = null;
    if (lobbyRefreshQueued) {
      lobbyRefreshQueued = false;
      void refreshLobby();
    }
  }
}

function handleLiveEvent(event: LiveUpdateEvent) {
  if (event.type === "lobby_updated") {
    void refreshLobby();
    return;
  }

  if (event.type === "user_updated") {
    void authStore.fetchMe().catch(() => {
      authStore.logout();
      router.push("/login");
    });
  }
}

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

function toBigRoad(rounds: { winner: "PLAYER" | "BANKER" | "TIE"; playerPair: boolean; bankerPair: boolean }[]) {
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

function betLabel(type: BetKey | string) {
  return type === "PLAYER"
    ? "閒"
    : type === "BANKER"
      ? "莊"
      : type === "TIE"
        ? "和"
        : type === "PLAYER_PAIR"
          ? "閒對"
          : "莊對";
}

function historyNetAmount(item: { totalAmount: number; totalPayout: number }) {
  return item.totalPayout - item.totalAmount;
}

function historyNetText(item: { totalAmount: number; totalPayout: number }) {
  const net = historyNetAmount(item);
  return `${net > 0 ? "+" : ""}${net.toLocaleString()}`;
}

function historyNetClass(item: { totalAmount: number; totalPayout: number }) {
  return historyNetAmount(item) >= 0 ? "positive" : "negative";
}

function historyResultText(item: {
  round: {
    winner: "PLAYER" | "BANKER" | "TIE";
    playerPair: boolean;
    bankerPair: boolean;
  };
}) {
  const parts = [
    item.round.winner === "PLAYER" ? "閒贏" : item.round.winner === "BANKER" ? "莊贏" : "和局",
  ];

  if (item.round.playerPair) {
    parts.push("閒對");
  }

  if (item.round.bankerPair) {
    parts.push("莊對");
  }

  return parts.join(" / ");
}

function historyBetSummary(item: {
  bets: {
    betType: BetKey;
    amount: number;
  }[];
}) {
  const totals = new Map<BetKey, number>();

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
