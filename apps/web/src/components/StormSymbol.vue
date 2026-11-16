<script setup lang="ts">
import type { SymbolKind } from "../lib/storm-demo";

defineProps<{ kind: SymbolKind }>();

const images: Record<SymbolKind, string> = {
  ruby: "/images/games/storm-symbols/ruby.webp",
  emerald: "/images/games/storm-symbols/emerald.webp",
  sapphire: "/images/games/storm-symbols/sapphire.webp",
  amber: "/images/games/storm-symbols/amber.webp",
  lotus: "/images/games/storm-symbols/lotus.webp",
  scarab: "/images/games/storm-symbols/scarab.webp",
  sun: "/images/games/storm-symbols/sun.webp",
  moon: "/images/games/storm-symbols/moon.webp",
  scatter: "/images/games/storm-symbols/scatter.webp",
  gold: "/images/games/storm-symbols/gold.webp",
  orb: "/images/games/storm-symbols/orb.webp",
};
</script>

<template>
  <img
    :src="images[kind]"
    class="storm-symbol"
    :class="kind"
    alt=""
    aria-hidden="true"
    width="256"
    height="256"
    draggable="false"
    decoding="async"
  />
</template>

<style scoped>
.storm-symbol {
  display: block;
  width: 78%;
  height: 78%;
  object-fit: contain;
  user-select: none;
  pointer-events: none;
  filter: drop-shadow(0 3px 3px #0008);
}
.gold {
  filter: drop-shadow(0 0 5px #ffad3466);
}
</style>
