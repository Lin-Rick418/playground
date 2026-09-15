<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { formatMoney } from "../../lib/money";
defineProps<{ balance: number | null | undefined; rolling?: boolean }>();
const root = ref<HTMLElement | null>(null);
const warning = ref(false);
const revision = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;
let animation: Animation | undefined;
function clearWarning() {
  clearTimeout(timer);
  animation?.cancel();
  warning.value = false;
}
function warn() {
  clearWarning();
  warning.value = true;
  revision.value++;
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    animation = root.value?.animate?.(
      [0, -4, 4, -4, 4, -3, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 600, easing: "ease-in-out" },
    );
  timer = setTimeout(clearWarning, 1200);
}
defineExpose({ warn, clearWarning });
onUnmounted(clearWarning);
</script>
<template>
  <section
    ref="root"
    class="ui-balance"
    :class="{ insufficient: warning }"
    role="status"
    aria-live="polite"
  >
    <span v-if="warning" :key="revision" class="wallet-warning" role="alert">餘額不足</span>
    <span>餘額</span><strong :class="{ rolling }">${{ formatMoney(balance) }}</strong>
  </section>
</template>
