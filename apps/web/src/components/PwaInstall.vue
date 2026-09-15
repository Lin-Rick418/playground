<script setup lang="ts">
import AppButton from "./ui/AppButton.vue";
import { installPwa, pwaState } from "../lib/pwa";
</script>

<template>
  <section
    v-if="!pwaState.installed && (pwaState.canInstall || pwaState.installing)"
    class="pwa-install"
    aria-label="安裝 Casino"
  >
    <AppButton type="button" :disabled="pwaState.installing" @click="installPwa">
      {{ pwaState.installing ? "安裝處理中…" : "安裝 Casino" }}
    </AppButton>
  </section>
</template>

<style scoped>
.pwa-install {
  width: min(100%, 400px);
  margin: 16px auto;
  padding: 0 16px;
  box-sizing: border-box;
  text-align: center;
  color: #f2d18a;
  font-size: 14px;
}
</style>
