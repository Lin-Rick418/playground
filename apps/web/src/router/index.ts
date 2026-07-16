import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";
import LoginView from "../views/LoginView.vue";
import LobbyView from "../views/LobbyView.vue";
import GameView from "../views/GameView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/login" },
    { path: "/login", component: LoginView },
    { path: "/lobby", component: LobbyView, meta: { requiresAuth: true, role: "PLAYER" } },
    { path: "/game/:tableId", component: GameView, meta: { requiresAuth: true, role: "PLAYER" } },
    { path: "/:pathMatch(.*)*", redirect: "/login" },
  ],
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  await authStore.restoreSession();

  if (authStore.token && !authStore.user) {
    try {
      await authStore.fetchMe();
    } catch {
      authStore.logout();
    }
  }

  if (to.meta.requiresAuth && !authStore.user) {
    return "/login";
  }

  if (to.meta.role && authStore.user?.role !== to.meta.role) {
    await authStore.logout();
    return "/login";
  }

  if (to.path === "/login" && authStore.user) {
    return "/lobby";
  }

  return true;
});

export default router;
