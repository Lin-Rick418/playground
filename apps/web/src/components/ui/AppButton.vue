<script setup lang="ts">
import { ref } from "vue";
const element = ref<HTMLButtonElement | null>(null);
defineExpose({ focus: (options?: FocusOptions) => element.value?.focus(options) });
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost";
    size?: "control" | "action" | "compact";
    icon?: boolean;
    disabled?: boolean;
    busy?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  {
    variant: "secondary",
    size: "control",
    type: "button",
    icon: false,
    disabled: false,
    busy: false,
  },
);
</script>
<template>
  <button
    ref="element"
    :type="type"
    class="ui-button"
    :class="[`ui-${size}`, `ui-button-${variant}`, { 'ui-icon': icon }]"
    :disabled="disabled || busy"
    :aria-busy="busy || undefined"
  >
    <slot />
  </button>
</template>
