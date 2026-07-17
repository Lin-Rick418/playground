import type { MigrationDefinition } from "./types.js";

export const historyCursorIndexMigration: MigrationDefinition = {
  version: 7,
  name: "history_cursor_index",
  up: `
    CREATE INDEX IF NOT EXISTS idx_game_rounds_history_cursor
      ON game_rounds (settled_at DESC, created_at DESC, id DESC)
      WHERE status = 'SETTLED';
  `,
};
