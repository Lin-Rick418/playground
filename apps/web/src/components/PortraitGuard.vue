<script setup lang="ts">
import { onUnmounted, ref, watchPostEffect } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import AppButton from "./ui/AppButton.vue";

const props = defineProps<{ blocked: boolean; canReturn: boolean }>();
defineEmits<{ return: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const heading = ref<HTMLElement | null>(null);
watchPostEffect(() => {
  if (!dialog.value) return;
  if (props.blocked && !dialog.value.open) {
    // The native top layer also covers already-open game rules/settings dialogs.
    dialog.value.showModal();
    heading.value?.focus({ preventScroll: true });
  } else if (!props.blocked && dialog.value.open) {
    dialog.value.close();
  }
});
onUnmounted(() => dialog.value?.close());
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="portrait-guard"
      aria-labelledby="portrait-title"
      aria-describedby="portrait-description"
      @cancel.prevent
    >
      <div class="portrait-guard-content">
        <div class="portrait-guard-icon"><AppIcon name="rotate" /></div>
        <h1 id="portrait-title" ref="heading" tabindex="-1">請將裝置轉為直向遊玩</h1>
        <p id="portrait-description">遊戲僅支援直向畫面，轉回直向即可繼續。</p>
        <AppButton v-if="canReturn" variant="secondary" @click="$emit('return')">
          返回遊戲大廳
        </AppButton>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.portrait-guard {
  position: fixed;
  inset: 0;
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  height: 100vh;
  height: 100dvh;
  max-height: none;
  margin: 0;
  padding: max(20px, env(safe-area-inset-top, 0px)) max(24px, env(safe-area-inset-right, 0px))
    max(20px, env(safe-area-inset-bottom, 0px)) max(24px, env(safe-area-inset-left, 0px));
  border: 0;
  border-radius: 0;
  color: #f4ecd7;
  background: radial-gradient(ellipse at 50% 30%, #183b38 0%, #0a2027 52%, #06151d 100%);
  overflow: auto;
  overscroll-behavior: contain;
}
.portrait-guard[open] {
  display: grid;
  place-items: center;
}
.portrait-guard::backdrop {
  background: #06151d;
}
.portrait-guard-content {
  display: grid;
  justify-items: center;
  gap: 14px;
  max-width: 480px;
  text-align: center;
}
.portrait-guard-icon {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border: 1px solid rgb(224 194 129 / 35%);
  border-radius: 50%;
  color: #e0c281;
  font-size: 40px;
  background: rgb(224 194 129 / 6%);
}
.portrait-guard h1 {
  margin: 0;
  font-size: clamp(20px, 4vw, 28px);
  line-height: 1.4;
  font-weight: 600;
  outline: none;
}
.portrait-guard p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: #b5c9c9;
}
.portrait-guard .ui-button {
  margin-top: 6px;
}
@media (max-height: 350px) {
  .portrait-guard-content {
    gap: 10px;
  }
  .portrait-guard-icon {
    width: 56px;
    height: 56px;
    font-size: 32px;
  }
}
</style>
