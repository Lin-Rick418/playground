import type { MigrationDefinition } from "./types.js";

export const roundPhaseOffsetMigration: MigrationDefinition = {
  version: 2,
  name: "round_phase_offset",
  up: `
    ALTER TABLE game_tables
      ADD COLUMN IF NOT EXISTS round_phase_offset_ms INTEGER NOT NULL DEFAULT 0;
  `,
};
