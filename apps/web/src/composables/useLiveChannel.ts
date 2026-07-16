import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { createLiveSocket, type LiveMessage } from "../lib/live";
import { useAuthStore } from "../stores/auth";

type ChannelMessage = Exclude<
  LiveMessage,
  { type: "connected" } | { type: "error" } | { type: "auth_revoked" } | { type: "user_snapshot" }
>;

type UseLiveChannelOptions = {
  getSubscribeMessage: () => Record<string, unknown>;
  onMessage: (message: ChannelMessage) => void | Promise<void>;
  onError?: (message: string) => void;
};

export function useLiveChannel(options: UseLiveChannelOptions) {
  const authStore = useAuthStore();
  const router = useRouter();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let disposed = false;

  function clearReconnectTimer() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function disconnect() {
    clearReconnectTimer();
    socket?.close();
    socket = null;
  }

  function revokeSession() {
    disposed = true;
    disconnect();
    authStore.logout();
    void router.push("/login");
  }

  function handleMessage(message: LiveMessage) {
    if (message.type === "connected") {
      return;
    }

    if (message.type === "error") {
      options.onError?.(message.message);
      return;
    }

    if (message.type === "auth_revoked") {
      revokeSession();
      return;
    }

    if (message.type === "user_snapshot") {
      if (!message.data.isActive) {
        revokeSession();
        return;
      }

      authStore.setUser({
        id: message.data.id,
        username: message.data.username,
        role: message.data.role,
        isActive: message.data.isActive,
        balance: message.data.balance,
      });
      return;
    }

    void options.onMessage(message);
  }

  function connect() {
    disconnect();

    socket = createLiveSocket({
      onOpen: (ws) => {
        reconnectAttempts = 0;
        ws.send(JSON.stringify(options.getSubscribeMessage()));
      },
      onMessage: handleMessage,
      onClose: () => {
        if (disposed) {
          return;
        }

        clearReconnectTimer();
        const delayMs = Math.min(1000 * 2 ** reconnectAttempts, 30000);
        reconnectAttempts++;
        reconnectTimer = window.setTimeout(() => {
          connect();
        }, delayMs);
      },
    });
  }

  onMounted(() => {
    disposed = false;
    connect();
  });

  onUnmounted(() => {
    disposed = true;
    disconnect();
  });

  return {
    reconnect: connect,
    disconnect,
  };
}
