<script setup lang="ts">
import { computed } from "vue";
import WinCelebration from "./WinCelebration.vue";

const props = defineProps<{ multiplier: number; payout: number; count: number }>();
const tier = computed(() =>
  props.multiplier >= 100 ? "mega" : props.multiplier >= 30 ? "big" : "win",
);
</script>

<template>
  <WinCelebration class="plinko-win" v-bind="props" :tier="tier" />
</template>
