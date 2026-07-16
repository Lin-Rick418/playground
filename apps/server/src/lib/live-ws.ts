import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";
import {
  buildLobbyTables,
  buildTablePublicState,
  buildTableUserState,
  buildUserLiveState,
  findTableById,
  findUserById,
} from "./db.js";
import { startLiveEventSubscriber, type LiveEvent } from "./live-events.js";
import { getRoundConfig } from "./round-manager.js";

type LiveSocketConnection = {
  id: string;
  userId: string;
  socket: WebSocket;
  subscription: { scope: "none" } | { scope: "lobby" } | { scope: "table"; tableId: string };
};

type ClientMessage = { type: "subscribe_lobby" } | { type: "subscribe_table"; tableId: string };

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
let stopSubscriber: null | (() => Promise<void>) = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

function sendMessage(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
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

async function handleSubscriptionMessage(connection: LiveSocketConnection, message: ClientMessage) {
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
    if (!user) {
      sendMessage(connection.socket, { type: "error", message: "User not found" });
      connection.socket.close();
      continue;
    }

    sendMessage(connection.socket, { type: "user_snapshot", data: user });
    if (connection.subscription.scope === "table") {
      const state = tableStateById.get(connection.subscription.tableId);
      if (state) {
        sendMessage(connection.socket, { type: "table_user_snapshot", data: state });
      }
    }
  }
}

function parseClientMessage(data: string): ClientMessage | null {
  try {
    const message = JSON.parse(data) as ClientMessage;
    if (message.type === "subscribe_lobby") {
      return message;
    }

    if (message.type === "subscribe_table" && typeof message.tableId === "string") {
      return message;
    }

    return null;
  } catch {
    return null;
  }
}

const WS_AUTH_PROTOCOL = "bearer";

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
    handleProtocols: (protocols) => (protocols.has(WS_AUTH_PROTOCOL) ? WS_AUTH_PROTOCOL : false),
  });
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  if (!stopSubscriber) {
    stopSubscriber = await startLiveEventSubscriber(handleLiveEvent);
  }

  heartbeatInterval = setInterval(() => {
    for (const connection of connections.values()) {
      const ws = connection.socket;
      if ((ws as WebSocket & { isAlive?: boolean }).isAlive === false) {
        connections.delete(connection.id);
        ws.terminate();
        continue;
      }
      (ws as WebSocket & { isAlive?: boolean }).isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  server.on("upgrade", async (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (!["/ws", "/api/ws"].includes(requestUrl.pathname)) {
      socket.destroy();
      return;
    }

    const token = extractTokenFromProtocolHeader(request.headers["sec-websocket-protocol"]);
    if (!token) {
      socket.destroy();
      return;
    }

    try {
      const payload = verifyToken(token);
      const user = await findUserById(payload.userId);

      if (!user || !user.isActive) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const connection: LiveSocketConnection = {
          id: randomUUID(),
          userId: payload.userId,
          socket: ws,
          subscription: { scope: "none" },
        };

        connections.set(connection.id, connection);
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
        sendMessage(ws, {
          type: "connected",
          serverTime: new Date().toISOString(),
        });

        ws.on("pong", () => {
          (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
        });

        ws.on("message", async (raw) => {
          const message = parseClientMessage(raw.toString());
          if (!message) {
            sendMessage(ws, {
              type: "error",
              message: "Invalid live message",
            });
            return;
          }

          await handleSubscriptionMessage(connection, message);
        });

        ws.on("close", () => {
          connections.delete(connection.id);
        });

        ws.on("error", () => {
          connections.delete(connection.id);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  return async () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    for (const connection of connections.values()) {
      connection.socket.close();
    }
    connections.clear();
    await stopSubscriber?.();
    stopSubscriber = null;
    wss.close();
  };
}
