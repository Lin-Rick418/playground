<script setup lang="ts">
const [model, modifiers] = defineModel<string>({
  required: true,
  set: (value) => (modifiers.trim ? value.trim() : value),
});
</script>
<template><input v-model="model" class="ui-input ui-control" /></template>
