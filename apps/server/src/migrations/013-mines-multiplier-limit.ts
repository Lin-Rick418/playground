import type { MigrationDefinition } from "./types.js";

export const minesMultiplierLimitMigration: MigrationDefinition = {
  version: 13,
  name: "mines_multiplier_limit",
  up: `
    ALTER TABLE mines_rounds DROP CONSTRAINT mines_rounds_rule_version_check;
    ALTER TABLE mines_rounds ADD CONSTRAINT mines_rounds_rule_version_check CHECK (rule_version IN (1, 2));
    ALTER TABLE mines_rounds ADD COLUMN settlement_reason TEXT;
    ALTER TABLE mines_rounds ADD CONSTRAINT mines_rounds_settlement_reason CHECK (
      settlement_reason IS NULL OR
      (rule_version = 2 AND (
        (settlement_reason = 'MULTIPLIER_LIMIT' AND status = 'LOST' AND payout = 0) OR
        (settlement_reason = 'ACCOUNT_LIMIT' AND status = 'CASHED_OUT')
      ))
    );
    ALTER TABLE mines_rounds ADD CONSTRAINT mines_rounds_v2_payout_limit CHECK (
      rule_version = 1 OR (payout <= amount * 1000 AND maximum_payout BETWEEN amount AND amount * 1000)
    );
  `,
};
