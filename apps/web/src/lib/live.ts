import { liveServerMessageSchema, type LiveServerMessage } from "@baccarat/contracts";
import { getStoredToken } from "./settings";
import { ContractValidationError, parseRuntimeContract } from "./contracts";

export type LiveMessage = LiveServerMessage;
export type LobbySnapshotMessage = Extract<LiveMessage, { type: "lobby_snapshot" }>;
export type TableSnapshotMessage = Extract<LiveMessage, { type: "table_snapshot" }>;
export type TableUserSnapshotMessage = Extract<LiveMessage, { type: "table_user_snapshot" }>;
export type UserSnapshotMessage = Extract<LiveMessage, { type: "user_snapshot" }>;

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

export function parseLiveMessage(rawMessage: string) {
  let payload: unknown;

  try {
    payload = JSON.parse(rawMessage);
  } catch {
    const issues = [{ code: "invalid_json", path: "" }];
    console.error("WebSocket message contract validation failed", {
      contract: "server.live.message",
      issues,
    });
    throw new ContractValidationError("server.live.message", issues);
  }

  return parseRuntimeContract(
    liveServerMessageSchema,
    payload,
    "server.live.message",
    "WebSocket message",
  );
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
      callbacks.onMessage(parseLiveMessage(String(event.data)));
    } catch {
      socket.close(1002, "Invalid server message");
    }
  });

  socket.addEventListener("close", () => {
    callbacks.onClose?.();
  });

  return socket;
}
