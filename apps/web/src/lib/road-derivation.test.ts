import { describe, expect, it } from "vitest";
import {
  buildBigEyeRoadGrid,
  buildBigRoadPlacements,
  buildCockroachRoadGrid,
  buildSmallRoadGrid,
  type BaccaratGameData,
  type GameResult,
} from "./road-derivation";

function result(winType: GameResult, tieCount = 0): BaccaratGameData {
  const fourBit = ["ZERO", "ONE", "TWO", "THREE"] as const;
  return {
    existBead: "EXIST",
    winType,
    fourBit: fourBit[tieCount] ?? "ZERO",
    directKilling: "NO",
    baccaratPair: "NO_PAIR",
  };
}

function occupiedCells(grid: ReturnType<typeof buildBigEyeRoadGrid>) {
  return grid.flatMap((row, rowIndex) =>
    row.flatMap((cell, colIndex) => (cell ? [{ row: rowIndex, col: colIndex, ...cell }] : [])),
  );
}

describe("road derivation", () => {
  it("ignores ties and normalizes banker-six when placing the Big Road", () => {
    const sequence = [
      result("PLAYER"),
      result("TIE"),
      result("PLAYER", 1),
      result("BANKER_SIX"),
      result("BANKER"),
    ];

    expect(buildBigRoadPlacements(sequence)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 1, row: 1 },
    ]);
  });

  it("turns a streak into a tail at the bottom and when another column blocks it", () => {
    const sequence = [
      ...Array.from({ length: 7 }, () => result("PLAYER")),
      ...Array.from({ length: 6 }, () => result("BANKER")),
      result("PLAYER"),
    ];

    expect(buildBigRoadPlacements(sequence)).toEqual([
      { col: 0, row: 0 }, { col: 0, row: 1 }, { col: 0, row: 2 },
      { col: 0, row: 3 }, { col: 0, row: 4 }, { col: 0, row: 5 },
      { col: 1, row: 5 },
      { col: 1, row: 0 }, { col: 1, row: 1 }, { col: 1, row: 2 },
      { col: 1, row: 3 }, { col: 1, row: 4 }, { col: 2, row: 4 },
      { col: 2, row: 0 },
    ]);
  });

  it("derives stable Big Eye, Small, and Cockroach colors for a known shoe", () => {
    const sequence = [
      result("PLAYER"), result("PLAYER"),
      result("BANKER"), result("BANKER"), result("BANKER"),
      result("PLAYER"), result("PLAYER"), result("PLAYER"), result("PLAYER"),
      result("BANKER"), result("PLAYER"), result("BANKER"), result("BANKER"),
    ];

    expect(occupiedCells(buildBigEyeRoadGrid(sequence, 6, 12))).toEqual([
      { row: 0, col: 0, color: "RED", originalIndex: 0 },
      { row: 0, col: 1, color: "BLUE", originalIndex: 1 },
      { row: 0, col: 2, color: "RED", originalIndex: 3 },
      { row: 0, col: 3, color: "BLUE", originalIndex: 5 },
      { row: 0, col: 4, color: "RED", originalIndex: 8 },
      { row: 0, col: 5, color: "BLUE", originalIndex: 9 },
      { row: 1, col: 1, color: "BLUE", originalIndex: 2 },
      { row: 1, col: 2, color: "RED", originalIndex: 4 },
      { row: 1, col: 3, color: "BLUE", originalIndex: 6 },
      { row: 2, col: 3, color: "BLUE", originalIndex: 7 },
    ]);
    expect(occupiedCells(buildSmallRoadGrid(sequence, 6, 12))).toEqual([
      { row: 0, col: 0, color: "RED", originalIndex: 0 },
      { row: 0, col: 1, color: "BLUE", originalIndex: 1 },
      { row: 0, col: 2, color: "RED", originalIndex: 5 },
      { row: 0, col: 3, color: "BLUE", originalIndex: 6 },
      { row: 1, col: 1, color: "BLUE", originalIndex: 2 },
      { row: 2, col: 1, color: "BLUE", originalIndex: 3 },
      { row: 3, col: 1, color: "BLUE", originalIndex: 4 },
    ]);
    expect(occupiedCells(buildCockroachRoadGrid(sequence, 6, 12))).toEqual([
      { row: 0, col: 0, color: "BLUE", originalIndex: 0 },
      { row: 0, col: 1, color: "RED", originalIndex: 1 },
      { row: 1, col: 1, color: "RED", originalIndex: 2 },
    ]);
  });
});
