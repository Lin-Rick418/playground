<script setup lang="ts">
import PwaNetworkStatus from "./components/PwaNetworkStatus.vue";
import { useSessionMonitor } from "./composables/useSessionMonitor";
import { useRoute } from "vue-router";
import { useScreenWakeLock } from "./composables/useScreenWakeLock";

useSessionMonitor();
const route = useRoute();
useScreenWakeLock(() => route.meta.keepScreenAwake === true);
</script>

<template>
  <PwaNetworkStatus />
  <router-view />
</template>
