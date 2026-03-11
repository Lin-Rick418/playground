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
  await authStore.login(form.username, form.password);
  router.push(authStore.user?.role === "ADMIN" ? "/admin" : "/lobby");
}
</script>

<template>
  <main class="page-shell login-layout">
    <section class="login-stage">
      <div class="login-copy">
        <p class="eyebrow">Live Table</p>
        <h1><span>Baccarat</span></h1>
        <p class="intro">進入桌面，開始下注。</p>
      </div>

      <section class="panel login-card">
        <div class="login-card-head">
          <p class="card-label">Sign In</p>
          <h2>會員登入</h2>
        </div>

        <form class="login-form" @submit.prevent="onSubmit">
          <label class="field">
            <span>帳號</span>
            <input v-model="form.username" placeholder="輸入帳號" />
          </label>

          <label class="field">
            <span>密碼</span>
            <input v-model="form.password" type="password" placeholder="輸入密碼" />
          </label>

          <p v-if="authStore.error" class="error-text">{{ authStore.error }}</p>

          <button class="button-primary login-submit" :disabled="authStore.loading" type="submit">
            {{ authStore.loading ? "登入中..." : "登入" }}
          </button>
        </form>
      </section>
    </section>
  </main>
</template>

<style scoped>
@import url("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@700;800&family=Manrope:wght@500;700;800&display=swap");

.login-layout {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 100vw;
  overflow: hidden;
  overflow-x: clip;
  overscroll-behavior-x: none;
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
  background: radial-gradient(circle, rgba(244, 222, 155, 0.2), transparent 72%);
}

.login-layout::after {
  width: 260px;
  height: 260px;
  left: -86px;
  bottom: 10%;
  background: radial-gradient(circle, rgba(97, 182, 144, 0.18), transparent 70%);
}

.login-stage {
  position: relative;
  z-index: 1;
  width: min(100%, 440px);
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}

.eyebrow {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.3em;
  color: #dfb95d;
  font-size: 12px;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  text-align: center;
}

.login-copy {
  text-align: center;
}

.login-copy h1 {
  margin: 6px 0 10px;
  line-height: 0.9;
  font-family: "Cormorant Garamond", "Times New Roman", serif;
}

.login-copy h1 span {
  display: inline-block;
  font-size: clamp(58px, 19vw, 96px);
  font-weight: 800;
  letter-spacing: 0.03em;
  color: #f7e9b7;
  text-shadow:
    0 0 18px rgba(244, 222, 155, 0.18),
    0 10px 24px rgba(0, 0, 0, 0.22);
  background: linear-gradient(180deg, #fff7da 0%, #f4de9b 38%, #d7a74c 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.intro {
  margin: 0;
  color: rgba(247, 244, 233, 0.75);
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-card {
  width: 100%;
  max-width: 100%;
  padding: 24px 22px 22px;
  background:
    linear-gradient(180deg, rgba(11, 33, 26, 0.92), rgba(7, 22, 17, 0.92)),
    rgba(8, 25, 20, 0.82);
}

.login-card-head {
  margin-bottom: 18px;
  text-align: center;
}

.card-label {
  margin: 0 0 6px;
  color: rgba(247, 244, 233, 0.45);
  font-size: 11px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-card h2 {
  margin: 0;
  font-size: 28px;
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field span {
  font-family: "Manrope", "Noto Sans TC", sans-serif;
  font-size: 13px;
  color: rgba(247, 244, 233, 0.76);
}

.field input {
  min-height: 52px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.07);
  font-family: "Manrope", "Noto Sans TC", sans-serif;
}

.field input::placeholder {
  color: rgba(247, 244, 233, 0.38);
}

.error-text {
  color: #ffb0b0;
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
</style>
