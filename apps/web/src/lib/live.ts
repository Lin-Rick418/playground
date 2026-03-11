export type LiveUpdateEvent = {
  type: "connected" | "lobby_updated" | "table_updated" | "user_updated";
  reason?: string;
  tableId?: string;
  userId?: string;
  at: string;
};

function buildStreamUrl(path: string) {
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${normalizedBase}${normalizedPath}`, window.location.origin);
  const token = localStorage.getItem("baccarat_token");

  if (token) {
    url.searchParams.set("token", token);
  }

  return url.toString();
}

export function createLiveEventSource(path: string, onEvent: (event: LiveUpdateEvent) => void) {
  const source = new EventSource(buildStreamUrl(path));

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as LiveUpdateEvent;
      onEvent(event);
    } catch {
      // Ignore malformed keep-alive payloads.
    }
  };

  return source;
}
