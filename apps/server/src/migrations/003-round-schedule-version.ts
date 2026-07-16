import type { MigrationDefinition } from "./types.js";

export const roundScheduleVersionMigration: MigrationDefinition = {
  version: 3,
  name: "round_schedule_version",
  up: `
    ALTER TABLE game_tables
      ADD COLUMN IF NOT EXISTS round_schedule_version INTEGER NOT NULL DEFAULT 0;
  `,
};
