<script setup lang="ts">
import AppButton from "./AppButton.vue";
withDefaults(defineProps<{ title?: string; backLabel?: string }>(), {
  title: "",
  backLabel: "返回",
});
const emit = defineEmits<{ back: [] }>();
</script>
<template>
  <header class="page-header ui-page-header">
    <AppButton
      class="page-header-back"
      variant="ghost"
      icon
      :aria-label="backLabel"
      @click="emit('back')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 6-6 6 6 6" /></svg>
    </AppButton>
    <h1 class="page-heading">
      <slot>{{ title }}</slot>
    </h1>
    <div v-if="$slots.actions" class="page-header-actions"><slot name="actions" /></div>
    <div v-if="$slots.subtitle" class="page-header-subtitle"><slot name="subtitle" /></div>
  </header>
</template>
