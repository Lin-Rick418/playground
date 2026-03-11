import { randomUUID } from "node:crypto";
import type { Response } from "express";

type LiveUpdateEvent = {
  type: "connected" | "lobby_updated" | "table_updated" | "user_updated";
  reason?: string;
  tableId?: string;
  userId?: string;
  at: string;
};

type LiveConnection = {
  id: string;
  userId: string;
  scope: "lobby" | "table";
  tableId?: string;
  res: Response;
};

const liveState = globalThis as typeof globalThis & {
  __baccaratLiveConnections?: Map<string, LiveConnection>;
  __baccaratLiveHeartbeat?: NodeJS.Timeout;
};

function getConnections() {
  if (!liveState.__baccaratLiveConnections) {
    liveState.__baccaratLiveConnections = new Map<string, LiveConnection>();
  }

  return liveState.__baccaratLiveConnections;
}

function startHeartbeat() {
  if (liveState.__baccaratLiveHeartbeat) {
    return;
  }

  liveState.__baccaratLiveHeartbeat = setInterval(() => {
    for (const connection of getConnections().values()) {
      connection.res.write(": keep-alive\n\n");
    }
  }, 15000);
}

function stopHeartbeatIfIdle() {
  if (getConnections().size === 0 && liveState.__baccaratLiveHeartbeat) {
    clearInterval(liveState.__baccaratLiveHeartbeat);
    liveState.__baccaratLiveHeartbeat = undefined;
  }
}

function sendEvent(connection: LiveConnection, event: LiveUpdateEvent) {
  connection.res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function registerConnection(connection: LiveConnection) {
  const connections = getConnections();
  connections.set(connection.id, connection);
  startHeartbeat();

  sendEvent(connection, {
    type: "connected",
    at: new Date().toISOString(),
  });

  const cleanup = () => {
    connections.delete(connection.id);
    stopHeartbeatIfIdle();
  };

  connection.res.on("close", cleanup);
  connection.res.on("error", cleanup);
}

function initSseResponse(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

export function openLobbyStream(userId: string, res: Response) {
  initSseResponse(res);
  registerConnection({
    id: randomUUID(),
    userId,
    scope: "lobby",
    res,
  });
}

export function openTableStream(userId: string, tableId: string, res: Response) {
  initSseResponse(res);
  registerConnection({
    id: randomUUID(),
    userId,
    scope: "table",
    tableId,
    res,
  });
}

export function publishLobbyUpdate(reason: string, tableId?: string) {
  const event: LiveUpdateEvent = {
    type: "lobby_updated",
    reason,
    tableId,
    at: new Date().toISOString(),
  };

  for (const connection of getConnections().values()) {
    if (connection.scope === "lobby") {
      sendEvent(connection, event);
    }
  }
}

export function publishTableUpdate(tableId: string, reason: string) {
  const event: LiveUpdateEvent = {
    type: "table_updated",
    reason,
    tableId,
    at: new Date().toISOString(),
  };

  for (const connection of getConnections().values()) {
    if (connection.scope === "table" && connection.tableId === tableId) {
      sendEvent(connection, event);
    }
  }

  publishLobbyUpdate(reason, tableId);
}

export function publishUserUpdate(userId: string, reason: string) {
  const event: LiveUpdateEvent = {
    type: "user_updated",
    reason,
    userId,
    at: new Date().toISOString(),
  };

  for (const connection of getConnections().values()) {
    if (connection.userId === userId) {
      sendEvent(connection, event);
    }
  }
}
