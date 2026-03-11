<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import BeadRoadBoard from "./BeadRoadBoard.vue";
import BigRoadBoard from "./BigRoadBoard.vue";
import BigEyeRoadBoard from "./BigEyeRoadBoard.vue";
import CockroachRoadBoard from "./CockroachRoadBoard.vue";
import SmallRoadBoard from "./SmallRoadBoard.vue";
import {
  DEFAULT_ROAD_VISIBILITY_SETTINGS,
  ROADMAP_BEAD_CELL_PX,
  ROADMAP_BIG_ROAD_CELL_PX,
  ROADMAP_BOARD_ROWS,
  ROADMAP_DERIVED_CELL_PX,
  ROADMAP_MIN_BEAD_CELL_PX,
  ROADMAP_MIN_BIG_ROAD_CELL_PX,
  ROADMAP_MIN_DERIVED_CELL_PX,
  ROADMAP_MIN_BEAD_COLS,
  ROADMAP_MIN_BIG_ROAD_COLS,
  ROADMAP_MIN_DERIVED_COLS,
} from "../const/roadmap";
import type { ActiveRound, BaccaratPairType, RoadVisibilitySettings } from "../types/domain";
import {
  getBigEyeRoadColumnCount,
  getBigRoadColumnCount,
  getCockroachRoadColumnCount,
  getSmallRoadColumnCount,
} from "../lib/road-derivation";

interface Props {
  rounds?: ActiveRound[] | null;
  visibility?: RoadVisibilitySettings;
}

const props = withDefaults(defineProps<Props>(), {
  rounds: null,
  visibility: () => ({ ...DEFAULT_ROAD_VISIBILITY_SETTINGS }),
});

const chronologicalRounds = computed(() => [...(props.rounds ?? [])].reverse());
const roadmapViewportRef = ref<HTMLElement | null>(null);
const beadViewportRef = ref<HTMLElement | null>(null);
const roadmapViewportHeight = ref(0);
const beadViewportHeight = ref(0);
let roadmapViewportObserver: ResizeObserver | null = null;
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

const beadCols = computed(() => Math.max(ROADMAP_MIN_BEAD_COLS, Math.ceil(chronologicalRounds.value.length / ROADMAP_BOARD_ROWS)));
const roadmapInnerHeight = computed(() => Math.max(0, roadmapViewportHeight.value - 20));
const centerColumnGapPx = 10;
const centerAvailableHeight = computed(() =>
  visibleRoads.value.bigRoad && visibleDerivedCount.value > 0
    ? Math.max(0, roadmapInnerHeight.value - centerColumnGapPx)
    : roadmapInnerHeight.value,
);
const bigRoadAvailableHeight = computed(() => {
  if (!visibleRoads.value.bigRoad) {
    return 0;
  }

  if (visibleDerivedCount.value > 0) {
    return Math.floor((centerAvailableHeight.value * 1.45) / 2.45);
  }

  return roadmapInnerHeight.value;
});
const derivedAvailableHeight = computed(() => {
  if (visibleDerivedCount.value === 0) {
    return 0;
  }

  if (visibleRoads.value.bigRoad) {
    return Math.floor(centerAvailableHeight.value / 2.45);
  }

  return roadmapInnerHeight.value;
});
const beadCellSize = computed(() => {
  if (!beadViewportHeight.value) {
    return ROADMAP_BEAD_CELL_PX;
  }

  return Math.max(ROADMAP_MIN_BEAD_CELL_PX, Math.floor(beadViewportHeight.value / ROADMAP_BOARD_ROWS));
});
const bigRoadCellSize = computed(() => {
  if (!bigRoadAvailableHeight.value) {
    return ROADMAP_BIG_ROAD_CELL_PX;
  }

  return Math.min(
    ROADMAP_BIG_ROAD_CELL_PX,
    Math.max(ROADMAP_MIN_BIG_ROAD_CELL_PX, Math.floor(bigRoadAvailableHeight.value / ROADMAP_BOARD_ROWS)),
  );
});
const derivedCellSize = computed(() => {
  if (!derivedAvailableHeight.value) {
    return ROADMAP_DERIVED_CELL_PX;
  }

  return Math.min(
    ROADMAP_DERIVED_CELL_PX,
    Math.max(ROADMAP_MIN_DERIVED_CELL_PX, Math.floor(derivedAvailableHeight.value / ROADMAP_BOARD_ROWS)),
  );
});
const bigRoadCols = computed(() => Math.max(ROADMAP_MIN_BIG_ROAD_COLS, getBigRoadColumnCount(bigRoadData.value, ROADMAP_BOARD_ROWS)));
const bigEyeRoadCols = computed(() => Math.max(ROADMAP_MIN_DERIVED_COLS, getBigEyeRoadColumnCount(bigRoadData.value, ROADMAP_BOARD_ROWS)));
const smallRoadCols = computed(() => Math.max(ROADMAP_MIN_DERIVED_COLS, getSmallRoadColumnCount(bigRoadData.value, ROADMAP_BOARD_ROWS)));
const cockroachRoadCols = computed(() => Math.max(ROADMAP_MIN_DERIVED_COLS, getCockroachRoadColumnCount(bigRoadData.value, ROADMAP_BOARD_ROWS)));

const beadTrackWidth = computed(() => `${beadCols.value * beadCellSize.value}px`);
const beadTrackHeight = computed(() => `${ROADMAP_BOARD_ROWS * beadCellSize.value}px`);
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
const bigRoadTrackWidth = computed(() => `${bigRoadCols.value * bigRoadCellSize.value}px`);
const bigRoadTrackHeight = computed(() => `${ROADMAP_BOARD_ROWS * bigRoadCellSize.value}px`);
const bigEyeTrackWidth = computed(() => `${bigEyeRoadCols.value * derivedCellSize.value}px`);
const bigEyeTrackHeight = computed(() => `${ROADMAP_BOARD_ROWS * derivedCellSize.value}px`);
const smallRoadTrackWidth = computed(() => `${smallRoadCols.value * derivedCellSize.value}px`);
const smallRoadTrackHeight = computed(() => `${ROADMAP_BOARD_ROWS * derivedCellSize.value}px`);
const cockroachRoadTrackWidth = computed(() => `${cockroachRoadCols.value * derivedCellSize.value}px`);
const cockroachRoadTrackHeight = computed(() => `${ROADMAP_BOARD_ROWS * derivedCellSize.value}px`);

function syncBeadViewportHeight() {
  if (!beadViewportRef.value) {
    return;
  }

  beadViewportHeight.value = beadViewportRef.value.clientHeight;
}

function syncRoadmapViewportHeight() {
  if (!roadmapViewportRef.value) {
    return;
  }

  roadmapViewportHeight.value = roadmapViewportRef.value.clientHeight;
}

onMounted(async () => {
  await nextTick();
  syncRoadmapViewportHeight();
  syncBeadViewportHeight();

  if (typeof ResizeObserver !== "undefined") {
    roadmapViewportObserver = new ResizeObserver(() => {
      syncRoadmapViewportHeight();
    });
    beadViewportObserver = new ResizeObserver(() => {
      syncBeadViewportHeight();
    });

    if (roadmapViewportRef.value) {
      roadmapViewportObserver.observe(roadmapViewportRef.value);
    }

    if (beadViewportRef.value) {
      beadViewportObserver.observe(beadViewportRef.value);
    }

    return;
  }

  window.addEventListener("resize", syncRoadmapViewportHeight);
  window.addEventListener("resize", syncBeadViewportHeight);
});

onUnmounted(() => {
  roadmapViewportObserver?.disconnect();
  beadViewportObserver?.disconnect();

  if (!roadmapViewportObserver && !beadViewportObserver) {
    window.removeEventListener("resize", syncRoadmapViewportHeight);
    window.removeEventListener("resize", syncBeadViewportHeight);
  }
});
</script>

<template>
  <div ref="roadmapViewportRef" class="roadmap-scroll">
    <section v-if="hasVisibleBoards" class="roadmap-shell" :style="roadmapShellStyle">
      <div v-if="visibleRoads.beadRoad" class="road-column bead-column">
        <div ref="beadViewportRef" class="board-surface">
          <div class="board-track bead-track" :style="{ width: beadTrackWidth, height: beadTrackHeight }">
            <BeadRoadBoard :rounds="chronologicalRounds" :rows="ROADMAP_BOARD_ROWS" :cols="beadCols" :cell-size="beadCellSize" />
          </div>
        </div>
      </div>

      <div class="road-column center-column" :style="centerColumnStyle">
        <div v-if="visibleRoads.bigRoad" class="big-road-zone">
          <div class="board-surface">
            <div class="board-track" :style="{ width: bigRoadTrackWidth, height: bigRoadTrackHeight }">
              <BigRoadBoard
                :big-road="bigRoadData"
                :cols="bigRoadCols"
                :rows="ROADMAP_BOARD_ROWS"
                :cell-size="bigRoadCellSize"
                :token-size="5"
              />
            </div>
          </div>
        </div>

        <div v-if="visibleDerivedCount > 0" class="derived-zone" :style="derivedZoneStyle">
          <div v-if="visibleRoads.bigEyeRoad" class="derived-card">
            <div class="board-surface compact-surface">
              <div class="board-track" :style="{ width: bigEyeTrackWidth, height: bigEyeTrackHeight }">
                <BigEyeRoadBoard
                  :big-road="bigRoadData"
                  :cols="bigEyeRoadCols"
                  :rows="ROADMAP_BOARD_ROWS"
                  :cell-size="derivedCellSize"
                />
              </div>
            </div>
          </div>

          <div v-if="visibleRoads.smallRoad" class="derived-card">
            <div class="board-surface compact-surface">
              <div class="board-track" :style="{ width: smallRoadTrackWidth, height: smallRoadTrackHeight }">
                <SmallRoadBoard :big-road="bigRoadData" :cols="smallRoadCols" :rows="ROADMAP_BOARD_ROWS" :cell-size="derivedCellSize" />
              </div>
            </div>
          </div>

          <div v-if="visibleRoads.cockroachRoad" class="derived-card">
            <div class="board-surface compact-surface">
              <div class="board-track" :style="{ width: cockroachRoadTrackWidth, height: cockroachRoadTrackHeight }">
                <CockroachRoadBoard
                  :big-road="bigRoadData"
                  :cols="cockroachRoadCols"
                  :rows="ROADMAP_BOARD_ROWS"
                  :cell-size="derivedCellSize"
                />
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
