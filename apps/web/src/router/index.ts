import HiloView from "../views/HiloView.vue";
import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";
import LoginView from "../views/LoginView.vue";
import LobbyView from "../views/LobbyView.vue";
import BaccaratLobbyView from "../views/BaccaratLobbyView.vue";
import MinesView from "../views/MinesView.vue";
import PlinkoView from "../views/PlinkoView.vue";
import GameView from "../views/GameView.vue";
import GameRulesView from "../views/GameRulesView.vue";
import AccountView from "../views/AccountView.vue";
import BetHistoryView from "../views/BetHistoryView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/hilo", component: HiloView, meta: { requiresAuth: true, role: "PLAYER", keepScreenAwake: true } },
    { path: "/", redirect: "/login" },
    { path: "/login", component: LoginView },
    {
      path: "/lobby",
      component: LobbyView,
      meta: { requiresAuth: true, role: "PLAYER", keepScreenAwake: true },
    },
    {
      path: "/baccarat",
      component: BaccaratLobbyView,
      meta: { requiresAuth: true, role: "PLAYER", keepScreenAwake: true },
    },
    {
      path: "/mines",
      component: MinesView,
      meta: { requiresAuth: true, role: "PLAYER", keepScreenAwake: true },
    },
    {
      path: "/plinko",
      component: PlinkoView,
      meta: { requiresAuth: true, role: "PLAYER", keepScreenAwake: true },
    },
    {
      path: "/game/:tableId",
      component: GameView,
      meta: { requiresAuth: true, role: "PLAYER", keepScreenAwake: true },
    },
    {
      path: "/game/:tableId/rules",
      name: "game-rules",
      component: GameRulesView,
      meta: { requiresAuth: true, role: "PLAYER" },
    },
    { path: "/history", component: BetHistoryView, meta: { requiresAuth: true, role: "PLAYER" } },
    { path: "/account", component: AccountView, meta: { requiresAuth: true, role: "PLAYER" } },
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

  if (to.path === "/history" && (to.query.game === "mines" || to.query.game === "plinko")) {
    return { path: `/${to.query.game}`, replace: true };
  }

  return true;
});

export default router;
