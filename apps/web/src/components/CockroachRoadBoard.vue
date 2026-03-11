<script setup lang="ts">
import { computed } from "vue";
import { buildCockroachRoadGrid, type BaccaratGameData } from "../lib/road-derivation";

interface Props {
  bigRoad?: BaccaratGameData[] | null;
  rows?: number;
  cols?: number;
}

const props = withDefaults(defineProps<Props>(), {
  bigRoad: null,
  rows: 6,
  cols: 13,
});

const rowCount = computed(() => Math.max(1, props.rows));
const colCount = computed(() => Math.max(1, props.cols));
const grid = computed(() => buildCockroachRoadGrid(props.bigRoad ?? [], rowCount.value, colCount.value));
</script>

<template>
  <div class="cockroach-road" :style="{ '--road-rows': String(rowCount), '--road-cols': String(colCount) }">
    <div v-for="(row, rowIndex) in grid" :key="rowIndex" class="cockroach-road-row">
      <div v-for="(cell, colIndex) in row" :key="`${rowIndex}-${colIndex}`" class="cockroach-road-cell">
        <div v-if="cell" class="cockroach-road-token" :class="cell.toLowerCase()" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cockroach-road {
  display: grid;
  width: 100%;
  grid-template-rows: repeat(var(--road-rows), 1fr);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}

.cockroach-road-row {
  display: grid;
  grid-template-columns: repeat(var(--road-cols), minmax(12px, 1fr));
}

.cockroach-road-cell {
  aspect-ratio: 1;
  min-width: 12px;
  min-height: 12px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.015);
}

.cockroach-road-token {
  width: 9px;
  height: 2px;
  border-radius: 999px;
  transform: rotate(-55deg);
  transform-origin: center;
}

.cockroach-road-token.red {
  background: #ff5f57;
}

.cockroach-road-token.blue {
  background: #5a9bff;
}
</style>
