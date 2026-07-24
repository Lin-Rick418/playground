import type { MigrationDefinition } from "./types.js";

export const activeGameTablesMigration: MigrationDefinition = {
  version: 9,
  name: "active_game_tables",
  up: `
    ALTER TABLE game_tables
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  `,
};
