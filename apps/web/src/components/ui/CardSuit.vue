<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
defineProps<{ suit: "S" | "H" | "D" | "C" }>();
const suits = {
  S: { icon: "spade", label: "黑桃" },
  H: { icon: "heart", label: "紅心" },
  D: { icon: "diamond", label: "方塊" },
  C: { icon: "club", label: "梅花" },
} as const;
</script>

<template>
  <span role="img" :aria-label="suits[suit].label"><AppIcon :name="suits[suit].icon" /></span>
</template>
