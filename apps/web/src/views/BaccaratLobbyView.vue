<script setup lang="ts">
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import BigRoadBoard from "../components/BigRoadBoard.vue";
import { toBaccaratPairType } from "../const/game";
import { useLiveChannel } from "../composables/useLiveChannel";
import { formatMoney } from "../lib/money";
import { useGameStore } from "../stores/game";
import type { ActiveRound } from "../types/domain";

const gameStore = useGameStore();
const router = useRouter();
const loading = ref(true);
const tables = computed(() => gameStore.tables);

function toBigRoad(rounds: Pick<ActiveRound, "winner" | "playerPair" | "bankerPair">[]) {
  return [...rounds].reverse().map((round) => ({
    existBead: "EXIST" as const,
    winType: round.winner,
    fourBit: "ZERO" as const,
    directKilling: "NO" as const,
    baccaratPair: toBaccaratPairType(round),
  }));
}

useLiveChannel({
  getSubscribeMessage: () => ({ type: "subscribe_lobby" }),
  onMessage: (message) => {
    if (message.type === "lobby_snapshot") {
      gameStore.applyLobbySnapshot(message.data);
      loading.value = false;
    }
  },
});

onMounted(async () => {
  try {
    await gameStore.fetchLobby();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <main class="player-page baccarat-lobby">
    <AppPageHeader title="百家樂" back-label="返回遊戲選擇" @back="router.push('/lobby')" />
    <p v-if="loading" class="loading" role="status">載入牌桌中…</p>
    <section v-else class="table-cards">
      <button
        v-for="item in tables"
        :key="item.table.id"
        type="button"
        class="panel table-card"
        @click="router.push(`/game/${item.table.id}`)"
      >
        <div class="card-head">
          <div>
            <p class="topbar-label">{{ item.table.code }}</p>
            <h2>{{ item.table.name }}</h2>
            <p class="table-meta">
              {{ Math.round(item.table.roundDurationMs / 1000) }} 秒 / 最低
              {{ formatMoney(item.table.minBet) }} / 單種最高 {{ formatMoney(item.table.maxBet) }}
            </p>
          </div>
          <span
            class="table-status"
            :class="item.activeRound?.status === 'OPEN' ? 'open' : 'locked'"
            >{{ item.activeRound?.status === "OPEN" ? "下注中" : "封盤" }}</span
          >
        </div>
        <div class="lobby-road">
          <BigRoadBoard :big-road="toBigRoad(item.roadRounds)" :cols="13" :rows="6" />
        </div>
      </button>
    </section>
  </main>
</template>

<style scoped lang="scss">
.baccarat-lobby {
  background: $gradient-felt;
}
.loading {
  color: $color-text-muted;
  text-align: center;
}
.table-cards {
  display: grid;
  gap: $space-4;
}
.table-card {
  width: 100%;
  padding: $space-5;
  color: inherit;
  text-align: left;
  background: linear-gradient(180deg, rgba(7, 48, 33, 0.74), rgba(5, 34, 23, 0.82));
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: $space-4;
}
.card-head h2 {
  margin: $space-2 0 0;
  color: $color-text-primary;
  font-size: 22px;
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
  align-self: start;
  padding: $space-2 $space-3;
  border: 1px solid $color-border-soft;
  border-radius: 999px;
  color: $color-text-muted;
  font-size: 12px;
  font-weight: 800;
}
.table-status.open {
  color: $color-positive;
}
</style>
