<script setup lang="ts">
import AppButton from "../components/ui/AppButton.vue";
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import PwaInstall from "../components/PwaInstall.vue";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useLiveChannel } from "../composables/useLiveChannel";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const carousel = ref<HTMLElement | null>(null);
const activeIndex = ref(0);
const games = [
  {
    name: "百家樂",
    english: "BACCARAT",
    image: "/images/games/baccarat-simple.webp",
    path: "/baccarat",
  },
  { name: "Mines", english: "MINES", image: "/images/games/mines-simple.webp", path: "/mines" },
  { name: "Plinko", english: "PLINKO", image: "/images/games/plinko-simple.svg", path: "/plinko" },
];
useLiveChannel({ getSubscribeMessage: () => ({ type: "subscribe_user" }), onMessage: () => {} });
function logout() {
  authStore.logout();
  void router.push("/login");
}
function selectSlide(index: number) {
  const track = carousel.value;
  const slide = track?.children[index] as HTMLElement | undefined;
  if (!track || !slide) return;
  const offset = slide.getBoundingClientRect().left - track.getBoundingClientRect().left;
  track.scrollTo({
    left: track.scrollLeft + offset - (track.clientWidth - slide.clientWidth) / 2,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
  });
}
function focusSlide(index: number) {
  const slide = carousel.value?.children[index];
  slide?.querySelector("button")?.focus({ preventScroll: true });
}
function syncSlide() {
  const track = carousel.value;
  if (!track) return;
  const center = track.getBoundingClientRect().left + track.clientWidth / 2;
  let closest = 0;
  let distance = Infinity;
  Array.from(track.children).forEach((slide, index) => {
    const rect = slide.getBoundingClientRect();
    const nextDistance = Math.abs(rect.left + rect.width / 2 - center);
    if (nextDistance < distance) {
      closest = index;
      distance = nextDistance;
    }
  });
  activeIndex.value = closest;
}
</script>

<template>
  <main class="player-page game-picker">
    <AppPageHeader title="遊戲大廳" back-label="登出" @back="logout" />
    <section class="game-gallery" aria-label="遊戲選擇" aria-roledescription="輪播">
      <div
        ref="carousel"
        class="game-carousel"
        @scroll.passive="syncSlide"
        @keydown.left.prevent="focusSlide(Math.max(0, activeIndex - 1))"
        @keydown.right.prevent="focusSlide(Math.min(games.length - 1, activeIndex + 1))"
      >
        <div
          v-for="(game, index) in games"
          :key="game.path"
          class="game-slide"
          role="group"
          aria-roledescription="投影片"
          :aria-label="`${index + 1} / ${games.length}`"
        >
          <button
            type="button"
            class="game-poster"
            :class="{ active: activeIndex === index }"
            :aria-label="`進入${game.name}`"
            @click="router.push(game.path)"
            @focus="selectSlide(index)"
          >
            <img
              :src="game.image"
              alt=""
              width="800"
              height="1200"
              draggable="false"
              :fetchpriority="index === 0 ? 'high' : 'auto'"
              decoding="async"
            />
            <span class="poster-copy">
              <span v-if="game.path !== '/plinko'" class="poster-eyebrow">{{ game.english }}</span>
              <span class="poster-title">{{ game.name }}</span>
              <span class="poster-enter">進入遊戲 <span aria-hidden="true">↗</span></span>
            </span>
          </button>
        </div>
      </div>
      <nav class="carousel-controls" aria-label="切換遊戲">
        <AppButton
          variant="secondary"
          size="control"
          icon
          type="button"
          class="carousel-arrow"
          aria-label="上一個遊戲"
          :disabled="activeIndex === 0"
          @click="selectSlide(activeIndex - 1)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </AppButton>
        <div class="carousel-dots">
          <button
            v-for="(_, index) in games"
            :key="index"
            type="button"
            :aria-label="`第 ${index + 1} 張遊戲圖片`"
            :aria-current="activeIndex === index ? 'true' : undefined"
            @click="selectSlide(index)"
          >
            <span />
          </button>
        </div>
        <AppButton
          variant="secondary"
          size="control"
          icon
          type="button"
          class="carousel-arrow"
          aria-label="下一個遊戲"
          :disabled="activeIndex === games.length - 1"
          @click="selectSlide(activeIndex + 1)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </AppButton>
      </nav>
    </section>
    <PwaInstall />
  </main>
</template>

<style scoped lang="scss">
.game-picker {
  padding: 0 0 20px;
  gap: 0;
  background: radial-gradient(ellipse at 50% 38%, #204137, #10221e 55%, #091612);
}
.game-picker .page-header {
  --ui-title-color: #f0e6cf;
  --ui-title-spacing: 0.15em;
  position: static;
  margin: 0 16px;
}
.game-gallery {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
  padding: 16px 0 24px;
  gap: 20px;
}
.game-carousel {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 16px;
  padding: 12px 9% 18px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}
.game-carousel::-webkit-scrollbar {
  display: none;
}
.game-slide {
  flex: 0 0 100%;
  min-width: 0;
  scroll-snap-align: center;
  scroll-snap-stop: always;
}
.game-poster {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  overflow: hidden;
  aspect-ratio: 2 / 3;
  border: 1px solid #ffffff26;
  border-radius: 20px;
  background: #061c16;
  box-shadow: 0 8px 20px #0003;
  color: #fff;
  text-align: center;
  transform: scale(0.96);
  opacity: 0.7;
  transition:
    transform 0.25s,
    opacity 0.25s;
}
.game-poster.active {
  transform: scale(1);
  opacity: 1;
}
.game-poster img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.poster-copy {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44px 16px 25px;
  background: linear-gradient(transparent, #102a2466);
}
.poster-eyebrow {
  font-size: 10px;
  letter-spacing: 0.32em;
  color: #edf4eb;
}
.poster-title {
  margin: 3px 0 14px;
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-shadow: 0 2px 12px #0008;
}
.poster-enter {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 28px;
  min-width: 146px;
  min-height: 39px;
  border-top: 1px solid #ffffff40;
  font-size: 12px;
  letter-spacing: 0.1em;
  color: #fff;
}
.poster-enter > span {
  font-size: 20px;
}
.carousel-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 28px;
}
.carousel-arrow {
  --ui-radius: 50%;
  display: grid;
  place-items: center;
  border: 1px solid #d2b98533;
  background: #ffffff05;
  color: #dec798;
}
.carousel-arrow svg {
  display: block;
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.carousel-arrow:disabled {
  opacity: 0.25;
  cursor: default;
}
.carousel-dots {
  display: flex;
  gap: 4px;
}
.carousel-dots button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 40px;
  padding: 0;
  border: 0;
  background: none;
}
.carousel-dots span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #7a8b7d;
  transition: width 0.2s;
}
.carousel-dots [aria-current="true"] span {
  width: 22px;
  background: #e5c58b;
}
.game-picker button:focus-visible {
  outline: 2px solid #ffe1a4;
  outline-offset: 4px;
}
@media (prefers-reduced-motion: reduce) {
  .game-poster,
  .carousel-dots span {
    transition: none;
  }
}
</style>
