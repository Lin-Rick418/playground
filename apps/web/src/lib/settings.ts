import { DEFAULT_ROAD_VISIBILITY_SETTINGS } from "../const/roadmap";
import type { RoadVisibilitySettings } from "../types/domain";

const TOKEN_STORAGE_KEY = "baccarat_token";
const ROAD_VISIBILITY_STORAGE_KEY = "baccarat-road-visibility";

export function getStoredToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export function setStoredToken(token: string) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function createDefaultRoadVisibility(): RoadVisibilitySettings {
  return { ...DEFAULT_ROAD_VISIBILITY_SETTINGS };
}

export function normalizeRoadVisibilitySettings(value: unknown): RoadVisibilitySettings {
  const defaults = createDefaultRoadVisibility();

  if (!value || typeof value !== "object") {
    return defaults;
  }

  const nextValue = value as Partial<RoadVisibilitySettings>;
  return {
    beadRoad: typeof nextValue.beadRoad === "boolean" ? nextValue.beadRoad : defaults.beadRoad,
    bigRoad: typeof nextValue.bigRoad === "boolean" ? nextValue.bigRoad : defaults.bigRoad,
    bigEyeRoad: typeof nextValue.bigEyeRoad === "boolean" ? nextValue.bigEyeRoad : defaults.bigEyeRoad,
    smallRoad: typeof nextValue.smallRoad === "boolean" ? nextValue.smallRoad : defaults.smallRoad,
    cockroachRoad: typeof nextValue.cockroachRoad === "boolean" ? nextValue.cockroachRoad : defaults.cockroachRoad,
  };
}

export function loadRoadVisibilitySettings() {
  try {
    const rawValue = localStorage.getItem(ROAD_VISIBILITY_STORAGE_KEY);
    return rawValue ? normalizeRoadVisibilitySettings(JSON.parse(rawValue)) : createDefaultRoadVisibility();
  } catch {
    return createDefaultRoadVisibility();
  }
}

export function saveRoadVisibilitySettings(value: RoadVisibilitySettings) {
  localStorage.setItem(ROAD_VISIBILITY_STORAGE_KEY, JSON.stringify(value));
}
