import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import {
  buildLobbyTables,
  buildTablePublicState,
  buildTableUserState,
  buildUserLiveState,
  findTableById,
  findUserById,
  isAuthSessionActive,
} from "./db.js";
import { startLiveEventSubscriber, type LiveEvent } from "./live-events.js";
import {
  MAX_WEBSOCKET_MESSAGES_PER_WINDOW,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  MAX_WEBSOCKET_UPGRADES_PER_IP,
  WEBSOCKET_MESSAGE_WINDOW_MS,
  WEBSOCKET_UPGRADE_WINDOW_MS,
  consumeRateLimit,
  isConnectionLimitExceeded,
  isWebSocketPayloadAllowed,
  parseWebSocketClientMessage,
  pruneRateWindows,
  type RateWindow,
  type WebSocketClientMessage,
} from "./live-ws-policy.js";
import { getRoundConfig } from "./round-manager.js";

type LiveSocketConnection = {
  id: string;
  userId: string;
  clientIp: string;
  sessionId: string;
  socket: WebSocket;
  lastPongAt: number;
  messageWindow: RateWindow;
  subscription: { scope: "none" } | { scope: "lobby" } | { scope: "table"; tableId: string };
};

type ServerMessage =
  | { type: "connected"; serverTime: string }
  | { type: "error"; message: string }
  | {
      type: "lobby_snapshot";
      data: {
        tables: Awaited<ReturnType<typeof buildLobbyTables>>;
        config: ReturnType<typeof getRoundConfig>;
        serverTime: string;
      };
    }
  | {
      type: "table_snapshot";
      data: NonNullable<Awaited<ReturnType<typeof buildTablePublicState>>> & {
        config: ReturnType<typeof getRoundConfig>;
      };
    }
  | {
      type: "table_user_snapshot";
      data: Awaited<ReturnType<typeof buildTableUserState>>;
    }
  | {
      type: "user_snapshot";
      data: NonNullable<Awaited<ReturnType<typeof buildUserLiveState>>>;
    };

const connections = new Map<string, LiveSocketConnection>();
const upgradeWindows = new Map<string, RateWindow>();
let stopSubscriber: null | (() => Promise<void>) = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

function sendMessage(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    socket.send(JSON.stringify(message), (error) => {
      if (error) {
        console.error("Live WebSocket send failed", error);
        socket.terminate();
      }
    });
  } catch (error) {
    console.error("Live WebSocket send failed", error);
    socket.terminate();
  }
}

async function pushLobbySnapshot(connection: LiveSocketConnection) {
  const tables = await buildLobbyTables();
  sendMessage(connection.socket, {
    type: "lobby_snapshot",
    data: {
      tables,
      config: getRoundConfig(),
      serverTime: new Date().toISOString(),
    },
  });
}

async function pushUserSnapshot(connection: LiveSocketConnection) {
  const user = await buildUserLiveState(connection.userId);

  if (!user) {
    sendMessage(connection.socket, {
      type: "error",
      message: "User not found",
    });
    connection.socket.close();
    return;
  }

  sendMessage(connection.socket, {
    type: "user_snapshot",
    data: user,
  });
}

async function pushTableSnapshot(connection: LiveSocketConnection, tableId: string) {
  const tableState = await buildTablePublicState(tableId);

  if (!tableState || !tableState.round) {
    sendMessage(connection.socket, {
      type: "error",
      message: "Table not found",
    });
    return;
  }

  sendMessage(connection.socket, {
    type: "table_snapshot",
    data: {
      ...tableState,
      config: getRoundConfig(),
    },
  });
}

async function pushTableUserSnapshot(connection: LiveSocketConnection, tableId: string) {
  const state = await buildTableUserState(connection.userId, tableId);
  sendMessage(connection.socket, {
    type: "table_user_snapshot",
    data: state,
  });
}

async function handleSubscriptionMessage(connection: LiveSocketConnection, message: WebSocketClientMessage) {
  if (message.type === "subscribe_lobby") {
    connection.subscription = { scope: "lobby" };
    await Promise.all([pushLobbySnapshot(connection), pushUserSnapshot(connection)]);
    return;
  }

  const table = await findTableById(message.tableId);
  if (!table) {
    sendMessage(connection.socket, {
      type: "error",
      message: "Table not found",
    });
    return;
  }

  connection.subscription = { scope: "table", tableId: table.id };
  await Promise.all([pushTableSnapshot(connection, table.id), pushTableUserSnapshot(connection, table.id), pushUserSnapshot(connection)]);
}

async function handleLiveEvent(event: LiveEvent) {
  if (event.type === "session_revoked") {
    for (const connection of connections.values()) {
      if (connection.sessionId === event.sessionId) {
        sendMessage(connection.socket, { type: "error", message: "Session ended" });
        connection.socket.close(1008, "Session ended");
      }
    }
    return;
  }

  if (event.type === "table_changed") {
    const lobbyConnections = Array.from(connections.values()).filter((connection) => connection.subscription.scope === "lobby");
    const tableConnections = Array.from(connections.values()).filter(
      (connection) => connection.subscription.scope === "table" && connection.subscription.tableId === event.tableId,
    );

    const [lobbySnapshot, tableSnapshot] = await Promise.all([
      lobbyConnections.length > 0 ? buildLobbyTables() : null,
      tableConnections.length > 0 ? buildTablePublicState(event.tableId) : null,
    ]);

    for (const connection of lobbyConnections) {
      sendMessage(connection.socket, {
        type: "lobby_snapshot",
        data: {
          tables: lobbySnapshot ?? [],
          config: getRoundConfig(),
          serverTime: new Date().toISOString(),
        },
      });
    }

    for (const connection of tableConnections) {
      if (tableSnapshot?.round) {
        sendMessage(connection.socket, {
          type: "table_snapshot",
          data: {
            ...tableSnapshot,
            config: getRoundConfig(),
          },
        });
      }
    }

    await Promise.all(
      tableConnections.map((connection) => pushTableUserSnapshot(connection, event.tableId)),
    );
    return;
  }

  const matchingConnections = Array.from(connections.values()).filter((connection) => connection.userId === event.userId);
  await Promise.all(
    matchingConnections.map(async (connection) => {
      await pushUserSnapshot(connection);
      if (connection.subscription.scope === "table") {
        await pushTableUserSnapshot(connection, connection.subscription.tableId);
      }
    }),
  );
}

const WS_AUTH_PROTOCOL = "bearer";

function rejectUpgrade(socket: Duplex, statusCode: number, message: string) {
  if (socket.destroyed) {
    return;
  }

  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

function isLoopbackAddress(address: string) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function getClientIp(request: IncomingMessage) {
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  const forwarded = request.headers["x-forwarded-for"];

  if (!isLoopbackAddress(remoteAddress) || !forwarded) {
    return remoteAddress;
  }

  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value.split(",", 1)[0]?.trim() || remoteAddress;
}

// The client sends its JWT via Sec-WebSocket-Protocol ("bearer, <token>")
// instead of the query string, so tokens never appear in access logs.
function extractTokenFromProtocolHeader(header: string | string[] | undefined) {
  if (!header) {
    return null;
  }

  const protocols = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return protocols.find((value) => value !== WS_AUTH_PROTOCOL) ?? null;
}

export async function attachLiveWebSocketServer(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    handleProtocols: (protocols) => (protocols.has(WS_AUTH_PROTOCOL) ? WS_AUTH_PROTOCOL : false),
  });
  wss.on("error", (error) => {
    console.error("Live WebSocket server error", error);
  });
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  if (!stopSubscriber) {
    stopSubscriber = await startLiveEventSubscriber(handleLiveEvent);
  }

  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    pruneRateWindows(upgradeWindows, now, WEBSOCKET_UPGRADE_WINDOW_MS);

    for (const connection of connections.values()) {
      const ws = connection.socket;
      if (now - connection.lastPongAt > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
        connections.delete(connection.id);
        ws.terminate();
        continue;
      }
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (!["/ws", "/api/ws"].includes(requestUrl.pathname)) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const clientIp = getClientIp(request);
    const upgradeWindow = upgradeWindows.get(clientIp) ?? { timestamps: [] };
    upgradeWindows.set(clientIp, upgradeWindow);
    if (
      !consumeRateLimit(
        upgradeWindow,
        Date.now(),
        MAX_WEBSOCKET_UPGRADES_PER_IP,
        WEBSOCKET_UPGRADE_WINDOW_MS,
      )
    ) {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }

    const connectionsForIp = Array.from(connections.values()).filter(
      (connection) => connection.clientIp === clientIp,
    ).length;
    if (isConnectionLimitExceeded({ total: connections.size, forIp: connectionsForIp })) {
      rejectUpgrade(socket, 503, "WebSocket Capacity Reached");
      return;
    }

    const token = extractTokenFromProtocolHeader(request.headers["sec-websocket-protocol"]);
    if (!token) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const payload = verifyToken(token);
    const [user, sessionActive] = await Promise.all([
      findUserById(payload.userId),
      isAuthSessionActive(payload.sessionId),
    ]);

    if (!user || !user.isActive || !sessionActive) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const connectionsForUser = Array.from(connections.values()).filter(
      (connection) => connection.userId === payload.userId,
    ).length;
    if (
      isConnectionLimitExceeded({
        total: connections.size,
        forIp: connectionsForIp,
        forUser: connectionsForUser,
      })
    ) {
      rejectUpgrade(socket, 429, "Connection Limit Reached");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: LiveSocketConnection = {
        id: randomUUID(),
        userId: payload.userId,
        clientIp,
        sessionId: payload.sessionId,
        socket: ws,
        lastPongAt: Date.now(),
        messageWindow: { timestamps: [] },
        subscription: { scope: "none" },
      };

      connections.set(connection.id, connection);
      sendMessage(ws, {
        type: "connected",
        serverTime: new Date().toISOString(),
      });

      ws.on("pong", () => {
        connection.lastPongAt = Date.now();
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          ws.close(1003, "Text messages only");
          return;
        }

        const payloadBytes = Array.isArray(raw)
          ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
          : raw.byteLength;
        if (!isWebSocketPayloadAllowed(payloadBytes)) {
          ws.close(1009, "Message too large");
          return;
        }

        if (
          !consumeRateLimit(
            connection.messageWindow,
            Date.now(),
            MAX_WEBSOCKET_MESSAGES_PER_WINDOW,
            WEBSOCKET_MESSAGE_WINDOW_MS,
          )
        ) {
          sendMessage(ws, { type: "error", message: "Message rate limit exceeded" });
          ws.close(1008, "Message rate limit exceeded");
          return;
        }

        const message = parseWebSocketClientMessage(raw.toString());
        if (!message) {
          sendMessage(ws, {
            type: "error",
            message: "Invalid live message",
          });
          return;
        }

        void handleSubscriptionMessage(connection, message).catch((error: unknown) => {
          console.error("Live WebSocket message handler failed", error);
          sendMessage(ws, { type: "error", message: "Live update failed" });
          ws.close(1011, "Live update failed");
        });
      });

      ws.on("close", () => {
        connections.delete(connection.id);
      });

      ws.on("error", (error) => {
        console.error("Live WebSocket connection error", error);
        connections.delete(connection.id);
      });
    });
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      console.error("Live WebSocket upgrade failed", error);
      rejectUpgrade(socket, 401, "Unauthorized");
    });
  };
  server.on("upgrade", onUpgrade);

  return async () => {
    server.off("upgrade", onUpgrade);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    for (const connection of connections.values()) {
      connection.socket.close();
    }
    connections.clear();
    upgradeWindows.clear();
    await stopSubscriber?.();
    stopSubscriber = null;
    wss.close();
  };
}
