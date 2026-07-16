import { DEFAULT_ROAD_VISIBILITY_SETTINGS } from "../const/roadmap";
import type { RoadVisibilitySettings } from "../types/domain";

const TOKEN_STORAGE_KEY = "baccarat_token";
const ROAD_VISIBILITY_STORAGE_KEY = "baccarat-road-visibility";
const VOICE_ANNOUNCEMENT_STORAGE_KEY = "baccarat-voice-announcement";

let inMemoryAccessToken = "";

export function getStoredToken() {
  return inMemoryAccessToken;
}

export function setStoredToken(token: string) {
  inMemoryAccessToken = token;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function clearStoredToken() {
  inMemoryAccessToken = "";
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

export function loadVoiceAnnouncementEnabled() {
  try {
    const rawValue = localStorage.getItem(VOICE_ANNOUNCEMENT_STORAGE_KEY);

    if (rawValue === null) {
      return true;
    }

    return rawValue === "true";
  } catch {
    return true;
  }
}

export function saveVoiceAnnouncementEnabled(value: boolean) {
  localStorage.setItem(VOICE_ANNOUNCEMENT_STORAGE_KEY, String(value));
}
