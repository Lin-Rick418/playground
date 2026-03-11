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

    let lobbySnapshot: Awaited<ReturnType<typeof buildLobbyTables>> | null = null;
    if (lobbyConnections.length > 0) {
      lobbySnapshot = await buildLobbyTables();
    }

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

    const tableSnapshot = tableConnections.length > 0 ? await buildTablePublicState(event.tableId) : null;
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

      await pushTableUserSnapshot(connection, event.tableId);
    }
    return;
  }

  const matchingConnections = Array.from(connections.values()).filter((connection) => connection.userId === event.userId);
  for (const connection of matchingConnections) {
    await pushUserSnapshot(connection);
    if (connection.subscription.scope === "table") {
      await pushTableUserSnapshot(connection, connection.subscription.tableId);
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

export async function attachLiveWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  if (!stopSubscriber) {
    stopSubscriber = await startLiveEventSubscriber(handleLiveEvent);
  }

  server.on("upgrade", async (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (!["/ws", "/api/ws"].includes(requestUrl.pathname)) {
      socket.destroy();
      return;
    }

    const token = requestUrl.searchParams.get("token");
    if (!token) {
      socket.destroy();
      return;
    }

    try {
      const payload = verifyToken(token);

      wss.handleUpgrade(request, socket, head, (ws) => {
        const connection: LiveSocketConnection = {
          id: randomUUID(),
          userId: payload.userId,
          socket: ws,
          subscription: { scope: "none" },
        };

        connections.set(connection.id, connection);
        sendMessage(ws, {
          type: "connected",
          serverTime: new Date().toISOString(),
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
    for (const connection of connections.values()) {
      connection.socket.close();
    }
    connections.clear();
    await stopSubscriber?.();
    stopSubscriber = null;
    wss.close();
  };
}
