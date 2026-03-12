<script setup lang="ts">
import { computed } from "vue";

type BeadRound = {
  winner: "PLAYER" | "BANKER" | "TIE";
  bankerTotal: number;
  playerPair: boolean;
  bankerPair: boolean;
};

interface Props {
  rounds?: BeadRound[] | null;
  rows?: number;
  cols?: number;
  cellSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  rounds: null,
  rows: 6,
  cols: 6,
  cellSize: 22,
});

const rowCount = computed(() => Math.max(1, props.rows));
const colCount = computed(() => Math.max(1, props.cols));
const cellSize = computed(() => Math.max(12, props.cellSize));

const visibleRounds = computed(() => {
  const rounds = props.rounds ?? [];
  const maxCount = rowCount.value * colCount.value;
  return rounds.slice(-maxCount);
});

const grid = computed(() => {
  const matrix = Array.from({ length: rowCount.value }, () => Array.from({ length: colCount.value }, () => null as BeadRound | null));

  visibleRounds.value.forEach((round, index) => {
    const col = Math.floor(index / rowCount.value);
    const row = index % rowCount.value;

    if (col < colCount.value) {
      matrix[row]![col] = round;
    }
  });

  return matrix;
});

function beadLabel(round: BeadRound) {
  if (round.winner === "BANKER") {
    return round.bankerTotal === 6 ? "6" : "莊";
  }

  if (round.winner === "PLAYER") {
    return "閒";
  }

  return "和";
}

function beadClass(round: BeadRound) {
  return round.winner === "BANKER" ? "banker" : round.winner === "PLAYER" ? "player" : "tie";
}
</script>

<template>
  <div
    class="bead-road"
    :style="{
      '--road-rows': String(rowCount),
      '--road-cols': String(colCount),
      '--cell-size': `${cellSize}px`,
      '--bead-font-size': `${Math.max(10, Math.round(cellSize * 0.48))}px`,
    }"
  >
    <div v-for="(row, rowIndex) in grid" :key="rowIndex" class="bead-road-row">
      <div v-for="(cell, colIndex) in row" :key="`${rowIndex}-${colIndex}`" class="bead-road-cell">
        <div v-if="cell" class="bead-token" :class="beadClass(cell)">
          <span>{{ beadLabel(cell) }}</span>
          <i v-if="cell.bankerPair" class="pair-dot banker-pair" />
          <i v-if="cell.playerPair" class="pair-dot player-pair" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bead-road {
  display: grid;
  width: max-content;
  grid-template-rows: repeat(var(--road-rows), var(--cell-size));
  border-top: 1px solid rgba(27, 27, 27, 0.1);
  border-left: 1px solid rgba(27, 27, 27, 0.1);
  background: #faf9f2;
}

.bead-road-row {
  display: grid;
  grid-template-columns: repeat(var(--road-cols), var(--cell-size));
}

.bead-road-cell {
  width: var(--cell-size);
  height: var(--cell-size);
  border-right: 1px solid rgba(27, 27, 27, 0.1);
  border-bottom: 1px solid rgba(27, 27, 27, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.bead-token {
  position: relative;
  width: 88%;
  height: 88%;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--bead-font-size);
  font-weight: 900;
  color: #fff;
}

.bead-token.banker {
  background: #e54b43;
}

.bead-token.player {
  background: #4b8eff;
}

.bead-token.tie {
  background: #3bb35f;
}

.pair-dot {
  position: absolute;
  width: 20%;
  height: 20%;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.85);
}

.banker-pair {
  top: 10%;
  left: 10%;
  background: #e54b43;
}

.player-pair {
  right: 10%;
  bottom: 10%;
  background: #4b8eff;
}
</style>
