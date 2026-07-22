<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import BigRoadBoard from "../components/BigRoadBoard.vue";
import { toBaccaratPairType } from "../const/game";
import { useLiveChannel } from "../composables/useLiveChannel";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import type { ActiveRound } from "../types/domain";

const authStore = useAuthStore();
const gameStore = useGameStore();
const router = useRouter();

const tables = computed(() => gameStore.tables);
const isLobbyLoading = ref(true);

function openTable(tableId: string) {
  router.push(`/game/${tableId}`);
}

function logout() {
  authStore.logout();
  router.push("/login");
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

function toBigRoad(rounds: Pick<ActiveRound, "winner" | "playerPair" | "bankerPair">[]) {
  return [...rounds].reverse().map((round) => ({
    existBead: "EXIST" as const,
    winType: round.winner,
    fourBit: "ZERO" as const,
    directKilling: "NO" as const,
    baccaratPair: toBaccaratPairType(round),
  }));
}
</script>

<template>
  <main class="player-page page-shell lobby-page">
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

    <header class="page-header lobby-header">
      <button
        class="page-header-back back-button"
        type="button"
        aria-label="返回登入"
        @click="logout"
      >
        ‹
      </button>
      <h1>遊戲大廳</h1>
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
              {{ Math.round(item.table.roundDurationMs / 1000) }} 秒 / 最低
              {{ item.table.minBet.toLocaleString() }} / 單種最高
              {{ item.table.maxBet.toLocaleString() }}
            </p>
          </div>
          <span
            class="table-status"
            :class="item.activeRound?.status === 'OPEN' ? 'open' : 'locked'"
          >
            <i aria-hidden="true" />
            {{ item.activeRound?.status === "OPEN" ? "下注中" : "封盤" }}
          </span>
        </div>

        <div class="lobby-road">
          <BigRoadBoard :big-road="toBigRoad(item.roadRounds)" :cols="13" :rows="6" />
        </div>
      </button>
    </section>
  </main>
</template>

<style scoped lang="scss">
.lobby-page {
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

.table-card {
  width: 100%;
  padding: $space-5;
  cursor: pointer;
  color: inherit;
  text-align: left;
  background: linear-gradient(180deg, rgba(7, 48, 33, 0.74), rgba(5, 34, 23, 0.82));
  border-color: $color-border-soft;
  transition:
    transform 140ms ease,
    border-color 140ms ease,
    background 140ms ease;
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
</style>
