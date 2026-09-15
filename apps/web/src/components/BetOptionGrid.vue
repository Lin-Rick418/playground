<script setup lang="ts">
import type { BetOption } from "../const/game";
import type { BetType } from "../types/domain";
import { formatMoney } from "../lib/money";

const props = defineProps<{
  options: readonly BetOption[];
  variant: "side" | "main";
  amounts: Record<BetType, number>;
  stagedAmounts: Record<BetType, number>;
  selectedChip: number;
  disabled: boolean;
  closed: boolean;
}>();

const emit = defineEmits<{
  select: [betType: BetType];
}>();

function formatAmount(amount: number) {
  if (amount < 1000) {
    return formatMoney(amount);
  }

  const compactAmount = amount / 1000;
  return `${Number.isInteger(compactAmount) ? compactAmount : compactAmount.toFixed(1).replace(/\.0$/, "")}k`;
}

function ariaLabel(option: BetOption) {
  const amount = props.amounts[option.key];
  const amountText = amount ? `，目前下注 ${formatMoney(amount)}` : "，目前尚未下注";
  return `${option.label}，賠率 ${option.payout}，每次增加 ${formatMoney(props.selectedChip)}${amountText}`;
}
</script>

<template>
  <div class="bet-row" :class="[`${variant}-row`, { closed }]">
    <button
      v-for="option in options"
      :key="option.key"
      type="button"
      class="bet-cell"
      :class="option.accent"
      :disabled="disabled"
      :aria-label="ariaLabel(option)"
      @click="emit('select', option.key)"
    >
      <h3>{{ option.label }}</h3>
      <p>{{ option.payout }}</p>
      <span
        class="bet-cell-amount"
        :class="{
          empty: !amounts[option.key],
          staged: stagedAmounts[option.key] > 0,
        }"
      >
        {{ amounts[option.key] ? formatAmount(amounts[option.key]) : "" }}
      </span>
    </button>
  </div>
</template>

<style scoped lang="scss">
.bet-row {
  display: grid;
  gap: $space-2;
}

.side-row {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.main-row {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.main-row .bet-cell {
  min-height: 90px;
}

.bet-cell {
  width: 100%;
  min-height: 78px;
  padding: $space-2;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.14);
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  color: inherit;
  font: inherit;
  text-align: center;
  transition:
    transform 120ms ease,
    filter 120ms ease,
    background 120ms ease;
}

.closed .bet-cell {
  filter: saturate(0.72) brightness(0.9);
}

.bet-cell * {
  pointer-events: none;
}

.bet-cell:active {
  transform: scale(0.985);
  filter: brightness(1.1);
}

.bet-cell h3 {
  margin: 0;
  font-family: "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
  font-size: 21px;
  font-weight: 900;
  line-height: 1.05;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

.main-row .bet-cell h3 {
  font-size: 27px;
}

.bet-cell p {
  margin: 0;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.66);
}

.bet-cell.player h3 {
  color: #cfe4ff;
}

.bet-cell.banker h3 {
  color: #ffd2cd;
}

.bet-cell-amount {
  flex: 0 0 17px;
  height: 17px;
  min-height: 17px;
  margin-top: 1px;
  padding: 0 $space-2;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  white-space: nowrap;
  color: #ffe9ad;
  background: rgba(0, 0, 0, 0.28);
}

.bet-cell-amount.empty {
  background: transparent;
}

.bet-cell-amount.staged {
  color: #23150a;
  background: linear-gradient(180deg, #ffe9ad, #f3ca6c);
  box-shadow:
    0 0 0 1px rgba(255, 233, 173, 0.55),
    0 4px 10px rgba(0, 0, 0, 0.24);
  animation: staged-pulse 1.15s ease-in-out infinite;
}

@keyframes staged-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.07);
  }
}
</style>
