import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { liveClientMessageSchema, type LiveClientMessage } from "@baccarat/contracts";
import { createLiveSocket, type LiveMessage } from "../lib/live";
import { parseRuntimeContract } from "../lib/contracts";
import { useAuthStore } from "../stores/auth";

type ChannelMessage = Exclude<
  LiveMessage,
  { type: "connected" } | { type: "error" } | { type: "auth_revoked" } | { type: "user_snapshot" }
>;

type UseLiveChannelOptions = {
  getSubscribeMessage: () => LiveClientMessage;
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
      if (message.message === "Session is no longer valid") {
        revokeSession();
        return;
      }
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
        try {
          const subscription = parseRuntimeContract(
            liveClientMessageSchema,
            options.getSubscribeMessage(),
            "client.live.subscription",
            "WebSocket message",
          );
          ws.send(JSON.stringify(subscription));
        } catch {
          options.onError?.("即時連線訂閱格式錯誤");
          ws.close(1002, "Invalid subscription message");
        }
      },
      onMessage: handleMessage,
      onClose: () => {
        if (disposed) {
          return;
        }

        void authStore
          .ensureFreshAccessToken()
          .then(() => {
            clearReconnectTimer();
            const delayMs = Math.min(1000 * 2 ** reconnectAttempts, 30000);
            reconnectAttempts++;
            reconnectTimer = window.setTimeout(() => {
              connect();
            }, delayMs);
          })
          .catch(() => {
            authStore.logout();
            void router.push("/login");
          });
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
