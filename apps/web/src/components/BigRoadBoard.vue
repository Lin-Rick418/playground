<script setup lang="ts">
import { computed } from "vue";
import type { BaccaratPairType } from "../types/domain";

type GameResult = "PLAYER" | "BANKER" | "BANKER_SIX" | "TIE";
type PositionWinType = "PLAYER" | "BANKER";

export interface BaccaratGameData {
  existBead: "EXIST" | "NOT_EXIST";
  winType: GameResult;
  fourBit: "ZERO" | "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "SIX" | "SEVEN" | "EIGHT" | "NINE";
  directKilling: "YES" | "NO";
  baccaratPair: BaccaratPairType;
}

interface GridCellData extends BaccaratGameData {
  originalIndex: number;
  hastie?: boolean;
  tieCount?: number;
  tieData?: BaccaratGameData;
}

type GridMatrix = (GridCellData | null)[][];

interface Props {
  bigRoad?: BaccaratGameData[] | null;
  rows?: number;
  cols?: number;
  cellSize?: number | null;
  tokenSize?: number | null;
  previewIndex?: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  bigRoad: null,
  rows: 6,
  cols: 13,
  cellSize: null,
  tokenSize: null,
  previewIndex: null,
});

const rowCount = computed(() => Math.max(1, props.rows));
const colCount = computed(() => Math.max(1, props.cols));
const fixedCellSize = computed(() => (typeof props.cellSize === "number" ? Math.max(1, props.cellSize) : null));
const tokenSize = computed(() => {
  if (typeof props.tokenSize === "number") {
    return Math.max(1, props.tokenSize);
  }

  if (fixedCellSize.value) {
    return Math.max(5, Math.round(fixedCellSize.value * 0.42));
  }

  return 12;
});

const FOUR_BIT_MAP = {
  ZERO: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
} as const;

const COLORS = {
  PLAYER: "rgba(92, 147, 222, 1)",
  BANKER: "rgba(255, 76, 70, 1)",
  DIRECT_KILL: "rgba(230, 194, 138, 1)",
  BANKER_SIX: "rgba(255, 144, 82, 1)",
  TIE_LINE: "rgba(66, 188, 29, 1)",
} as const;

const getFourBitNumber = (fourBit: BaccaratGameData["fourBit"]): number => FOUR_BIT_MAP[fourBit] ?? 0;

const normalizeWinType = (winType: GameResult): PositionWinType | null => {
  switch (winType) {
    case "PLAYER":
      return "PLAYER";
    case "BANKER":
    case "BANKER_SIX":
      return "BANKER";
    default:
      return null;
  }
};

const isTieRound = (gameData: BaccaratGameData): boolean =>
  getFourBitNumber(gameData.fourBit) > 0 || gameData.winType === "TIE";

const createEmptyGrid = (): GridMatrix =>
  Array.from({ length: rowCount.value }, () => Array.from({ length: colCount.value }, () => null));

interface GridState {
  col: number;
  row: number;
  prevWin: PositionWinType | null;
  isFirst: boolean;
  anchorCol: number;
  isTailing: boolean;
}

const createInitialState = (): GridState => ({
  col: 0,
  row: 0,
  prevWin: null,
  isFirst: true,
  anchorCol: 0,
  isTailing: false,
});

const simulateGridColumns = (gameDataList: BaccaratGameData[]): number => {
  let maxCol = 0;
  let currentCol = 0;
  let currentRow = 0;
  let prevWin: PositionWinType | null = null;
  let isFirst = true;
  let anchorCol = 0;
  let isTailing = false;

  for (const gameData of gameDataList) {
    if (isFirst && isTieRound(gameData)) {
      continue;
    }

    const curWin = normalizeWinType(gameData.winType);

    if (isFirst) {
      currentCol = 0;
      currentRow = 0;
      anchorCol = 0;
      isTailing = false;
      isFirst = false;
      maxCol = Math.max(maxCol, currentCol);
    } else if (isTieRound(gameData)) {
      continue;
    } else if (curWin === prevWin) {
      if (isTailing) {
        currentCol += 1;
      } else {
        const nextRow = currentRow + 1;
        if (nextRow < rowCount.value) {
          currentRow = nextRow;
        } else {
          currentCol += 1;
          isTailing = true;
        }
      }
      maxCol = Math.max(maxCol, currentCol);
    } else {
      currentCol = anchorCol + 1;
      currentRow = 0;
      anchorCol = currentCol;
      isTailing = false;
      maxCol = Math.max(maxCol, currentCol);
      prevWin = curWin;
    }

    if (!isTieRound(gameData)) {
      prevWin = curWin;
    }
  }

  return maxCol + 1;
};

const calculateMaxDisplayCount = (gameDataList: BaccaratGameData[]): number => {
  if (!gameDataList.length) {
    return 0;
  }

  const maxCols = colCount.value - 1;
  let currentCount = gameDataList.length;

  while (currentCount > 0) {
    const testData = gameDataList.slice(-currentCount);
    const usedColumns = simulateGridColumns(testData);

    if (usedColumns <= maxCols) {
      return currentCount;
    }

    currentCount -= 1;
  }

  return 0;
};

const initializeFirstPosition = (state: GridState): void => {
  Object.assign(state, {
    col: 0,
    row: 0,
    anchorCol: 0,
    isTailing: false,
    isFirst: false,
  });
};

const handleSameWinType = (grid: GridMatrix, state: GridState): void => {
  if (state.isTailing) {
    state.col += 1;
  } else {
    const nextRow = state.row + 1;
    const canMoveDown = nextRow < rowCount.value && !grid[nextRow]![state.col];

    if (canMoveDown) {
      state.row = nextRow;
    } else {
      state.col += 1;
      state.isTailing = true;
    }
  }
};

const handleDifferentWinType = (grid: GridMatrix, state: GridState): void => {
  state.col = state.anchorCol + 1;
  state.row = 0;

  // 換邊一定從新欄第一列開始；若該欄頂部已被佔用，則整欄往右找。
  while (state.col < colCount.value && grid[0]![state.col]) {
    state.col += 1;
  }

  state.col = Math.min(state.col, colCount.value - 1);
  state.anchorCol = state.col;
  state.isTailing = false;
};

const handleTieWrite = (grid: GridMatrix, state: GridState, gameData: BaccaratGameData, index: number): void => {
  const { row, col } = state;
  const fourBitNumber = getFourBitNumber(gameData.fourBit);
  const existingCell = grid[row]![col];

  if (existingCell) {
    const currentTieCount = existingCell.tieCount ?? 0;
    const newTieCount = fourBitNumber > 0 ? fourBitNumber : currentTieCount + 1;

    grid[row]![col] = {
      ...existingCell,
      hastie: true,
      tieCount: newTieCount,
      tieData: gameData,
    };
    return;
  }

  grid[row]![col] = {
    ...gameData,
    originalIndex: index,
    tieCount: Math.max(fourBitNumber, 1),
    hastie: true,
  };
};

const buildBigRoadGrid = (gameDataList: BaccaratGameData[] | null): GridMatrix => {
  if (!gameDataList?.length) {
    return createEmptyGrid();
  }

  const grid = createEmptyGrid();
  const state = createInitialState();

  gameDataList.forEach((gameData, index) => {
    if (state.isFirst && isTieRound(gameData)) {
      return;
    }

    const curWin = normalizeWinType(gameData.winType);

    if (state.isFirst) {
      initializeFirstPosition(state);
    } else if (isTieRound(gameData)) {
      handleTieWrite(grid, state, gameData, index);
      return;
    } else if (curWin === state.prevWin) {
      handleSameWinType(grid, state);
    } else {
      handleDifferentWinType(grid, state);
    }

    grid[state.row]![state.col] = {
      ...gameData,
      originalIndex: index,
    };
    state.prevWin = curWin;
  });

  return grid;
};

const displayGameData = computed<BaccaratGameData[]>(() => {
  if (!props.bigRoad?.length) {
    return [];
  }

  const maxDisplayCount = calculateMaxDisplayCount(props.bigRoad);
  return props.bigRoad.slice(-maxDisplayCount);
});
const previewDisplayIndex = computed(() => (props.previewIndex === null ? null : Math.max(0, displayGameData.value.length - 1)));

const grid = computed<GridMatrix>(() => buildBigRoadGrid(displayGameData.value));

const getStrokeColor = (cell: GridCellData): string => {
  switch (cell.winType) {
    case "PLAYER":
      return COLORS.PLAYER;
    case "BANKER":
    case "BANKER_SIX":
      return COLORS.BANKER;
    default:
      return "";
  }
};

const getInnerContent = (cell: GridCellData): string => {
  if (cell.directKilling === "YES") {
    return `<circle cx="5" cy="5" r="2" fill="${COLORS.DIRECT_KILL}" />`;
  }

  if (cell.winType === "BANKER_SIX") {
    return `<text x="5" y="7" text-anchor="middle" font-size="6" fill="${COLORS.BANKER_SIX}" font-family="sans-serif">6</text>`;
  }

  return "";
};

const getTieLines = (cell: GridCellData): string => {
  const tieCount = (cell.tieCount ?? getFourBitNumber(cell.fourBit)) || 0;

  if (!tieCount) {
    return "";
  }

  if (tieCount === 1) {
    return `<line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="${COLORS.TIE_LINE}" stroke-width="1" />`;
  }

  return `
    <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="${COLORS.TIE_LINE}" stroke-width="1" />
    <line x1="7.5" y1="0.5" x2="0.5" y2="7.5" stroke="${COLORS.TIE_LINE}" stroke-width="1" />
  `;
};

const getPairDots = (cell: GridCellData): string => {
  switch (cell.baccaratPair) {
    case "PLAYER_PAIR":
      return `<circle cx="8" cy="8" r="2" fill="${COLORS.PLAYER}" />`;
    case "BANKER_PAIR":
      return `<circle cx="2" cy="2" r="2" fill="${COLORS.BANKER}" />`;
    case "BOTH_PAIR":
      return `
        <circle cx="2" cy="2" r="2" fill="${COLORS.BANKER}" />
        <circle cx="8" cy="8" r="2" fill="${COLORS.PLAYER}" />
      `;
    default:
      return "";
  }
};

const getCircleSvg = (cell: GridCellData): string => `
  <svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
    <circle cx="5" cy="5" r="4" fill="none" stroke="${getStrokeColor(cell)}" stroke-width="1" />
    ${getInnerContent(cell)}
    ${getTieLines(cell)}
    ${getPairDots(cell)}
  </svg>
`;
</script>

<template>
  <div
    class="big-road"
    :class="{ fixed: !!fixedCellSize }"
    :style="{
      '--road-rows': String(rowCount),
      '--road-cols': String(colCount),
      '--road-cell-size': fixedCellSize ? `${fixedCellSize}px` : undefined,
      '--road-token-size': `${tokenSize}px`,
    }"
  >
    <div v-for="(row, rowIndex) in grid" :key="rowIndex" class="big-road-row">
      <div v-for="(cell, colIndex) in row" :key="`${rowIndex}-${colIndex}`" class="big-road-cell">
        <div v-if="cell" class="token" :class="{ preview: previewDisplayIndex === cell.originalIndex }" v-html="getCircleSvg(cell)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.big-road {
  display: grid;
  width: 100%;
  grid-template-rows: repeat(var(--road-rows), 1fr);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}

.big-road-row {
  display: grid;
  grid-template-columns: repeat(var(--road-cols), minmax(14px, 1fr));
}

.big-road.fixed .big-road-row {
  grid-template-columns: repeat(var(--road-cols), var(--road-cell-size));
}

.big-road-cell {
  aspect-ratio: 1;
  min-width: 14px;
  min-height: 14px;
  width: var(--road-cell-size);
  height: var(--road-cell-size);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.02);
}

.big-road:not(.fixed) .big-road-cell {
  width: auto;
  height: auto;
}

.token {
  width: var(--road-token-size);
  height: var(--road-token-size);
  display: flex;
  align-items: center;
  justify-content: center;
}

.token :deep(svg) {
  width: 100%;
  height: 100%;
}

.token.preview {
  animation: ask-road-blink 0.82s steps(2, end) infinite;
  filter: drop-shadow(0 0 6px rgba(92, 147, 222, 0.7));
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
