<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { BET_TYPE_LABELS } from "../const/game";
import { useGameStore } from "../stores/game";
import type { BetType, Card, RoundHistoryItem } from "../types/domain";

const router = useRouter();
const gameStore = useGameStore();

const BET_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BET_HISTORY_MAX_EXTRA_PAGES = 10;

const isLoading = ref(false);
const loadError = ref("");
const cutoffMs = ref(Date.now() - BET_HISTORY_WINDOW_MS);

const recentHistory = computed(() =>
  gameStore.history.filter((item) => new Date(item.createdAt).getTime() >= cutoffMs.value),
);

async function loadHistory() {
  if (isLoading.value) {
    return;
  }

  isLoading.value = true;
  loadError.value = "";
  cutoffMs.value = Date.now() - BET_HISTORY_WINDOW_MS;

  try {
    await gameStore.fetchHistory();

    // 往後翻頁補齊七日內的紀錄，直到最舊一筆超出範圍或沒有下一頁。
    let extraPages = 0;
    while (
      gameStore.historyNextCursor &&
      extraPages < BET_HISTORY_MAX_EXTRA_PAGES &&
      gameStore.history.length > 0 &&
      new Date(gameStore.history.at(-1)!.createdAt).getTime() >= cutoffMs.value
    ) {
      await gameStore.fetchMoreHistory();
      extraPages += 1;
    }
  } catch {
    loadError.value = "投注紀錄載入失敗，請重試。";
  } finally {
    isLoading.value = false;
  }
}

function tableLabel(historyTableId: string) {
  const lobbyEntry = gameStore.tables.find((entry) => entry.table.id === historyTableId);
  if (lobbyEntry) {
    return lobbyEntry.table.name;
  }
  if (gameStore.currentTable?.id === historyTableId) {
    return gameStore.currentTable.name;
  }
  return "遊戲臺";
}

function formatTime(iso: string) {
  const time = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${time.getFullYear()}.${pad(time.getMonth() + 1)}.${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

function roundNo(roundId: string) {
  return roundId.slice(0, 8).toUpperCase();
}

function betGroups(item: RoundHistoryItem) {
  const groups = new Map<BetType, { amount: number; payout: number }>();
  for (const bet of item.bets) {
    const group = groups.get(bet.betType) ?? { amount: 0, payout: 0 };
    group.amount += bet.amount;
    group.payout += bet.payout;
    groups.set(bet.betType, group);
  }
  return [...groups].map(([betType, group]) => ({
    betType,
    label: BET_TYPE_LABELS[betType],
    amount: group.amount,
    payout: group.payout,
    won: group.payout > 0,
  }));
}

function roundNetAmount(item: RoundHistoryItem) {
  return item.totalPayout - item.totalAmount;
}

function cardSuitSymbol(suit: Card["suit"]) {
  return suit === "S" ? "♠" : suit === "H" ? "♥" : suit === "D" ? "♦" : "♣";
}

function cardColor(suit: Card["suit"]) {
  return suit === "H" || suit === "D" ? "red" : "black";
}

onMounted(() => {
  if (gameStore.tables.length === 0) {
    void gameStore.fetchLobby().catch(() => {});
  }
  void loadHistory();
});
</script>

<template>
  <main class="player-page history-page">
    <header class="page-header history-topbar">
      <button
        class="page-header-back history-back"
        type="button"
        aria-label="返回"
        @click="router.back()"
      >
        ‹
      </button>
      <h1>投注紀錄</h1>
    </header>

    <div class="history-list" :aria-busy="isLoading">
      <p v-if="isLoading && recentHistory.length === 0" class="history-empty" role="status">
        載入中…
      </p>
      <div v-else-if="loadError && recentHistory.length === 0" class="history-error" role="alert">
        <p>{{ loadError }}</p>
        <button type="button" @click="loadHistory">重新載入</button>
      </div>
      <p v-else-if="recentHistory.length === 0" class="history-empty" role="status">
        近七日沒有投注紀錄
      </p>

      <article v-for="item in recentHistory" :key="item.id" class="history-card">
        <header class="history-card-head">
          <span>{{ tableLabel(item.round.tableId) }}</span>
          <span class="head-divider" aria-hidden="true">|</span>
          <span>第{{ roundNo(item.round.id) }}局</span>
          <time class="head-time">{{ formatTime(item.createdAt) }}</time>
        </header>

        <div class="history-card-top">
          <div class="stake-list">
            <div
              v-for="bet in betGroups(item)"
              :key="`${item.id}-${bet.betType}`"
              class="stake-chip"
              :class="{ win: bet.won }"
            >
              <span v-if="bet.won" class="win-tag">WIN</span>
              <span class="stake-label">{{ bet.label }}</span>
              <strong>{{ bet.amount.toLocaleString() }}</strong>
            </div>
          </div>
          <div
            class="round-net"
            role="group"
            :aria-label="`本局收益 ${roundNetAmount(item).toLocaleString()}`"
          >
            <span class="coin-symbol" aria-hidden="true">$</span>
            <strong aria-hidden="true">{{ roundNetAmount(item).toLocaleString() }}</strong>
          </div>
        </div>

        <div class="history-result">
          <div class="result-tab">本局結果</div>
          <div class="result-hands">
            <div
              class="result-hand"
              :class="{ 'three-card-result': item.round.playerCards.length === 3 }"
            >
              <p class="hand-title">
                <i class="hand-badge player">閒</i>
                <b class="player-total">{{ item.round.playerTotal }}</b>
              </p>
              <div
                class="hand-cards"
                :class="{ 'three-card-hand': item.round.playerCards.length === 3 }"
              >
                <span
                  v-for="(card, index) in item.round.playerCards"
                  :key="`player-${item.id}-${index}`"
                  class="hand-card"
                  :class="[cardColor(card.suit), { bonus: index === 2 }]"
                >
                  <b>{{ card.rank }}</b>
                  <small>{{ cardSuitSymbol(card.suit) }}</small>
                </span>
              </div>
            </div>
            <div
              class="result-hand"
              :class="{ 'three-card-result': item.round.bankerCards.length === 3 }"
            >
              <p class="hand-title">
                <i class="hand-badge banker">莊</i>
                <b class="banker-total">{{ item.round.bankerTotal }}</b>
              </p>
              <div
                class="hand-cards"
                :class="{ 'three-card-hand': item.round.bankerCards.length === 3 }"
              >
                <span
                  v-for="(card, index) in item.round.bankerCards"
                  :key="`banker-${item.id}-${index}`"
                  class="hand-card"
                  :class="[cardColor(card.suit), { bonus: index === 2 }]"
                >
                  <b>{{ card.rank }}</b>
                  <small>{{ cardSuitSymbol(card.suit) }}</small>
                </span>
              </div>
            </div>
          </div>
        </div>
      </article>
      <p v-if="!isLoading && !loadError" class="history-end-note" role="status">
        已列出 近7日的全部紀錄
      </p>
    </div>
  </main>
</template>

<style scoped lang="scss">
.history-page {
  background: #51b77d;
}

.history-topbar {
  background: #51b77d;
}

.history-list {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-empty {
  margin: 48px 0;
  text-align: center;
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
}

.history-end-note {
  margin: 8px 0 12px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  font-weight: 700;
  text-align: center;
}

.history-error {
  margin: 48px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
}

.history-error p {
  margin: 0;
}

.history-error button {
  min-height: 44px;
  padding: 0 20px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-weight: 800;
}

.history-card {
  border-radius: 14px;
  overflow: hidden;
  background: linear-gradient(180deg, #d68338, #cb7129 65%, #c26723);
  border: 1px solid rgba(122, 62, 16, 0.5);
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.18);
}

.history-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px;
  background: linear-gradient(180deg, #a84f1e, #943f16);
  color: #ffd9a0;
  font-size: clamp(11px, 3.1vw, 14px);
  font-weight: 800;
}

.history-card-head > span,
.head-time {
  white-space: nowrap;
}

.head-divider {
  color: rgba(255, 217, 160, 0.45);
  font-weight: 400;
}

.head-time {
  margin-left: auto;
  font-size: clamp(10px, 2.9vw, 13px);
  font-weight: 600;
  color: #ffe9c8;
}

.history-card-top {
  display: flex;
  align-items: center;
  padding: 14px 14px 12px;
  gap: 10px;
}

.stake-list {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  gap: 12px;
}

.stake-chip {
  position: relative;
  min-width: 64px;
  padding: 10px 12px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: rgba(122, 62, 16, 0.32);
  box-shadow: inset 0 0 0 1px rgba(122, 62, 16, 0.35);
  color: #ffe9c8;
}

.stake-chip strong {
  font-size: 15px;
  font-weight: 900;
  color: #fff;
}

.stake-chip.win {
  background: linear-gradient(180deg, #ffedb8, #ffd98a);
  box-shadow: inset 0 0 0 1px #b8801f;
  color: #8a4517;
}

.stake-chip.win strong {
  color: #7a3e10;
}

.stake-label {
  font-size: 13px;
  font-weight: 800;
}

.win-tag {
  position: absolute;
  top: -9px;
  left: -7px;
  padding: 1px 8px;
  border-radius: 7px;
  background: linear-gradient(180deg, #ffe27a, #f0b83c);
  border: 1px solid #a8731a;
  color: #7a3e10;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.round-net {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  color: #fff;
}

.round-net strong {
  min-width: 0;
  color: inherit;
  font-size: 15px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.coin-symbol {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 30% 30%, #fff2ba, #f4de9b 48%, #be9240 100%);
  color: #6d4b0f;
  font-size: 16px;
  font-weight: 900;
  box-shadow: inset 0 0 0 1px rgba(109, 75, 15, 0.18);
}

.history-result {
  position: relative;
  margin: 0 10px 12px;
  border-radius: 14px;
  background: linear-gradient(180deg, #fffbe9, #f7efd4);
  padding: 30px 10px 12px;
}

.result-tab {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 20px 6px;
  border-radius: 0 0 12px 12px;
  background: linear-gradient(180deg, #a05423, #8f4a1d);
  color: #ffd9a0;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.1em;
}

.result-hands {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.result-hand {
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.55);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hand-title {
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.hand-title b {
  font-size: 24px;
  font-weight: 900;
}

.hand-title b.player-total {
  color: #1f5dd3;
}

.hand-title b.banker-total {
  color: #d3372a;
}

.hand-badge {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 900;
  font-style: normal;
  background: #fff;
}

.hand-badge.player {
  color: #1f5dd3;
  border: 2px solid #1f5dd3;
}

.hand-badge.banker {
  color: #d3372a;
  border: 2px solid #d3372a;
}

.hand-cards {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 62px;
  justify-content: center;
}

.hand-card {
  width: 42px;
  height: 58px;
  border-radius: 7px;
  background: linear-gradient(180deg, #fffdf7, #f2ead6);
  border: 1px solid rgba(70, 50, 20, 0.22);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1;
  gap: 3px;
}

.hand-card b {
  font-size: 15px;
  font-weight: 900;
}

.hand-card small {
  font-size: 13px;
}

.hand-card.bonus {
  transform: rotate(90deg);
  margin: 0 6px;
}

.hand-cards.three-card-hand {
  flex-wrap: nowrap;
  gap: 6px;
}

.result-hand.three-card-result {
  padding-inline: 8px;
}

.three-card-hand .hand-card {
  width: 35px;
  height: 49px;
  flex: 0 0 auto;
}

.three-card-hand .hand-card.bonus {
  margin-inline: 4px;
}

.hand-card.red {
  color: #d3372a;
}

.hand-card.black {
  color: #16181d;
}

</style>
