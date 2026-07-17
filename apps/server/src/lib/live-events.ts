import type { Notification, PoolClient } from "pg";
import { pool } from "./db.js";
import { dispatchSafely } from "./async-handler.js";
import { logger, toLogError } from "./logger.js";

const LIVE_EVENT_CHANNEL = "baccarat_live";

export type LiveEvent =
  | {
      type: "table_changed";
      tableId: string;
      reason: string;
      at: string;
    }
  | {
      type: "user_changed";
      userId: string;
      reason: string;
      at: string;
    }
  | {
      type: "session_revoked";
      sessionId: string;
      userId: string;
      reason: string;
      at: string;
    };

export async function publishLiveEvent(event: LiveEvent, executor: PoolClient | typeof pool = pool) {
  await executor.query("SELECT pg_notify($1, $2)", [LIVE_EVENT_CHANNEL, JSON.stringify(event)]);
}

export async function startLiveEventSubscriber(onEvent: (event: LiveEvent) => Promise<void> | void) {
  let stopped = false;
  let activeClient: PoolClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;

  async function connect() {
    if (stopped) return;

    try {
      const client = await pool.connect();
      activeClient = client;
      reconnectAttempts = 0;

      await client.query(`LISTEN ${LIVE_EVENT_CHANNEL}`);
      client.on("notification", (message: Notification) => {
        if (!message.payload) {
          return;
        }

        try {
          const event = JSON.parse(message.payload) as LiveEvent;
          void dispatchSafely(onEvent, event, (error) => {
            logger.error({
              event: "live_event_handler_failed",
              liveEventType: event.type,
              err: toLogError(error),
            }, "Live event handler failed");
          });
        } catch (error) {
          logger.error({
            event: "live_event_payload_invalid",
            err: toLogError(error),
          }, "Failed to parse live event payload");
        }
      });

      client.on("error", (error: Error) => {
        logger.error({
          event: "live_event_subscriber_connection_lost",
          err: toLogError(error),
        }, "Live event subscriber connection lost");
        cleanupClient(client);
        scheduleReconnect();
      });
    } catch (error) {
      logger.error({
        event: "live_event_subscriber_connect_failed",
        err: toLogError(error),
      }, "Live event subscriber failed to connect");
      scheduleReconnect();
    }
  }

  function cleanupClient(client: PoolClient) {
    client.removeAllListeners("notification");
    client.removeAllListeners("error");
    try { client.release(true); } catch { /* already released */ }
    if (activeClient === client) activeClient = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delayMs = Math.min(1000 * 2 ** reconnectAttempts, 30000);
    reconnectAttempts++;
    logger.info({
      event: "live_event_subscriber_reconnecting",
      delayMs,
      attempt: reconnectAttempts,
    }, "Live event subscriber reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  }

  await connect();

  return async () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (activeClient) {
      activeClient.removeAllListeners("notification");
      activeClient.removeAllListeners("error");
      try {
        await activeClient.query(`UNLISTEN ${LIVE_EVENT_CHANNEL}`);
      } catch { /* connection may already be dead */ }
      activeClient.release(true);
      activeClient = null;
    }
  };
}
