import type { RoadVisibilitySettings } from "../types/domain";

export const DEFAULT_ROAD_VISIBILITY_SETTINGS: RoadVisibilitySettings = {
  beadRoad: true,
  bigRoad: true,
  bigEyeRoad: true,
  smallRoad: true,
  cockroachRoad: true,
};

export const ROAD_VISIBILITY_OPTIONS = [
  { key: "beadRoad", label: "珠盤路" },
  { key: "bigRoad", label: "大路" },
  { key: "bigEyeRoad", label: "大眼仔路" },
  { key: "smallRoad", label: "小路" },
  { key: "cockroachRoad", label: "曱甴路" },
] as const satisfies ReadonlyArray<{ key: keyof RoadVisibilitySettings; label: string }>;

export const ROADMAP_BOARD_ROWS = 6;
export const ROADMAP_BEAD_CELL_PX = 22;
export const ROADMAP_BIG_ROAD_CELL_PX = 18;
export const ROADMAP_DERIVED_CELL_PX = 14;
export const ROADMAP_MIN_BEAD_CELL_PX = 14;
export const ROADMAP_MIN_BIG_ROAD_CELL_PX = 10;
export const ROADMAP_MIN_DERIVED_CELL_PX = 8;
export const ROADMAP_MIN_BEAD_COLS = 6;
export const ROADMAP_MIN_BIG_ROAD_COLS = 18;
export const ROADMAP_MIN_DERIVED_COLS = 8;
