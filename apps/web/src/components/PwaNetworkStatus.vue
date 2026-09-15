<script setup lang="ts">
import { pwaState } from "../lib/pwa";
</script>

<template>
  <aside v-if="pwaState.offline" class="pwa-network-status" role="status">
    目前已離線，遊戲與帳戶資訊需要連線。請確認網路。
  </aside>
</template>

<style scoped>
.pwa-network-status {
  position: sticky;
  top: 0;
  z-index: 100;
  padding: 10px 16px;
  background: #f2d18a;
  color: #093020;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
}
</style>
