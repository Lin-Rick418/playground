<script setup lang="ts">
import { useSessionMonitor } from "./composables/useSessionMonitor";

useSessionMonitor();
</script>

<template>
  <router-view />
</template>
