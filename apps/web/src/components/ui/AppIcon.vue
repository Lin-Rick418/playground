<script setup lang="ts">
import { iconGlyphs, type IconName } from "../../lib/ui-icons";
defineProps<{ name: IconName }>();
</script>

<template>
  <span class="app-icon" :data-icon="name" :data-glyph="iconGlyphs[name]" aria-hidden="true" />
</template>

<style>
@font-face {
  font-family: "Casino UI Icons";
  src: url("../../assets/ui-icons.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: block;
}
.app-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: none;
  vertical-align: -0.125em;
  line-height: 1;
}
.app-icon::before {
  content: attr(data-glyph);
  font-family: "Casino UI Icons";
  font-style: normal;
  font-weight: 400;
  font-variant: normal;
  font-synthesis: none;
  text-transform: none;
  letter-spacing: 0;
  line-height: 1;
}
</style>
