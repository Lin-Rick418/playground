import type { MigrationDefinition } from "./types.js";

export const queryIndexesMigration: MigrationDefinition = {
  version: 4,
  name: "query_indexes",
  up: `
    CREATE INDEX IF NOT EXISTS idx_game_rounds_active
      ON game_rounds (table_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_game_rounds_settled
      ON game_rounds (table_id, status, settled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_game_rounds_shoe_settled
      ON game_rounds (table_id, shoe_id, status, settled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_user_round_created
      ON bets (user_id, round_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_bets_round_created
      ON bets (round_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_balance_adjustments_created
      ON balance_adjustments (created_at DESC);
  `,
};
