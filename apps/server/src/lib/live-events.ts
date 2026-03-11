import type { Notification, PoolClient } from "pg";
import { pool } from "./db.js";

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
    };

export async function publishLiveEvent(event: LiveEvent, executor: PoolClient | typeof pool = pool) {
  await executor.query("SELECT pg_notify($1, $2)", [LIVE_EVENT_CHANNEL, JSON.stringify(event)]);
}

export async function startLiveEventSubscriber(onEvent: (event: LiveEvent) => Promise<void> | void) {
  const client = await pool.connect();

  await client.query(`LISTEN ${LIVE_EVENT_CHANNEL}`);
  client.on("notification", (message: Notification) => {
    if (!message.payload) {
      return;
    }

    try {
      const event = JSON.parse(message.payload) as LiveEvent;
      void onEvent(event);
    } catch (error) {
      console.error("Failed to parse live event payload", error);
    }
  });

  client.on("error", (error: Error) => {
    console.error("Live event subscriber error", error);
  });

  return async () => {
    client.removeAllListeners("notification");
    client.removeAllListeners("error");
    await client.query(`UNLISTEN ${LIVE_EVENT_CHANNEL}`);
    client.release();
  };
}
