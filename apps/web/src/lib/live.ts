import { getStoredToken } from "./settings";
import type { CurrentBet, LobbySnapshot, RoundConfig, TableSnapshot, User } from "../types/domain";

export type LobbySnapshotMessage = {
  type: "lobby_snapshot";
  data: LobbySnapshot & {
    config: RoundConfig;
  };
};

export type TableSnapshotMessage = {
  type: "table_snapshot";
  data: TableSnapshot & {
    config: RoundConfig;
  };
};

export type TableUserSnapshotMessage = {
  type: "table_user_snapshot";
  data: {
    tableId: string;
    currentRoundId: string;
    myBets: CurrentBet[];
    balance: number;
    isActive: boolean;
    serverTime: string;
  };
};

export type UserSnapshotMessage = {
  type: "user_snapshot";
  data: User & {
    serverTime: string;
  };
};

export type AuthRevokedMessage = {
  type: "auth_revoked";
  reason: "user_deleted" | "account_disabled" | "role_changed";
};

export type LiveMessage =
  | { type: "connected"; serverTime: string }
  | { type: "error"; message: string }
  | AuthRevokedMessage
  | LobbySnapshotMessage
  | TableSnapshotMessage
  | TableUserSnapshotMessage
  | UserSnapshotMessage;

type SocketCallbacks = {
  onMessage: (message: LiveMessage) => void;
  onOpen?: (socket: WebSocket) => void;
  onClose?: () => void;
};

function buildWebSocketUrl() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
  const normalizedBase = new URL(baseUrl, window.location.origin);
  normalizedBase.protocol = normalizedBase.protocol === "https:" ? "wss:" : "ws:";
  normalizedBase.pathname = `${normalizedBase.pathname.replace(/\/$/, "")}/ws`;

  return normalizedBase.toString();
}

export function createLiveSocket(callbacks: SocketCallbacks) {
  // The token travels in the Sec-WebSocket-Protocol header rather than the
  // URL so it stays out of server access logs and browser history.
  const token = getStoredToken();
  const socket = new WebSocket(buildWebSocketUrl(), token ? ["bearer", token] : undefined);

  socket.addEventListener("open", () => {
    callbacks.onOpen?.(socket);
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as LiveMessage;
      callbacks.onMessage(message);
    } catch {
      // Ignore malformed messages.
    }
  });

  socket.addEventListener("close", () => {
    callbacks.onClose?.();
  });

  return socket;
}
