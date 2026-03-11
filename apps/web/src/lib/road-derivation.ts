export type GameResult = "PLAYER" | "BANKER" | "BANKER_SIX" | "TIE";
export type PositionWinType = "PLAYER" | "BANKER";
export type DerivedRoadColor = "RED" | "BLUE";

export interface BaccaratGameData {
  existBead: "EXIST" | "NOT_EXIST";
  winType: GameResult;
  fourBit: "ZERO" | "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "SIX" | "SEVEN" | "EIGHT" | "NINE";
  directKilling: "YES" | "NO";
  baccaratPair: "PLAYER_PAIR" | "BANKER_PAIR" | "BOTH_PAIR" | "NO_PAIR";
}

export type BigRoadPlacement = {
  col: number;
  row: number;
};

type DerivedRoadPlacement = BigRoadPlacement & {
  color: DerivedRoadColor;
};

type DerivedRoadConfig = {
  start: BigRoadPlacement;
  fallbackStart: BigRoadPlacement;
  sameRowCompareOffset: number;
};

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

function getFourBitNumber(fourBit: BaccaratGameData["fourBit"]) {
  return FOUR_BIT_MAP[fourBit] ?? 0;
}

function normalizeWinType(winType: GameResult): PositionWinType | null {
  switch (winType) {
    case "PLAYER":
      return "PLAYER";
    case "BANKER":
    case "BANKER_SIX":
      return "BANKER";
    default:
      return null;
  }
}

function isTieRound(gameData: BaccaratGameData) {
  return getFourBitNumber(gameData.fourBit) > 0 || gameData.winType === "TIE";
}

export function buildBigRoadPlacements(gameDataList: BaccaratGameData[], rowCount = 6) {
  const occupied = new Set<string>();
  const placements: BigRoadPlacement[] = [];
  let currentCol = 0;
  let currentRow = 0;
  let prevWin: PositionWinType | null = null;
  let isFirst = true;
  let anchorCol = 0;
  let isTailing = false;

  for (const gameData of gameDataList) {
    if (isTieRound(gameData)) {
      continue;
    }

    const curWin = normalizeWinType(gameData.winType);

    if (!curWin) {
      continue;
    }

    if (isFirst) {
      currentCol = 0;
      currentRow = 0;
      anchorCol = 0;
      isTailing = false;
      isFirst = false;
    } else if (curWin === prevWin) {
      if (isTailing) {
        currentCol += 1;
      } else {
        const nextRow = currentRow + 1;
        if (nextRow < rowCount && !occupied.has(`${currentCol}:${nextRow}`)) {
          currentRow = nextRow;
        } else {
          currentCol += 1;
          isTailing = true;
        }
      }
    } else {
      currentCol = anchorCol + 1;
      currentRow = 0;

      while (occupied.has(`${currentCol}:0`)) {
        currentCol += 1;
      }

      anchorCol = currentCol;
      isTailing = false;
    }

    occupied.add(`${currentCol}:${currentRow}`);
    placements.push({ col: currentCol, row: currentRow });
    prevWin = curWin;
  }

  return placements;
}

function buildColumnHeights(placements: BigRoadPlacement[]) {
  const heights = new Map<number, number>();

  for (const placement of placements) {
    heights.set(placement.col, Math.max(heights.get(placement.col) ?? 0, placement.row + 1));
  }

  return heights;
}

function getDerivedRoadStartIndex(placements: BigRoadPlacement[], config: DerivedRoadConfig) {
  const primaryIndex = placements.findIndex(
    (placement) => placement.col === config.start.col && placement.row === config.start.row,
  );

  if (primaryIndex >= 0) {
    return primaryIndex;
  }

  return placements.findIndex(
    (placement) => placement.col === config.fallbackStart.col && placement.row === config.fallbackStart.row,
  );
}

function deriveRoadColors(placements: BigRoadPlacement[], config: DerivedRoadConfig) {
  const startIndex = getDerivedRoadStartIndex(placements, config);

  if (startIndex < 0) {
    return [] as DerivedRoadColor[];
  }

  const colors: DerivedRoadColor[] = [];
  const occupied = new Set(placements.map((placement) => `${placement.col}:${placement.row}`));
  const heights = buildColumnHeights(placements);

  for (const placement of placements.slice(startIndex)) {
    if (placement.row === 0) {
      const leftTwoHeight = heights.get(placement.col - 2) ?? 0;
      const leftOneHeight = heights.get(placement.col - 1) ?? 0;
      colors.push(leftTwoHeight === leftOneHeight ? "RED" : "BLUE");
      continue;
    }

    colors.push(occupied.has(`${placement.col - config.sameRowCompareOffset}:${placement.row}`) ? "RED" : "BLUE");
  }

  return colors;
}

function buildDerivedPlacements(colors: DerivedRoadColor[], rowCount: number) {
  const placements: DerivedRoadPlacement[] = [];
  const occupied = new Set<string>();
  let currentCol = 0;
  let currentRow = 0;
  let previousColor: DerivedRoadColor | null = null;
  let anchorCol = 0;
  let isFirst = true;
  let isTailing = false;

  for (const color of colors) {
    if (isFirst) {
      currentCol = 0;
      currentRow = 0;
      anchorCol = 0;
      isTailing = false;
      isFirst = false;
    } else if (color === previousColor) {
      if (isTailing) {
        currentCol += 1;
      } else {
        const nextRow = currentRow + 1;

        if (nextRow < rowCount && !occupied.has(`${currentCol}:${nextRow}`)) {
          currentRow = nextRow;
        } else {
          currentCol += 1;
          isTailing = true;
        }
      }
    } else {
      currentCol = anchorCol + 1;
      currentRow = 0;

      while (occupied.has(`${currentCol}:0`)) {
        currentCol += 1;
      }

      anchorCol = currentCol;
      isTailing = false;
    }

    occupied.add(`${currentCol}:${currentRow}`);
    placements.push({ col: currentCol, row: currentRow, color });
    previousColor = color;
  }

  return placements;
}

function getPlacementColumnCount(placements: BigRoadPlacement[]) {
  const maxCol = placements.reduce((highest, placement) => Math.max(highest, placement.col), -1);
  return Math.max(0, maxCol + 1);
}

function buildVisibleGrid(placements: DerivedRoadPlacement[], rowCount: number, colCount: number) {
  const grid = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => null as DerivedRoadColor | null));
  const maxCol = placements.reduce((highest, placement) => Math.max(highest, placement.col), -1);
  const startCol = Math.max(0, maxCol - colCount + 1);

  for (const placement of placements) {
    if (placement.col < startCol) {
      continue;
    }

    const visibleCol = placement.col - startCol;

    if (visibleCol >= colCount) {
      continue;
    }

    grid[placement.row]![visibleCol] = placement.color;
  }

  return grid;
}

export function buildSmallRoadGrid(bigRoad: BaccaratGameData[], rowCount: number, colCount: number) {
  return buildVisibleGrid(
    buildDerivedPlacements(
      deriveRoadColors(buildBigRoadPlacements(bigRoad, rowCount), {
        start: { col: 2, row: 1 },
        fallbackStart: { col: 3, row: 0 },
        sameRowCompareOffset: 2,
      }),
      rowCount,
    ),
    rowCount,
    colCount,
  );
}

export function buildBigEyeRoadGrid(bigRoad: BaccaratGameData[], rowCount: number, colCount: number) {
  return buildVisibleGrid(
    buildDerivedPlacements(
      deriveRoadColors(buildBigRoadPlacements(bigRoad, rowCount), {
        start: { col: 1, row: 1 },
        fallbackStart: { col: 2, row: 0 },
        sameRowCompareOffset: 1,
      }),
      rowCount,
    ),
    rowCount,
    colCount,
  );
}

export function buildCockroachRoadGrid(bigRoad: BaccaratGameData[], rowCount: number, colCount: number) {
  return buildVisibleGrid(
    buildDerivedPlacements(
      deriveRoadColors(buildBigRoadPlacements(bigRoad, rowCount), {
        start: { col: 3, row: 1 },
        fallbackStart: { col: 4, row: 0 },
        sameRowCompareOffset: 3,
      }),
      rowCount,
    ),
    rowCount,
    colCount,
  );
}

export function getBigRoadColumnCount(bigRoad: BaccaratGameData[], rowCount: number) {
  return getPlacementColumnCount(buildBigRoadPlacements(bigRoad, rowCount));
}

export function getSmallRoadColumnCount(bigRoad: BaccaratGameData[], rowCount: number) {
  return getPlacementColumnCount(
    buildDerivedPlacements(
      deriveRoadColors(buildBigRoadPlacements(bigRoad, rowCount), {
        start: { col: 2, row: 1 },
        fallbackStart: { col: 3, row: 0 },
        sameRowCompareOffset: 2,
      }),
      rowCount,
    ),
  );
}

export function getBigEyeRoadColumnCount(bigRoad: BaccaratGameData[], rowCount: number) {
  return getPlacementColumnCount(
    buildDerivedPlacements(
      deriveRoadColors(buildBigRoadPlacements(bigRoad, rowCount), {
        start: { col: 1, row: 1 },
        fallbackStart: { col: 2, row: 0 },
        sameRowCompareOffset: 1,
      }),
      rowCount,
    ),
  );
}

export function getCockroachRoadColumnCount(bigRoad: BaccaratGameData[], rowCount: number) {
  return getPlacementColumnCount(
    buildDerivedPlacements(
      deriveRoadColors(buildBigRoadPlacements(bigRoad, rowCount), {
        start: { col: 3, row: 1 },
        fallbackStart: { col: 4, row: 0 },
        sameRowCompareOffset: 3,
      }),
      rowCount,
    ),
  );
}
