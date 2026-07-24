import { onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { getAuthRevocationMessage } from "../lib/auth-session-message";
import { createLiveSocket } from "../lib/live";
import { useAuthStore } from "../stores/auth";

export function useSessionMonitor() {
  const authStore = useAuthStore();
  const router = useRouter();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let reconnectStopped = true;
  let disposed = false;

  function isAuthenticated() {
    return Boolean(authStore.token && authStore.user);
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function disconnect() {
    clearReconnectTimer();
    const currentSocket = socket;
    socket = null;
    currentSocket?.close();
  }

  function endSession(message: string) {
    reconnectStopped = true;
    disconnect();
    authStore.invalidateSession(message);
    void router.replace("/login");
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    const delayMs = Math.min(1000 * 2 ** reconnectAttempts, 30000);
    reconnectAttempts++;
    reconnectTimer = window.setTimeout(connect, delayMs);
  }

  function connect() {
    disconnect();
    if (disposed || reconnectStopped || !isAuthenticated()) {
      return;
    }

    let opened = false;
    socket = createLiveSocket({
      onOpen: () => {
        opened = true;
        reconnectAttempts = 0;
      },
      onMessage: (message) => {
        if (message.type === "auth_revoked") {
          endSession(getAuthRevocationMessage(message.reason));
        }
      },
      onClose: () => {
        socket = null;
        if (disposed || reconnectStopped || !isAuthenticated()) {
          return;
        }

        const restore = opened
          ? authStore.ensureFreshAccessToken()
          : authStore.refreshAccessToken().then(({ token }) => token);
        void restore
          .then(() => {
            if (!disposed && !reconnectStopped && isAuthenticated()) {
              scheduleReconnect();
            }
          })
          .catch(() => {
            endSession("登入狀態已失效，請重新登入。");
          });
      },
    });
  }

  const stopWatching = watch(
    () => isAuthenticated(),
    (authenticated) => {
      reconnectStopped = !authenticated;
      if (authenticated) {
        connect();
      } else {
        disconnect();
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    disposed = true;
    reconnectStopped = true;
    stopWatching();
    disconnect();
  });
}
