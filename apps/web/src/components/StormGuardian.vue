<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from "vue";

const props = defineProps<{ active: boolean; paused: boolean }>();
const id = useId().replace(/:/g, "");
const backdropReady = ref(false);
const guardianReady = ref(false);
const bodyReady = ref(false);
const failed = ref(false);
const hidden = ref(document.hidden);
const ready = computed(
  () => backdropReady.value && guardianReady.value && bodyReady.value && !failed.value,
);
const paused = computed(() => props.paused || hidden.value);
const guardian = "/images/games/storm-guardian.webp";
// These paths partition one transparent sprite in its original 1024 × 1536 coordinates.
// Remove the articulated parts from every stationary layer to prevent ghost weapons.
const head = "M0 0H540V335L510 350L460 342L360 355L250 380L180 350H0Z";
const cape = "M656 780L925 940L1024 1150V1430H710L665 1290Z";
const staff =
  "M510 0H800V300L686 363L675 453V1160L690 1310L675 1510H588L601 1300L611 1150V455L592 385L548 298Z";
const forearm =
  "M544 495Q572 495 600 479L611 446Q645 435 677 468Q696 491 687 554L669 579Q627 603 578 616Q546 617 525 589Q514 568 526 543Z";
function updateVisibility() {
  hidden.value = document.hidden;
}
onMounted(() => document.addEventListener("visibilitychange", updateVisibility));
onUnmounted(() => document.removeEventListener("visibilitychange", updateVisibility));
</script>

<template>
  <div
    class="guardian-scene"
    :class="{ 'is-awake': active, 'is-ready': ready, 'is-paused': paused }"
    aria-hidden="true"
  >
    <img
      class="guardian-backdrop"
      src="/images/games/storm-temple-background.webp"
      alt=""
      draggable="false"
      @load="backdropReady = true"
      @error="failed = true"
    />
    <svg class="guardian-figure" viewBox="0 0 1024 1536" focusable="false">
      <defs>
        <mask :id="`${id}-body`" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1536">
          <path d="M0 0H1024V1536H0Z" fill="white" />
          <path
            v-for="(part, index) in [head, cape, staff, forearm]"
            :key="index"
            :d="part"
            fill="black"
          />
        </mask>
        <mask :id="`${id}-head`" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1536">
          <path :d="head" fill="white" />
          <path :d="staff" fill="black" />
        </mask>
        <mask :id="`${id}-cape`" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1536">
          <path :d="cape" fill="white" />
          <path :d="staff" fill="black" />
        </mask>
        <clipPath :id="`${id}-arm`">
          <path :d="staff" />
          <path :d="forearm" />
        </clipPath>
        <radialGradient :id="`${id}-light`">
          <stop offset="0" stop-color="#fff8ce" stop-opacity="0.8" />
          <stop offset="0.35" stop-color="#ffd36b" stop-opacity="0.4" />
          <stop offset="1" stop-color="#ffc45d" stop-opacity="0" />
        </radialGradient>
        <linearGradient :id="`${id}-trail`" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fff8d8" />
          <stop offset="0.45" stop-color="#ffda78" stop-opacity="0.8" />
          <stop offset="1" stop-color="#ffda78" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="guardian-motion">
        <g class="guardian-stance">
          <image
            href="/images/games/storm-guardian-body.webp"
            width="1024"
            height="1536"
            :clip-path="`url(#${id}-arm)`"
            @load="bodyReady = true"
            @error="failed = true"
          />
          <g class="guardian-cape">
            <image :href="guardian" width="1024" height="1536" :mask="`url(#${id}-cape)`" />
          </g>
          <image
            :href="guardian"
            width="1024"
            height="1536"
            :mask="`url(#${id}-body)`"
            @load="guardianReady = true"
            @error="failed = true"
          />
          <g class="guardian-head">
            <image :href="guardian" width="1024" height="1536" :mask="`url(#${id}-head)`" />
          </g>
          <g class="guardian-slash" fill="none" stroke-linecap="round">
            <path
              d="M730 165Q450 70 214 290"
              :stroke="`url(#${id}-trail)`"
              stroke-width="28"
              opacity="0.25"
            />
            <path d="M730 165Q450 70 214 290" :stroke="`url(#${id}-trail)`" stroke-width="5" />
          </g>
          <g class="guardian-staff">
            <image :href="guardian" width="1024" height="1536" :clip-path="`url(#${id}-arm)`" />
            <g class="guardian-light">
              <circle cx="643" cy="158" r="170" :fill="`url(#${id}-light)`" />
              <circle cx="643" cy="158" r="118" fill="none" stroke="#ffe9a2" stroke-width="2" />
            </g>
          </g>
        </g>
      </g>
    </svg>
    <div class="guardian-shade" />
  </div>
</template>

<style scoped>
.guardian-scene {
  position: absolute;
  inset: 0 -12px;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transition: opacity 650ms ease;
  contain: paint;
}
.guardian-scene.is-awake.is-ready {
  opacity: 1;
}
.guardian-backdrop,
.guardian-shade {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.guardian-backdrop {
  object-fit: cover;
  object-position: 65% 30%;
  filter: brightness(0.72) saturate(0.9);
}
.guardian-figure {
  position: absolute;
  top: -16%;
  right: 0;
  width: auto;
  height: min(220%, 736px);
  max-width: none;
  aspect-ratio: 2 / 3;
  transform: translateX(33%);
  overflow: visible;
}
.guardian-shade {
  background: linear-gradient(90deg, #04132ee6, #071b3b52 38%, transparent 68%);
}
.guardian-motion,
.guardian-head,
.guardian-cape,
.guardian-stance,
.guardian-staff {
  transform-box: view-box;
}
.guardian-motion {
  transform-origin: 44% 96%;
}
.guardian-head {
  transform-origin: 38% 24%;
}
.guardian-cape {
  transform-origin: 64% 51%;
}
.guardian-light {
  opacity: 0.35;
}
.guardian-stance {
  transform-origin: 43% 65%;
}
.guardian-staff {
  transform-origin: 51.76% 36.13%;
}
.guardian-slash {
  opacity: 0;
}
.guardian-scene {
  --attack-duration: 5.2s;
}
.is-awake.is-ready .guardian-motion {
  animation: guardian-breathe 4.8s ease-in-out infinite;
}
.is-awake.is-ready .guardian-head {
  animation: guardian-watch 6.8s ease-in-out infinite;
}
.is-awake.is-ready .guardian-cape {
  animation: guardian-cape 3.6s ease-in-out infinite;
}
.is-awake.is-ready .guardian-light {
  animation: guardian-light 3.8s ease-in-out infinite;
}
.is-awake.is-ready .guardian-stance {
  animation: guardian-stance var(--attack-duration) ease-in-out infinite;
}
.is-awake.is-ready .guardian-staff {
  animation: guardian-strike var(--attack-duration) ease-in-out infinite;
}
.is-awake.is-ready .guardian-slash {
  animation: guardian-slash var(--attack-duration) linear infinite;
}
.guardian-scene.is-awake.is-paused * {
  animation-play-state: paused;
}
@keyframes guardian-breathe {
  0%,
  100% {
    transform: translateY(0) scaleY(1);
  }
  50% {
    transform: translateY(-0.4%) scaleY(1.006);
  }
}
@keyframes guardian-watch {
  0%,
  100% {
    transform: rotate(0deg);
  }
  45% {
    transform: rotate(-0.9deg);
  }
  75% {
    transform: rotate(0.35deg);
  }
}
@keyframes guardian-cape {
  0%,
  100% {
    transform: skewX(0deg) rotate(0deg);
  }
  50% {
    transform: skewX(-1.1deg) rotate(-0.4deg);
  }
}
@keyframes guardian-light {
  0%,
  100% {
    opacity: 0.2;
  }
  50% {
    opacity: 0.7;
  }
}
@keyframes guardian-stance {
  0%,
  9%,
  56%,
  100% {
    transform: rotate(0deg) translateX(0);
  }
  20% {
    transform: rotate(1.2deg) translateX(0.3%);
  }
  29% {
    transform: rotate(-2.4deg) translateX(-0.6%);
  }
  36% {
    transform: rotate(-1.6deg) translateX(-0.4%);
  }
}
@keyframes guardian-strike {
  0%,
  9%,
  56%,
  100% {
    transform: rotate(0deg);
  }
  20% {
    transform: rotate(10deg);
    animation-timing-function: cubic-bezier(0.22, 0.7, 0.18, 1);
  }
  29% {
    transform: rotate(-66deg);
  }
  36% {
    transform: rotate(-61deg);
  }
}
@keyframes guardian-slash {
  0%,
  23%,
  41%,
  100% {
    opacity: 0;
  }
  28% {
    opacity: 0.85;
  }
  33% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .guardian-scene {
    transition: none;
  }
  .guardian-scene * {
    animation: none !important;
  }
}
</style>
