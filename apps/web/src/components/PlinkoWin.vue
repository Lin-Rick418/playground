<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { formatMoney } from "../lib/money";

const props = defineProps<{ multiplier: number; payout: number; count: number }>();
const tier = computed(() =>
  props.multiplier >= 100 ? "mega" : props.multiplier >= 30 ? "big" : "win",
);
const title = computed(() =>
  tier.value === "mega" ? "MEGA WIN" : tier.value === "big" ? "BIG WIN" : "NICE WIN",
);
const canvas = ref<HTMLCanvasElement | null>(null);
const displayedPayout = ref(props.payout);
const reduced = ref(false);
let frame = 0;
let context: CanvasRenderingContext2D | null = null;
let observer: ResizeObserver | undefined;
let media: MediaQueryList | undefined;
let width = 0,
  height = 0,
  previousTime = 0,
  lastBurst = 0;
let countStart = 0,
  countFrom = 0;
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  angle: number;
  spin: number;
  kind: number;
  color: string;
};
let particles: Particle[] = [];
const colors = ["#fff5b5", "#ffc13b", "#ff8e27", "#fff9ed", "#67e6ff"];
function resize() {
  const el = canvas.value;
  if (!el || !context) return;
  const box = el.getBoundingClientRect();
  width = box.width;
  height = box.height;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  el.width = Math.round(width * ratio);
  el.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}
function burst() {
  if (!context || reduced.value) {
    displayedPayout.value = props.payout;
    return;
  }
  const now = performance.now();
  countFrom = props.count > 1 ? displayedPayout.value : 0;
  displayedPayout.value = countFrom;
  countStart = now;
  lastBurst = now;
  const amount = tier.value === "mega" ? 100 : tier.value === "big" ? 70 : 42;
  // Keep a fixed ceiling even when many auto-play balls land together.
  particles = particles.slice(-(180 - amount));
  for (let i = 0; i < amount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 70 + Math.random() * 210;
    particles.push({
      x: width / 2,
      y: height * 0.43,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 100,
      age: 0,
      life: 1.4 + Math.random() * 1.6,
      size: 3 + Math.random() * 7,
      angle,
      spin: (Math.random() - 0.5) * 9,
      kind: i % 3,
      color: colors[i % colors.length]!,
    });
  }
  if (!frame) {
    previousTime = now;
    frame = requestAnimationFrame(draw);
  }
}
function draw(now: number) {
  frame = 0;
  if (!context || reduced.value) return;
  const ctx = context;
  const dt = Math.min((now - previousTime) / 1000, 0.04);
  previousTime = now;
  const progress = Math.min(1, (now - countStart) / 950);
  displayedPayout.value = countFrom + (props.payout - countFrom) * (1 - (1 - progress) ** 3);
  ctx.clearRect(0, 0, width, height);
  particles = particles.filter((p) => p.age < p.life);
  for (const p of particles) {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 155 * dt;
    p.angle += p.spin * dt;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.globalAlpha = Math.max(0, Math.min(1, (p.life - p.age) * 2));
    if (p.kind === 0) {
      // A shaded, spinning coin with an inset rim.
      ctx.scale(Math.max(0.18, Math.abs(Math.cos(p.age * 7))), 1);
      const gold = ctx.createLinearGradient(-p.size, -p.size, p.size, p.size);
      gold.addColorStop(0, "#fff7bb");
      gold.addColorStop(0.45, "#ffc844");
      gold.addColorStop(1, "#a64e08");
      ctx.fillStyle = gold;
      ctx.beginPath();
      ctx.arc(0, 0, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffed94";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, p.size * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.kind === 1) {
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 3, -p.size, p.size * 0.65, p.size * 2);
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(0, -p.size);
      ctx.lineTo(p.size * 0.25, -p.size * 0.25);
      ctx.lineTo(p.size, 0);
      ctx.lineTo(p.size * 0.25, p.size * 0.25);
      ctx.lineTo(0, p.size);
      ctx.lineTo(-p.size * 0.25, p.size * 0.25);
      ctx.lineTo(-p.size, 0);
      ctx.lineTo(-p.size * 0.25, -p.size * 0.25);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  if (particles.length || now - lastBurst < 1000) frame = requestAnimationFrame(draw);
}
function syncMotion() {
  reduced.value = media?.matches ?? false;
  if (reduced.value) {
    cancelAnimationFrame(frame);
    frame = 0;
    particles = [];
    context?.clearRect(0, 0, width, height);
    displayedPayout.value = props.payout;
  }
}
onMounted(() => {
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  syncMotion();
  media.addEventListener?.("change", syncMotion);
  context = canvas.value?.getContext("2d") ?? null;
  if (context) {
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(canvas.value!);
  }
  burst();
});
watch(() => props.count, burst);
onUnmounted(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
  media?.removeEventListener?.("change", syncMotion);
});
</script>

<template>
  <div class="plinko-win" :class="[tier, { 'motion-reduced': reduced }]">
    <div :key="count" class="win-effects" aria-hidden="true">
      <div class="win-vignette" />
      <div class="win-rays" />
      <div class="win-core" />
      <div class="win-ring ring-one" />
      <div class="win-ring ring-two" />
      <div class="win-flare" />
    </div>
    <canvas ref="canvas" class="win-particles" aria-hidden="true" />
    <div :key="tier" class="win-copy" aria-hidden="true">
      <svg class="win-crown" viewBox="0 0 120 56">
        <path d="M12 12 35 30 60 3 85 30 108 12 96 48H24Z" />
        <path d="M28 54H92" />
      </svg>
      <span class="win-title">{{ title }}</span>
      <strong class="win-multiplier">{{ multiplier.toFixed(2) }}<span>×</span></strong>
      <div class="win-divider"><i />✦<i /></div>
      <span class="win-payout">${{ formatMoney(displayedPayout) }}</span>
    </div>
    <span class="win-announcement" role="status" aria-live="polite" aria-atomic="true"
      >{{ title }}，{{ multiplier.toFixed(2) }}×，{{ count > 1 ? `${count} 顆中獎，` : "" }} ${{
        formatMoney(payout)
      }}</span
    >
  </div>
</template>

<style scoped lang="scss">
.plinko-win {
  position: absolute;
  z-index: 3;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: #ffde83;
  text-align: center;
  container-type: size;
}
.win-effects,
.win-particles {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.win-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse, #061020b8 10%, #080f1bd9 70%, #080f1b88);
  animation: stage-in 220ms both;
}
.win-rays {
  position: absolute;
  width: 160%;
  aspect-ratio: 1;
  left: -30%;
  top: calc(43% - 80cqw);
  background: repeating-conic-gradient(
    from 0deg,
    transparent 0deg 12deg,
    #ffc95538 14deg 19deg,
    transparent 21deg 30deg
  );
  border-radius: 50%;
  mask-image: radial-gradient(circle, #000 5%, transparent 70%);
  -webkit-mask-image: radial-gradient(circle, #000 5%, transparent 70%);
  animation: rays-turn 12s linear infinite;
}
.win-core {
  position: absolute;
  inset: 6% -5%;
  background: radial-gradient(ellipse, #ffd35b60, #d88a1424 35%, transparent 68%);
  animation: core-breathe 1500ms ease-in-out infinite alternate;
}
.win-ring {
  position: absolute;
  width: 58%;
  aspect-ratio: 1;
  left: 21%;
  top: calc(43% - 29cqw);
  border: 2px solid #ffe6a0;
  border-radius: 50%;
  box-shadow:
    0 0 18px #ffd35a,
    inset 0 0 14px #ffd35a80;
  animation: shockwave 1300ms ease-out both;
}
.ring-two {
  animation-delay: 180ms;
  border-width: 1px;
}
.win-flare {
  position: absolute;
  top: 43%;
  left: -10%;
  width: 120%;
  height: 2px;
  background: #fff4cc;
  box-shadow: 0 0 24px 6px #ffd46e80;
  animation: flare 650ms ease-out both;
}
.win-particles {
  z-index: 2;
}
.win-copy {
  position: absolute;
  z-index: 3;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px;
  transform: translateY(-4%);
  animation: prize-slam 750ms cubic-bezier(0.16, 0.8, 0.3, 1) both;
}
.win-crown {
  width: 62px;
  height: 34px;
  fill: #ffe699;
  stroke: #bf781d;
  stroke-width: 2;
  margin-bottom: 4px;
  filter: drop-shadow(0 2px 7px #ffd05980);
  animation: crown-arrive 750ms 100ms both;
}
.win-title {
  position: relative;
  font-size: clamp(24px, 10cqw, 52px);
  font-weight: 1000;
  font-style: italic;
  line-height: 1.15;
  letter-spacing: -0.035em;
  color: #fff0ad;
  text-shadow:
    0 2px #dc9a26,
    0 4px #975208,
    0 6px #4b2605,
    0 8px 18px #0009;
}
.win-multiplier {
  font-size: clamp(42px, 19cqw, 96px);
  line-height: 1.15;
  font-weight: 1000;
  letter-spacing: -0.055em;
  color: #ffda6b;
  background: linear-gradient(
    170deg,
    #fffbe5 12%,
    #ffeeb1 28%,
    #ffb32c 52%,
    #fff0a5 70%,
    #dc810e 90%
  );
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 3px 0 #8b4b09) drop-shadow(0 7px 10px #0009);
  animation: multiplier-impact 700ms 120ms both;
}
.win-multiplier span {
  font-size: 0.65em;
}
.win-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 70%;
  margin: 7px 0;
}
.win-divider i {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, #ffe9a1);
}
.win-divider i:last-child {
  transform: rotate(180deg);
}
.win-payout {
  font-size: clamp(22px, 8cqw, 42px);
  font-weight: 900;
  color: #fff5d8;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 12px #ffb73b70;
}
.win-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.win .win-crown {
  display: none;
}
.win .win-rays {
  opacity: 0.55;
}
.mega .win-title {
  font-size: clamp(28px, 12cqw, 60px);
}
@keyframes stage-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes rays-turn {
  to {
    transform: rotate(360deg);
  }
}
@keyframes core-breathe {
  from {
    opacity: 0.6;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1.1);
  }
}
@keyframes shockwave {
  from {
    opacity: 0.9;
    transform: scale(0.15);
  }
  to {
    opacity: 0;
    transform: scale(2.7);
  }
}
@keyframes flare {
  from {
    opacity: 0;
    transform: scaleX(0.1);
  }
  25% {
    opacity: 0.85;
  }
  to {
    opacity: 0;
    transform: scaleX(1);
  }
}
@keyframes prize-slam {
  0% {
    opacity: 0;
    transform: translateY(-4%) scale(1.65);
  }
  45% {
    opacity: 1;
    transform: translateY(-4%) scale(0.94);
  }
  68% {
    transform: translateY(-4%) scale(1.04);
  }
  100% {
    opacity: 1;
    transform: translateY(-4%) scale(1);
  }
}
@keyframes multiplier-impact {
  0% {
    opacity: 0;
    transform: scale(0.35) rotate(-8deg);
  }
  65% {
    opacity: 1;
    transform: scale(1.13) rotate(2deg);
  }
  100% {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
}
@keyframes crown-arrive {
  from {
    opacity: 0;
    transform: translateY(-28px) rotate(-12deg);
  }
  to {
    opacity: 1;
    transform: translateY(0) rotate(0);
  }
}
@container (max-height: 270px) {
  .win-crown {
    display: none;
  }
  .win-title,
  .mega .win-title {
    font-size: 24px;
  }
  .win-multiplier {
    font-size: 45px;
  }
  .win-payout {
    font-size: 23px;
  }
  .win-divider {
    margin: 2px 0;
  }
}
.motion-reduced .win-effects,
.motion-reduced .win-particles {
  display: none;
}
.motion-reduced {
  background: radial-gradient(ellipse, #152033f5, #07101dc9);
}
.motion-reduced .win-copy,
.motion-reduced .win-crown,
.motion-reduced .win-multiplier {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .win-effects,
  .win-particles {
    display: none;
  }
  .win-copy,
  .win-crown,
  .win-multiplier {
    animation: none;
  }
}
</style>
