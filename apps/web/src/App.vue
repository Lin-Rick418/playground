<script setup lang="ts">
import PwaNetworkStatus from "./components/PwaNetworkStatus.vue";
import { useSessionMonitor } from "./composables/useSessionMonitor";
import { useRoute, useRouter } from "vue-router";
import { useScreenWakeLock } from "./composables/useScreenWakeLock";
import PortraitGuard from "./components/PortraitGuard.vue";
import { providePortraitGuard } from "./composables/usePortraitGuard";

useSessionMonitor();
const route = useRoute();
const router = useRouter();
const portraitBlocked = providePortraitGuard(() => route.meta.portraitOnly === true);
useScreenWakeLock(() => route.meta.keepScreenAwake === true);
</script>

<template>
  <PwaNetworkStatus />
  <router-view />
  <PortraitGuard
    :blocked="portraitBlocked"
    :can-return="route.path !== '/lobby'"
    @return="router.push('/lobby')"
  />
</template>
