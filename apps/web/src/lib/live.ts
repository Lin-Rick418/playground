import { getStoredToken } from "./settings";
import type { ActiveRound, CurrentBet, GameTable, LobbyTable, PresentationWindow, RoundConfig, ShoeStatus, User } from "../types/domain";

export type LobbySnapshotMessage = {
  type: "lobby_snapshot";
  data: {
    tables: LobbyTable[];
    config: RoundConfig;
    serverTime: string;
  };
};

export type TableSnapshotMessage = {
  type: "table_snapshot";
  data: {
    table: GameTable;
        round: ActiveRound | null;
        previousRound: ActiveRound | null;
        presentation: PresentationWindow | null;
        recentRounds: ActiveRound[];
        roadRounds: ActiveRound[];
        shoeStatus: ShoeStatus;
        config: RoundConfig;
        serverTime: string;
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

export type LiveMessage =
  | { type: "connected"; serverTime: string }
  | { type: "error"; message: string }
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
