<script setup lang="ts">
import { computed } from "vue";
import { buildSmallRoadGrid, type BaccaratGameData } from "../lib/road-derivation";

interface Props {
  bigRoad: BaccaratGameData[];
  rows?: number;
  cols?: number;
  cellSize?: number;
  previewIndex?: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  rows: 6,
  cols: 13,
  cellSize: 14,
  previewIndex: null,
});

const rowCount = computed(() => Math.max(1, props.rows));
const colCount = computed(() => Math.max(1, props.cols));
const cellSize = computed(() => Math.max(1, props.cellSize));
const grid = computed(() => buildSmallRoadGrid(props.bigRoad, rowCount.value, colCount.value));
const previewDisplayIndex = computed(() => {
  if (props.previewIndex === null) {
    return null;
  }

  return grid.value.reduce<number | null>((latest, row) => {
    for (const cell of row) {
      if (!cell) {
        continue;
      }

      latest = latest === null ? cell.originalIndex : Math.max(latest, cell.originalIndex);
    }

    return latest;
  }, null);
});
</script>

<template>
  <div
    class="small-road"
    :style="{
      '--road-rows': String(rowCount),
      '--road-cols': String(colCount),
      '--road-cell-size': `${cellSize}px`,
      '--road-token-size': `${Math.max(4, Math.round(cellSize * 0.58))}px`,
    }"
    >
    <div v-for="(row, rowIndex) in grid" :key="rowIndex" class="small-road-row">
      <div v-for="(cell, colIndex) in row" :key="`${rowIndex}-${colIndex}`" class="small-road-cell">
        <div
          v-if="cell"
          class="small-road-token"
          :class="[cell.color.toLowerCase(), { preview: previewDisplayIndex === cell.originalIndex }]"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.small-road {
  display: grid;
  width: 100%;
  grid-template-rows: repeat(var(--road-rows), 1fr);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}

.small-road-row {
  display: grid;
  grid-template-columns: repeat(var(--road-cols), var(--road-cell-size));
}

.small-road-cell {
  aspect-ratio: 1;
  width: var(--road-cell-size);
  height: var(--road-cell-size);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.015);
}

.small-road-token {
  width: var(--road-token-size);
  height: var(--road-token-size);
  border-radius: 999px;
}

.small-road-token.preview {
  animation: ask-road-blink 0.82s steps(2, end) infinite;
  box-shadow: 0 0 6px currentColor;
}

.small-road-token.red {
  background: #ff5f57;
  color: #ff5f57;
}

.small-road-token.blue {
  background: #5a9bff;
  color: #5a9bff;
}

@keyframes ask-road-blink {
  0%,
  100% {
    opacity: 1;
    transform: scale(1.08);
  }
  50% {
    opacity: 0.14;
    transform: scale(0.88);
  }
}
</style>
