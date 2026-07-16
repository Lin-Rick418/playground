<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import BeadRoadBoard from "./BeadRoadBoard.vue";
import BigRoadBoard from "./BigRoadBoard.vue";
import { toBaccaratPairType } from "../const/game";
import { ROADMAP_BOARD_ROWS } from "../const/roadmap";
import type { ActiveRound } from "../types/domain";

const props = defineProps<{ rounds: ActiveRound[] }>();

const chronologicalRounds = computed(() => [...props.rounds].reverse());

const bigRoadData = computed(() =>
  chronologicalRounds.value.map((round) => ({
    existBead: "EXIST" as const,
    winType: round.winner,
    fourBit: "ZERO" as const,
    directKilling: "NO" as const,
    baccaratPair: toBaccaratPairType(round),
  })),
);

const boardRef = ref<HTMLElement | null>(null);
const bigRoadScrollRef = ref<HTMLElement | null>(null);
const boardWidth = ref(0);
let boardObserver: ResizeObserver | null = null;

const cols = computed(() => Math.max(12, Math.floor(boardWidth.value / 22)) || 15);
const cellSize = computed(() => (boardWidth.value ? Math.floor(boardWidth.value / cols.value) : 22));

function syncBoardWidth() {
  if (boardRef.value) {
    boardWidth.value = boardRef.value.clientWidth;
  }
}

function scrollBigRoadToEnd() {
  const el = bigRoadScrollRef.value;
  if (el) {
    el.scrollLeft = el.scrollWidth;
  }
}

watch(
  () => [bigRoadData.value.length, cols.value, cellSize.value] as const,
  () => {
    void nextTick(scrollBigRoadToEnd);
  },
);

onMounted(() => {
  syncBoardWidth();
  void nextTick(scrollBigRoadToEnd);

  if (typeof ResizeObserver !== "undefined" && boardRef.value) {
    boardObserver = new ResizeObserver(syncBoardWidth);
    boardObserver.observe(boardRef.value);
    return;
  }

  window.addEventListener("resize", syncBoardWidth);
});

onUnmounted(() => {
  boardObserver?.disconnect();

  if (!boardObserver) {
    window.removeEventListener("resize", syncBoardWidth);
  }
});
</script>

<template>
  <section class="roadmap-panel">
    <div ref="boardRef" class="roadmap-boards">
      <div ref="bigRoadScrollRef" class="road-block big-road-block">
        <BigRoadBoard :big-road="bigRoadData" :cols="cols" :rows="ROADMAP_BOARD_ROWS" :cell-size="cellSize" :token-size="Math.max(7, Math.round(cellSize * 0.6))" full-history />
      </div>
      <div class="road-block bead-block">
        <BeadRoadBoard :rounds="chronologicalRounds" :cols="cols" :rows="ROADMAP_BOARD_ROWS" :cell-size="cellSize" :show-label="false" />
      </div>
    </div>

    <div class="roadmap-legend" aria-label="路單圖例">
      <span class="legend-item"><i class="legend-token player" />閒贏</span>
      <span class="legend-item"><i class="legend-token banker" />莊贏</span>
      <span class="legend-item"><i class="legend-token tie" />和</span>
      <span class="legend-item"><i class="legend-token player"><b class="legend-dot player-dot" /></i>閒對</span>
      <span class="legend-item"><i class="legend-token banker"><b class="legend-dot banker-dot" /></i>莊對</span>
    </div>
  </section>
</template>

<style scoped lang="scss">
.roadmap-panel {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  width: 100%;
}

.roadmap-boards {
  width: 100%;
  border-radius: 12px;
  overflow: hidden;
  background: #faf9f2;
  box-shadow: inset 0 0 0 1px rgba(27, 27, 27, 0.12);
}

.road-block {
  width: 100%;
}

.big-road-block {
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.big-road-block::-webkit-scrollbar {
  display: none;
}

.big-road-block :deep(.big-road) {
  border-top: 1px solid rgba(27, 27, 27, 0.1);
  border-left: 1px solid rgba(27, 27, 27, 0.1);
}

.big-road-block :deep(.big-road-cell) {
  border-right: 1px solid rgba(27, 27, 27, 0.1);
  border-bottom: 1px solid rgba(27, 27, 27, 0.1);
  background: transparent;
}

.bead-block {
  border-top: 2px solid rgba(27, 27, 27, 0.18);
}

.roadmap-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-3;
  padding: 0 $space-1;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: $space-1;
  font-size: 13px;
  font-weight: 800;
  color: $color-text-primary;
}

.legend-token {
  position: relative;
  width: 18px;
  height: 18px;
  border-radius: 999px;
}

.legend-token.player {
  background: #4b8eff;
}

.legend-token.banker {
  background: #e54b43;
}

.legend-token.tie {
  background: #3bb35f;
}

.legend-dot {
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.9);
}

.legend-dot.player-dot {
  right: 0;
  bottom: 0;
  background: #4b8eff;
}

.legend-dot.banker-dot {
  top: 0;
  left: 0;
  background: #e54b43;
}
</style>
