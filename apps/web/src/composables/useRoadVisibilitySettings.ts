import { ref, watch } from "vue";
import { ROAD_VISIBILITY_OPTIONS } from "../const/roadmap";
import type { RoadVisibilitySettings } from "../types/domain";
import { loadRoadVisibilitySettings, saveRoadVisibilitySettings } from "../lib/settings";

export function useRoadVisibilitySettings() {
  const roadVisibility = ref<RoadVisibilitySettings>(loadRoadVisibilitySettings());

  function toggleRoadVisibility(target: keyof RoadVisibilitySettings) {
    roadVisibility.value[target] = !roadVisibility.value[target];
  }

  watch(
    roadVisibility,
    (value) => {
      saveRoadVisibilitySettings(value);
    },
    { deep: true },
  );

  return {
    roadVisibility,
    roadVisibilityOptions: ROAD_VISIBILITY_OPTIONS,
    toggleRoadVisibility,
  };
}
