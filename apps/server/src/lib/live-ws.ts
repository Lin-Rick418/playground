import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  liveClientMessageSchema,
  liveServerMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
} from "@baccarat/contracts";
import { verifyToken } from "./auth.js";
import { contractIssues } from "./contracts.js";
import {
  validatePlayerWebSocketSession,
  type AuthorizationRevocationReason,
} from "./authorization-state.js";
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
import { logger, toLogError } from "./logger.js";
import {
  MAX_WEBSOCKET_MESSAGES_PER_WINDOW,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  MAX_WEBSOCKET_UPGRADES_PER_IP,
  WEBSOCKET_MESSAGE_WINDOW_MS,
  WEBSOCKET_UPGRADE_WINDOW_MS,
  consumeRateLimit,
  isConnectionLimitExceeded,
  isWebSocketPayloadAllowed,
  pruneRateWindows,
  type RateWindow,
} from "./live-ws-policy.js";
import { getRoundConfig } from "./round-manager.js";
import type { UserRole } from "../types/domain.js";

type LiveSocketConnection = {
  id: string;
  userId: string;
  clientIp: string;
  sessionId: string;
  role: UserRole;
  socket: WebSocket;
  lastPongAt: number;
  messageWindow: RateWindow;
  subscription: { scope: "none" } | { scope: "lobby" } | { scope: "table"; tableId: string };
};

const connections = new Map<string, LiveSocketConnection>();
const upgradeWindows = new Map<string, RateWindow>();
let stopSubscriber: null | (() => Promise<void>) = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const WS_UNAUTHORIZED_CLOSE_CODE = 4401;
const WS_FORBIDDEN_CLOSE_CODE = 4403;
const wsLogger = logger.child({ component: "live-ws" });

function sendMessage(socket: WebSocket, message: LiveServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const parsed = liveServerMessageSchema.safeParse(message);

  if (!parsed.success) {
    wsLogger.error({
      event: "websocket_response_contract_failed",
      type: message.type,
      issues: contractIssues(parsed.error),
    }, "WebSocket response contract validation failed");
  }

  const payload = parsed.success
    ? parsed.data
    : { type: "error" as const, message: "Live data unavailable" };

  try {
    socket.send(JSON.stringify(payload), (error) => {
      if (error) {
        wsLogger.error({
          event: "websocket_send_failed",
          err: toLogError(error),
        }, "Live WebSocket send failed");
        socket.terminate();
      }
    });
  } catch (error) {
    wsLogger.error({
      event: "websocket_send_failed",
      err: toLogError(error),
    }, "Live WebSocket send failed");
    socket.terminate();
  }
}

function revokeLiveConnection(
  connection: LiveSocketConnection,
  reason: AuthorizationRevocationReason,
) {
  connections.delete(connection.id);
  sendMessage(connection.socket, { type: "auth_revoked", reason });
  connection.socket.close(
    reason === "user_deleted" ? WS_UNAUTHORIZED_CLOSE_CODE : WS_FORBIDDEN_CLOSE_CODE,
    reason,
  );
}

async function revalidateLiveConnection(connection: LiveSocketConnection) {
  const decision = validatePlayerWebSocketSession(
    connection.role,
    await buildUserLiveState(connection.userId),
  );

  if (!decision.authorized) {
    revokeLiveConnection(connection, decision.reason);
    return null;
  }

  if (decision.user.role !== "PLAYER") {
    revokeLiveConnection(connection, "role_changed");
    return null;
  }

  return { ...decision.user, role: "PLAYER" as const };
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
  const user = await revalidateLiveConnection(connection);

  if (!user) {
    return false;
  }

  sendMessage(connection.socket, {
    type: "user_snapshot",
    data: user,
  });
  return true;
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

async function handleSubscriptionMessage(connection: LiveSocketConnection, message: LiveClientMessage) {
  if (!(await pushUserSnapshot(connection))) {
    return;
  }

  if (message.type === "subscribe_lobby") {
    connection.subscription = { scope: "lobby" };
    await pushLobbySnapshot(connection);
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
  await Promise.all([pushTableSnapshot(connection, table.id), pushTableUserSnapshot(connection, table.id)]);
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

    const tableUserStates = new Map<
      string,
      Awaited<ReturnType<typeof buildTableUserState>>
    >();
    await Promise.all(
      Array.from(new Set(tableConnections.map((connection) => connection.userId)), async (userId) => {
        tableUserStates.set(userId, await buildTableUserState(userId, event.tableId));
      }),
    );
    for (const connection of tableConnections) {
      const state = tableUserStates.get(connection.userId);
      if (state) {
        sendMessage(connection.socket, { type: "table_user_snapshot", data: state });
      }
    }
    return;
  }

  const matchingConnections = Array.from(connections.values()).filter((connection) => connection.userId === event.userId);
  const tableIds = Array.from(
    new Set(
      matchingConnections.flatMap((connection) =>
        connection.subscription.scope === "table" ? [connection.subscription.tableId] : [],
      ),
    ),
  );
  const [user, tableStates] = await Promise.all([
    buildUserLiveState(event.userId),
    Promise.all(tableIds.map(async (tableId) => [tableId, await buildTableUserState(event.userId, tableId)] as const)),
  ]);
  const tableStateById = new Map(tableStates);

  for (const connection of matchingConnections) {
    const decision = validatePlayerWebSocketSession(connection.role, user);
    if (!decision.authorized) {
      revokeLiveConnection(connection, decision.reason);
      continue;
    }

    if (decision.user.role !== "PLAYER") {
      revokeLiveConnection(connection, "role_changed");
      continue;
    }

    sendMessage(connection.socket, {
      type: "user_snapshot",
      data: { ...decision.user, role: "PLAYER" as const },
    });
    if (connection.subscription.scope === "table") {
      const state = tableStateById.get(connection.subscription.tableId);
      if (state) {
        sendMessage(connection.socket, { type: "table_user_snapshot", data: state });
      }
    }
  }
}

function parseClientMessage(data: string, connection: LiveSocketConnection): LiveClientMessage | null {
  try {
    const parsed = liveClientMessageSchema.safeParse(JSON.parse(data));

    if (!parsed.success) {
      wsLogger.warn({
        event: "websocket_request_contract_failed",
        connectionId: connection.id,
        userId: connection.userId,
        issues: contractIssues(parsed.error),
      }, "WebSocket request contract validation failed");
      return null;
    }

    return parsed.data;
  } catch {
    wsLogger.warn({
      event: "websocket_request_contract_failed",
      connectionId: connection.id,
      userId: connection.userId,
      issues: [{ code: "invalid_json", path: "" }],
    }, "WebSocket request contract validation failed");
    return null;
  }
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
    wsLogger.error({
      event: "websocket_server_error",
      err: toLogError(error),
    }, "Live WebSocket server error");
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
      void revalidateLiveConnection(connection).catch((error) => {
        wsLogger.error({
          event: "websocket_authorization_revalidation_failed",
          connectionId: connection.id,
          userId: connection.userId,
          err: toLogError(error),
        }, "Live WebSocket authorization revalidation failed");
      });
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
      wsLogger.warn({
        event: "websocket_upgrade_rejected",
        reason: "ip_rate_limit",
        clientIp,
        statusCode: 429,
      }, "WebSocket upgrade rejected");
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }

    const connectionsForIp = Array.from(connections.values()).filter(
      (connection) => connection.clientIp === clientIp,
    ).length;
    if (isConnectionLimitExceeded({ total: connections.size, forIp: connectionsForIp })) {
      wsLogger.warn({
        event: "websocket_upgrade_rejected",
        reason: "capacity",
        clientIp,
        statusCode: 503,
      }, "WebSocket upgrade rejected");
      rejectUpgrade(socket, 503, "WebSocket Capacity Reached");
      return;
    }

    const token = extractTokenFromProtocolHeader(request.headers["sec-websocket-protocol"]);
    if (!token) {
      wsLogger.warn({
        event: "websocket_upgrade_rejected",
        reason: "missing_token",
        clientIp,
        statusCode: 401,
      }, "WebSocket upgrade rejected");
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const payload = verifyToken(token);
    const [user, sessionActive] = await Promise.all([
      findUserById(payload.userId),
      isAuthSessionActive(payload.sessionId),
    ]);

    if (!user || !user.isActive || user.role !== "PLAYER" || !sessionActive) {
      wsLogger.warn({
        event: "websocket_upgrade_rejected",
        reason: "invalid_session",
        clientIp,
        userId: payload.userId,
        statusCode: 401,
      }, "WebSocket upgrade rejected");
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
      wsLogger.warn({
        event: "websocket_upgrade_rejected",
        reason: "connection_limit",
        clientIp,
        userId: payload.userId,
        statusCode: 429,
      }, "WebSocket upgrade rejected");
      rejectUpgrade(socket, 429, "Connection Limit Reached");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: LiveSocketConnection = {
        id: randomUUID(),
        userId: payload.userId,
        clientIp,
        sessionId: payload.sessionId,
        role: user.role,
        socket: ws,
        lastPongAt: Date.now(),
        messageWindow: { timestamps: [] },
        subscription: { scope: "none" },
      };

      connections.set(connection.id, connection);
      wsLogger.info({
        event: "websocket_connected",
        connectionId: connection.id,
        userId: connection.userId,
      }, "Live WebSocket connected");
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

        const message = parseClientMessage(raw.toString(), connection);
        if (!message) {
          sendMessage(ws, {
            type: "error",
            message: "Invalid live message",
          });
          return;
        }

        void handleSubscriptionMessage(connection, message).catch((error: unknown) => {
          wsLogger.error({
            event: "websocket_message_handler_failed",
            connectionId: connection.id,
            userId: connection.userId,
            err: toLogError(error),
          }, "Live WebSocket message handler failed");
          sendMessage(ws, { type: "error", message: "Live update failed" });
          ws.close(1011, "Live update failed");
        });
      });

      ws.on("close", () => {
        connections.delete(connection.id);
        wsLogger.info({
          event: "websocket_disconnected",
          connectionId: connection.id,
          userId: connection.userId,
        }, "Live WebSocket disconnected");
      });

      ws.on("error", (error) => {
        wsLogger.error({
          event: "websocket_connection_error",
          connectionId: connection.id,
          userId: connection.userId,
          err: toLogError(error),
        }, "Live WebSocket connection error");
        connections.delete(connection.id);
      });
    });
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      wsLogger.error({
        event: "websocket_upgrade_failed",
        err: toLogError(error),
      }, "Live WebSocket upgrade failed");
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
      connection.socket.close(1001, "Server shutting down");
    }
    upgradeWindows.clear();
    await stopSubscriber?.();
    stopSubscriber = null;
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    connections.clear();
  };
}
