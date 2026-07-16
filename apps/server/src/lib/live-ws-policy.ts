export const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024;
export const MAX_WEBSOCKET_CONNECTIONS = 500;
export const MAX_WEBSOCKET_CONNECTIONS_PER_IP = 20;
export const MAX_WEBSOCKET_CONNECTIONS_PER_USER = 5;
export const MAX_WEBSOCKET_UPGRADES_PER_IP = 30;
export const WEBSOCKET_UPGRADE_WINDOW_MS = 60_000;
export const MAX_WEBSOCKET_MESSAGES_PER_WINDOW = 20;
export const WEBSOCKET_MESSAGE_WINDOW_MS = 10_000;

export type RateWindow = { timestamps: number[] };
export type WebSocketClientMessage =
  | { type: "subscribe_lobby" }
  | { type: "subscribe_table"; tableId: string };

export function isWebSocketPayloadAllowed(byteLength: number) {
  return byteLength <= MAX_WEBSOCKET_PAYLOAD_BYTES;
}

export function parseWebSocketClientMessage(data: string): WebSocketClientMessage | null {
  try {
    const message = JSON.parse(data) as WebSocketClientMessage;
    if (message.type === "subscribe_lobby") {
      return message;
    }

    if (message.type === "subscribe_table" && typeof message.tableId === "string" && message.tableId.length > 0) {
      return message;
    }

    return null;
  } catch {
    return null;
  }
}

export function consumeRateLimit(
  window: RateWindow,
  now: number,
  limit: number,
  windowMs: number,
) {
  const cutoff = now - windowMs;
  window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);

  if (window.timestamps.length >= limit) {
    return false;
  }

  window.timestamps.push(now);
  return true;
}

export function pruneRateWindows(windows: Map<string, RateWindow>, now: number, windowMs: number) {
  const cutoff = now - windowMs;
  for (const [key, window] of windows.entries()) {
    if (!window.timestamps.some((timestamp) => timestamp > cutoff)) {
      windows.delete(key);
    }
  }
}

export function isConnectionLimitExceeded(
  input: { total: number; forIp: number; forUser?: number },
) {
  return (
    input.total >= MAX_WEBSOCKET_CONNECTIONS ||
    input.forIp >= MAX_WEBSOCKET_CONNECTIONS_PER_IP ||
    (input.forUser !== undefined && input.forUser >= MAX_WEBSOCKET_CONNECTIONS_PER_USER)
  );
}
