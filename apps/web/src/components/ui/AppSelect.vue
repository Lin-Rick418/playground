<script setup lang="ts" generic="T extends string | number">
withDefaults(defineProps<{ size?: "control" | "action" | "compact" }>(), { size: "control" });
const [model, modifiers] = defineModel<T>({ required: true });
function change(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  model.value = (modifiers.number || typeof model.value === "number" ? Number(value) : value) as T;
}
</script>
<template>
  <select class="ui-select" :class="`ui-${size}`" :value="model" @change="change">
    <slot />
  </select>
</template>
