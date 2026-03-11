import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { createLiveSocket, type LiveMessage } from "../lib/live";
import { useAuthStore } from "../stores/auth";

type ChannelMessage = Exclude<LiveMessage, { type: "connected" } | { type: "error" } | { type: "user_snapshot" }>;

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

  function handleMessage(message: LiveMessage) {
    if (message.type === "connected") {
      return;
    }

    if (message.type === "error") {
      options.onError?.(message.message);
      return;
    }

    if (message.type === "user_snapshot") {
      if (!message.data.isActive) {
        authStore.logout();
        router.push("/login");
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
        ws.send(JSON.stringify(options.getSubscribeMessage()));
      },
      onMessage: handleMessage,
      onClose: () => {
        if (disposed) {
          return;
        }

        clearReconnectTimer();
        reconnectTimer = window.setTimeout(() => {
          connect();
        }, 1000);
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
