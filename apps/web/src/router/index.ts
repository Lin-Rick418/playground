import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";
import LoginView from "../views/LoginView.vue";
import LobbyView from "../views/LobbyView.vue";
import GameView from "../views/GameView.vue";
import AdminView from "../views/AdminView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/login" },
    { path: "/login", component: LoginView },
    { path: "/lobby", component: LobbyView, meta: { requiresAuth: true, role: "PLAYER" } },
    { path: "/game/:tableId", component: GameView, meta: { requiresAuth: true, role: "PLAYER" } },
    { path: "/admin", component: AdminView, meta: { requiresAuth: true, role: "ADMIN" } },
  ],
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

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
    return authStore.user?.role === "ADMIN" ? "/admin" : "/lobby";
  }

  if (to.path === "/login" && authStore.user) {
    return authStore.user.role === "ADMIN" ? "/admin" : "/lobby";
  }

  return true;
});

export default router;
