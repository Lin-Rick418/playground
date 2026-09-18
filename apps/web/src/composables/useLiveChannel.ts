import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { liveClientMessageSchema, type LiveClientMessage } from "@baccarat/contracts";
import { createLiveSocket, type LiveMessage } from "../lib/live";
import { getAuthRevocationMessage } from "../lib/auth-session-message";
import { parseRuntimeContract } from "../lib/contracts";
import { useAuthStore } from "../stores/auth";
import { createPlinkoRpc } from "../lib/plinko-rpc";
import { createMinesRpc } from "../lib/mines-rpc";
import { createHiloRpc } from "../lib/hilo-rpc";

type ChannelMessage = Exclude<
  LiveMessage,
  { type: "connected" } | { type: "error" } | { type: "auth_revoked" } | { type: "user_snapshot" }
>;

type UseLiveChannelOptions = {
  getSubscribeMessage: () => LiveClientMessage;
  onMessage: (message: ChannelMessage) => void | Promise<void>;
  onError?: (message: string) => void;
  /** Runs after every successful subscription, including reconnects. */
  onConnected?: () => void | Promise<void>;
};

export function useLiveChannel(options: UseLiveChannelOptions) {
  const authStore = useAuthStore();
  const router = useRouter();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let disposed = false;
  let generation = 0;
  const connected = ref(false);
  const hiloRpc = createHiloRpc(() => socket);
  const minesRpc = createMinesRpc(() => socket);
  const plinkoRpc = createPlinkoRpc(() => socket);

  function clearReconnectTimer() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function disconnect() {
    generation++;
    connected.value = false;
    minesRpc.disconnect();
    hiloRpc.disconnect();
    plinkoRpc.disconnect();
    clearReconnectTimer();
    socket?.close();
    socket = null;
  }

  function revokeSession(message = "登入狀態已失效，請重新登入。") {
    disposed = true;
    disconnect();
    authStore.invalidateSession(message);
    void router.push("/login");
  }

  function handleMessage(message: LiveMessage) {
    if (
      message.type === "mines_result" ||
      message.type === "plinko_result" ||
      message.type === "hilo_result"
    ) {
      if (message.type === "mines_result") minesRpc.receive(message);
      else if (message.type === "hilo_result") hiloRpc.receive(message);
      else plinkoRpc.receive(message);
      if (!message.result.ok && message.result.status === 401) revokeSession();
      return;
    }
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
      revokeSession(getAuthRevocationMessage(message.reason));
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
        walletVersion: message.data.walletVersion,
      });
      return;
    }

    void options.onMessage(message);
  }

  function connect() {
    if (disposed) return;
    disconnect();
    const currentGeneration = generation;

    socket = createLiveSocket({
      onOpen: (ws) => {
        if (disposed || socket !== ws) {
          ws.close();
          return;
        }
        connected.value = true;
        reconnectAttempts = 0;
        try {
          const subscription = parseRuntimeContract(
            liveClientMessageSchema,
            options.getSubscribeMessage(),
            "client.live.subscription",
            "WebSocket message",
          );
          ws.send(JSON.stringify(subscription));
          void options.onConnected?.();
        } catch {
          options.onError?.("即時連線訂閱格式錯誤");
          ws.close(1002, "Invalid subscription message");
        }
      },
      onMessage: (message) => {
        if (!disposed && generation === currentGeneration) handleMessage(message);
      },
      onClose: () => {
        if (generation !== currentGeneration) return;
        socket = null;
        connected.value = false;
        minesRpc.disconnect();
        hiloRpc.disconnect();
        plinkoRpc.disconnect();
        if (disposed) {
          return;
        }

        void authStore
          .ensureFreshAccessToken()
          .then(() => {
            if (disposed || generation !== currentGeneration) return;
            clearReconnectTimer();
            const delayMs = Math.min(1000 * 2 ** reconnectAttempts, 30000);
            reconnectAttempts++;
            reconnectTimer = window.setTimeout(() => {
              connect();
            }, delayMs);
          })
          .catch(() => {
            if (disposed || generation !== currentGeneration) return;
            authStore.invalidateSession("登入狀態已失效，請重新登入。");
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
    connected,
    requestHilo: hiloRpc.request,
    requestMines: minesRpc.request,
    requestPlinko: plinkoRpc.request,
    reconnect: connect,
    disconnect,
  };
}
