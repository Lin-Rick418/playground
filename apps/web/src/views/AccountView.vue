<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";

const authStore = useAuthStore();
const router = useRouter();
const form = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
const error = ref("");
const success = ref("");
const saving = ref(false);
const returnPath = computed(() => "/lobby");

async function submit() {
  error.value = "";
  success.value = "";
  if (form.newPassword !== form.confirmPassword) {
    error.value = "新密碼與確認密碼不一致。";
    return;
  }
  saving.value = true;
  try {
    await authStore.changePassword(form.currentPassword, form.newPassword);
    form.currentPassword = "";
    form.newPassword = "";
    form.confirmPassword = "";
    success.value = "密碼已更新，其他既有登入階段已失效。";
  } catch {
    error.value = "密碼更新失敗，請確認目前密碼與新密碼規則。";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <main class="page-shell account-page">
    <header class="panel account-head">
      <div>
        <p class="topbar-label">Account Security</p>
        <h1>變更密碼</h1>
      </div>
      <button class="button-secondary" type="button" @click="router.push(returnPath)">返回</button>
    </header>

    <form class="panel account-form" @submit.prevent="submit">
      <p class="password-hint">新密碼須為 12–72 個 ASCII 字元，並包含英文大小寫、數字與符號，且不可包含帳號。</p>
      <label class="field">
        <span>目前密碼</span>
        <input v-model="form.currentPassword" type="password" autocomplete="current-password" required maxlength="256" />
      </label>
      <label class="field">
        <span>新密碼</span>
        <input v-model="form.newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="72" />
      </label>
      <label class="field">
        <span>確認新密碼</span>
        <input v-model="form.confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="72" />
      </label>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="success" class="success-text">{{ success }}</p>
      <button class="button-primary" type="submit" :disabled="saving">{{ saving ? "更新中..." : "更新密碼" }}</button>
    </form>
  </main>
</template>

<style scoped lang="scss">
.account-page { display: grid; gap: $space-5; max-width: 720px; }
.account-head { display: flex; align-items: center; justify-content: space-between; padding: $space-5; }
.account-head h1 { margin: $space-1 0 0; }
.topbar-label { margin: 0; color: rgba(247, 244, 233, 0.6); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; }
.account-form { display: flex; flex-direction: column; gap: $space-4; padding: $space-6; }
.password-hint { margin: 0; color: rgba(247, 244, 233, 0.68); line-height: 1.6; }
.success-text { color: #8ce6a8; }
</style>
