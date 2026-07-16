<script setup lang="ts">
import { reactive } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const authStore = useAuthStore();

const form = reactive({
  username: "",
  password: "",
});

async function onSubmit() {
  const user = await authStore.login(form.username, form.password);
  router.push(user.role === "ADMIN" ? "/admin" : "/lobby");
}
</script>

<template>
  <main class="page-shell login-layout">
    <section class="login-stage">
      <div class="login-copy">
        <p class="eyebrow">Live Table</p>
        <h1><span>Baccarat</span></h1>
        <!-- <p class="intro">進入桌面，開始下注。</p> -->
      </div>

      <section class="panel login-card">
        <div class="login-card-head">
          <div class="login-card-title">
            <p class="card-label">Sign In</p>
            <h2>會員登入</h2>
          </div>
        </div>

        <div class="login-card-body">
          <form class="login-form" @submit.prevent="onSubmit">
            <label class="field">
              <span>帳號</span>
              <input v-model="form.username" name="username" autocomplete="username" placeholder="輸入帳號" required />
            </label>

            <label class="field">
              <span>密碼</span>
              <input
                v-model="form.password"
                name="password"
                type="password"
                autocomplete="current-password"
                placeholder="輸入密碼"
                required
              />
            </label>

            <p v-if="authStore.error" class="error-text">{{ authStore.error }}</p>

            <button class="button-primary login-submit" :disabled="authStore.loading" type="submit">
              {{ authStore.loading ? "登入中..." : "登入" }}
            </button>
          </form>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped lang="scss">
.login-layout {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  width: 100%;
  min-height: 100vh;
  max-width: 100vw;
  overflow: hidden;
  overflow-x: clip;
  overscroll-behavior-x: none;
  padding-top: clamp(48px, 10vh, 96px);
  background: $gradient-felt;
}

.login-layout::before,
.login-layout::after {
  content: "";
  position: absolute;
  border-radius: 999px;
  filter: blur(12px);
  opacity: 0.8;
}

.login-layout::before {
  width: 220px;
  height: 220px;
  top: 8%;
  right: -48px;
  background: radial-gradient(circle, rgba(255, 226, 158, 0.2), transparent 72%);
}

.login-layout::after {
  width: 260px;
  height: 260px;
  left: -88px;
  bottom: 10%;
  background: radial-gradient(circle, rgba(5, 48, 31, 0.24), transparent 70%);
}

.login-stage {
  position: relative;
  z-index: 1;
  width: min(100%, 440px);
  min-height: calc(100vh - clamp(88px, 14vh, 140px));
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $space-5;
  transform: translateY(clamp(-34px, -5vh, -18px));
}

.eyebrow {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.3em;
  color: $color-gold-strong;
  font-size: 12px;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  text-align: center;
}

.login-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
  text-align: center;
}

.login-copy h1 {
  margin: $space-1 0 $space-2;
  line-height: 0.9;
  font-family: "Cormorant Garamond", "Times New Roman", serif;
}

.login-copy h1 span {
  display: inline-block;
  font-size: clamp(58px, 19vw, 96px);
  font-weight: 800;
  letter-spacing: 0.03em;
  @include gold-gradient-text();
}

.login-card {
  position: relative;
  width: 100%;
  max-width: 100%;
  padding: 0 $space-6 $space-6;
  background:
    linear-gradient(180deg, rgba(7, 48, 33, 0.76), rgba(5, 34, 23, 0.82)),
    $color-panel-surface;
  border-color: $color-border-soft;
}

.login-card-head {
  position: absolute;
  top: 0;
  left: 50%;
  width: calc(100% - 48px);
  display: flex;
  justify-content: center;
  transform: translateX(-50%);
  pointer-events: none;
}

.login-card-title {
  position: relative;
  top: $space-10;
  min-width: 180px;
  padding: 0 $space-5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $space-2;
  text-align: center;
}

.login-card-body {
  padding-top: 136px;
}

.card-label {
  margin: 0;
  color: $color-text-faint;
  font-size: 11px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-card h2 {
  margin: 0;
  font-size: 28px;
  line-height: 1;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: $space-4;
}

.field span {
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: 13px;
  color: $color-text-muted;
}

.field input {
  min-height: 52px;
  border-radius: 14px;
  background: $color-surface-soft;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.field input::placeholder {
  color: $color-text-faint;
}

.error-text {
  color: $color-negative;
  margin: 0;
  text-align: center;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-submit {
  width: 100%;
  min-height: 52px;
  border-radius: 14px;
  font-size: 16px;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-submit:not(:disabled):active {
  transform: translateY(1px);
  filter: brightness(1.04);
}
</style>
