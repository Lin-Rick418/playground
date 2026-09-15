<script setup lang="ts">
import { computed } from "vue";
import AppButton from "./AppButton.vue";
import AppSelect from "./AppSelect.vue";
import { formatMoney } from "../../lib/money";
const amount = defineModel<number>({ required: true });
const props = withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    stacked?: boolean;
    compactLandscape?: boolean;
  }>(),
  { min: 100, max: 5000, step: 100, disabled: false, stacked: false, compactLandscape: false },
);
const options = computed(() =>
  Array.from(
    { length: Math.floor((props.max - props.min) / props.step) + 1 },
    (_, i) => props.min + i * props.step,
  ),
);
function adjust(delta: number) {
  amount.value = Math.min(props.max, Math.max(props.min, amount.value + delta));
}
</script>
<template>
  <div
    class="ui-stake stake-row"
    :class="{ 'ui-stake-stacked': stacked, 'ui-stake-landscape': compactLandscape }"
  >
    <label class="stake-field"
      >投注額<AppSelect v-model.number="amount" aria-label="投注額" :disabled="disabled"
        ><option v-for="value in options" :key="value" :value="value">
          {{ formatMoney(value) }}
        </option></AppSelect
      ></label
    >
    <div class="stake-shortcuts amount-buttons" role="group" aria-label="投注額快捷鍵">
      <AppButton
        :disabled="disabled || amount <= min"
        :aria-label="`最低投注 ${min}`"
        @click="amount = min"
        >MIN</AppButton
      >
      <AppButton
        :disabled="disabled || amount <= min"
        :aria-label="`減少投注 ${step}`"
        @click="adjust(-step)"
        >−</AppButton
      >
      <AppButton
        :disabled="disabled || amount >= max"
        :aria-label="`增加投注 ${step}`"
        @click="adjust(step)"
        >＋</AppButton
      >
      <AppButton
        :disabled="disabled || amount >= max"
        :aria-label="`最高投注 ${max}`"
        @click="amount = max"
        >MAX</AppButton
      >
    </div>
  </div>
</template>
