<script setup lang="ts">
import AppInput from "../components/ui/AppInput.vue";
import AppButton from "../components/ui/AppButton.vue";
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
      <AppButton
        variant="secondary"
        size="control"
        class="button-secondary"
        type="button"
        @click="router.push(returnPath)"
        >返回</AppButton
      >
    </header>

    <form class="panel account-form" @submit.prevent="submit">
      <p class="password-hint">
        新密碼至少 6 碼、最多 72 碼，須包含英文字母與數字；可使用符號，不可包含空白或帳號。
      </p>
      <label class="field">
        <span>目前密碼</span>
        <AppInput
          v-model="form.currentPassword"
          type="password"
          autocomplete="current-password"
          required
          maxlength="256"
        />
      </label>
      <label class="field">
        <span>新密碼</span>
        <AppInput
          v-model="form.newPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="6"
          maxlength="72"
          pattern="(?=.*[A-Za-z])(?=.*[0-9])[\x21-\x7E]{6,72}"
        />
      </label>
      <label class="field">
        <span>確認新密碼</span>
        <AppInput
          v-model="form.confirmPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="6"
          maxlength="72"
          pattern="(?=.*[A-Za-z])(?=.*[0-9])[\x21-\x7E]{6,72}"
        />
      </label>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="success" class="success-text">{{ success }}</p>
      <AppButton
        variant="primary"
        size="action"
        class="button-primary"
        type="submit"
        :disabled="saving"
        >{{ saving ? "更新中..." : "更新密碼" }}</AppButton
      >
    </form>
  </main>
</template>

<style scoped lang="scss">
.account-page {
  display: grid;
  gap: $space-5;
  max-width: 720px;
}
.account-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-5;
}
.account-head h1 {
  margin: $space-1 0 0;
}
.topbar-label {
  margin: 0;
  color: rgba(247, 244, 233, 0.6);
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.account-form {
  display: flex;
  flex-direction: column;
  gap: $space-4;
  padding: $space-6;
}
.password-hint {
  margin: 0;
  color: rgba(247, 244, 233, 0.68);
  line-height: 1.6;
}
.success-text {
  color: #8ce6a8;
}
</style>
