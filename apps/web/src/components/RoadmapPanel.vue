<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import BeadRoadBoard from "./BeadRoadBoard.vue";
import BigRoadBoard from "./BigRoadBoard.vue";
import BigEyeRoadBoard from "./BigEyeRoadBoard.vue";
import CockroachRoadBoard from "./CockroachRoadBoard.vue";
import SmallRoadBoard from "./SmallRoadBoard.vue";
import {
  getBigEyeRoadColumnCount,
  getBigRoadColumnCount,
  getCockroachRoadColumnCount,
  getSmallRoadColumnCount,
} from "../lib/road-derivation";

type RoadRound = {
  winner: "PLAYER" | "BANKER" | "TIE";
  bankerTotal: number;
  playerPair: boolean;
  bankerPair: boolean;
};

type BaccaratPairType = "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";

interface Props {
  rounds?: RoadRound[] | null;
  visibility?: {
    beadRoad?: boolean;
    bigRoad?: boolean;
    bigEyeRoad?: boolean;
    smallRoad?: boolean;
    cockroachRoad?: boolean;
  };
}

const props = withDefaults(defineProps<Props>(), {
  rounds: null,
  visibility: () => ({
    beadRoad: true,
    bigRoad: true,
    bigEyeRoad: true,
    smallRoad: true,
    cockroachRoad: true,
  }),
});

const BEAD_CELL_PX = 22;
const ROAD_CELL_PX = 18;
const DERIVED_CELL_PX = 14;
const BOARD_ROWS = 6;

const chronologicalRounds = computed(() => [...(props.rounds ?? [])].reverse());
const beadViewportRef = ref<HTMLElement | null>(null);
const beadViewportHeight = ref(0);
let beadViewportObserver: ResizeObserver | null = null;

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

const bigRoadData = computed(() =>
  chronologicalRounds.value.map((round) => ({
    existBead: "EXIST" as const,
    winType: round.winner,
    fourBit: "ZERO" as const,
    directKilling: "NO" as const,
    baccaratPair: toBaccaratPairType(round),
  })),
);

const beadCols = computed(() => Math.max(6, Math.ceil(chronologicalRounds.value.length / BOARD_ROWS)));
const beadCellSize = computed(() => {
  if (!beadViewportHeight.value) {
    return BEAD_CELL_PX;
  }

  return Math.max(14, Math.floor(beadViewportHeight.value / BOARD_ROWS));
});
const bigRoadCols = computed(() => Math.max(18, getBigRoadColumnCount(bigRoadData.value, BOARD_ROWS)));
const bigEyeRoadCols = computed(() => Math.max(8, getBigEyeRoadColumnCount(bigRoadData.value, BOARD_ROWS)));
const smallRoadCols = computed(() => Math.max(8, getSmallRoadColumnCount(bigRoadData.value, BOARD_ROWS)));
const cockroachRoadCols = computed(() => Math.max(8, getCockroachRoadColumnCount(bigRoadData.value, BOARD_ROWS)));

const beadTrackWidth = computed(() => `${beadCols.value * beadCellSize.value}px`);
const beadTrackHeight = computed(() => `${BOARD_ROWS * beadCellSize.value}px`);
const bigRoadTrackWidth = computed(() => `${bigRoadCols.value * ROAD_CELL_PX}px`);
const bigEyeTrackWidth = computed(() => `${bigEyeRoadCols.value * DERIVED_CELL_PX}px`);
const smallRoadTrackWidth = computed(() => `${smallRoadCols.value * DERIVED_CELL_PX}px`);
const cockroachRoadTrackWidth = computed(() => `${cockroachRoadCols.value * DERIVED_CELL_PX}px`);
const visibleRoads = computed(() => ({
  beadRoad: props.visibility.beadRoad !== false,
  bigRoad: props.visibility.bigRoad !== false,
  bigEyeRoad: props.visibility.bigEyeRoad !== false,
  smallRoad: props.visibility.smallRoad !== false,
  cockroachRoad: props.visibility.cockroachRoad !== false,
}));
const visibleDerivedCount = computed(
  () =>
    Number(visibleRoads.value.bigEyeRoad) +
    Number(visibleRoads.value.smallRoad) +
    Number(visibleRoads.value.cockroachRoad),
);
const hasVisibleBoards = computed(
  () => visibleRoads.value.beadRoad || visibleRoads.value.bigRoad || visibleDerivedCount.value > 0,
);
const roadmapShellStyle = computed(() => ({
  gridTemplateColumns: visibleRoads.value.beadRoad ? "max-content max-content" : "max-content",
}));
const centerColumnStyle = computed(() => ({
  gridTemplateRows:
    visibleRoads.value.bigRoad && visibleDerivedCount.value > 0 ? "minmax(0, 1.45fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
}));
const derivedZoneStyle = computed(() => ({
  gridTemplateColumns: `repeat(${Math.max(1, visibleDerivedCount.value)}, max-content)`,
}));

function syncBeadViewportHeight() {
  if (!beadViewportRef.value) {
    return;
  }

  beadViewportHeight.value = beadViewportRef.value.clientHeight;
}

onMounted(async () => {
  await nextTick();
  syncBeadViewportHeight();

  if (typeof ResizeObserver !== "undefined") {
    beadViewportObserver = new ResizeObserver(() => {
      syncBeadViewportHeight();
    });

    if (beadViewportRef.value) {
      beadViewportObserver.observe(beadViewportRef.value);
    }

    return;
  }

  window.addEventListener("resize", syncBeadViewportHeight);
});

onUnmounted(() => {
  beadViewportObserver?.disconnect();

  if (!beadViewportObserver) {
    window.removeEventListener("resize", syncBeadViewportHeight);
  }
});
</script>

<template>
  <div class="roadmap-scroll">
    <section v-if="hasVisibleBoards" class="roadmap-shell" :style="roadmapShellStyle">
      <div v-if="visibleRoads.beadRoad" class="road-column bead-column">
        <div ref="beadViewportRef" class="board-surface">
          <div class="board-track bead-track" :style="{ width: beadTrackWidth, height: beadTrackHeight }">
            <BeadRoadBoard :rounds="chronologicalRounds" :rows="BOARD_ROWS" :cols="beadCols" :cell-size="beadCellSize" />
          </div>
        </div>
      </div>

      <div class="road-column center-column" :style="centerColumnStyle">
        <div v-if="visibleRoads.bigRoad" class="big-road-zone">
          <div class="board-surface">
            <div class="board-track" :style="{ width: bigRoadTrackWidth }">
              <BigRoadBoard :big-road="bigRoadData" :cols="bigRoadCols" :rows="BOARD_ROWS" />
            </div>
          </div>
        </div>

        <div v-if="visibleDerivedCount > 0" class="derived-zone" :style="derivedZoneStyle">
          <div v-if="visibleRoads.bigEyeRoad" class="derived-card">
            <div class="board-surface compact-surface">
              <div class="board-track" :style="{ width: bigEyeTrackWidth }">
                <BigEyeRoadBoard :big-road="bigRoadData" :cols="bigEyeRoadCols" :rows="BOARD_ROWS" />
              </div>
            </div>
          </div>

          <div v-if="visibleRoads.smallRoad" class="derived-card">
            <div class="board-surface compact-surface">
              <div class="board-track" :style="{ width: smallRoadTrackWidth }">
                <SmallRoadBoard :big-road="bigRoadData" :cols="smallRoadCols" :rows="BOARD_ROWS" />
              </div>
            </div>
          </div>

          <div v-if="visibleRoads.cockroachRoad" class="derived-card">
            <div class="board-surface compact-surface">
              <div class="board-track" :style="{ width: cockroachRoadTrackWidth }">
                <CockroachRoadBoard :big-road="bigRoadData" :cols="cockroachRoadCols" :rows="BOARD_ROWS" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-else class="roadmap-empty">
      <p>目前未選擇任何路圖</p>
    </section>
  </div>
</template>

<style scoped>
.roadmap-scroll {
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}

.roadmap-shell {
  display: grid;
  gap: 10px;
  min-width: max-content;
  height: 100%;
  padding: 10px;
  border-radius: 18px;
  background: linear-gradient(180deg, #f9f8f1, #efede3);
  box-shadow:
    0 14px 28px rgba(0, 0, 0, 0.22),
    inset 0 0 0 1px rgba(255, 255, 255, 0.7);
}

.road-column,
.center-column,
.big-road-zone,
.derived-zone,
.derived-card {
  min-height: 0;
}

.center-column {
  display: grid;
  grid-template-rows: minmax(0, 1.45fr) minmax(0, 1fr);
  gap: 10px;
}

.derived-zone {
  display: grid;
  grid-template-columns: repeat(3, max-content);
  gap: 10px;
}

.board-surface {
  height: 100%;
  border-radius: 10px;
  overflow: hidden;
  background: #faf9f2;
  border: 1px solid rgba(25, 25, 25, 0.08);
}

.compact-surface {
  min-height: 72px;
}

.board-track {
  height: 100%;
}

.bead-track {
  height: auto;
}

.roadmap-empty {
  width: 100%;
  height: 100%;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, #f9f8f1, #efede3);
  color: rgba(17, 17, 17, 0.58);
  font-size: 14px;
  font-weight: 700;
}
</style>
