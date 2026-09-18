import type { MigrationDefinition } from "./types.js";
export const hiloMigration: MigrationDefinition = {
  version: 12,
  name: "hilo",
  up: `
    CREATE TABLE hilo_previews (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      id TEXT NOT NULL UNIQUE, card INTEGER NOT NULL CHECK(card BETWEEN 0 AND 51),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
    );
    CREATE TABLE hilo_rounds (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount NUMERIC(20,2) NOT NULL CHECK(amount BETWEEN 100 AND 5000 AND amount % 100 = 0),
      initial_card INTEGER NOT NULL CHECK(initial_card BETWEEN 0 AND 51),
      card INTEGER NOT NULL CHECK(card BETWEEN 0 AND 51),
      numerator NUMERIC(300,0) NOT NULL DEFAULT 94,
      denominator NUMERIC(300,0) NOT NULL DEFAULT 100,
      success_count INTEGER NOT NULL DEFAULT 0 CHECK(success_count BETWEEN 0 AND 116),
      skip_count INTEGER NOT NULL DEFAULT 0 CHECK(skip_count BETWEEN 0 AND 52),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','LOST','CASHED_OUT')),
      payout NUMERIC(20,2) NOT NULL DEFAULT 0,
      maximum_payout NUMERIC(20,2) NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      rule_version INTEGER NOT NULL DEFAULT 1 CHECK(rule_version = 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      settled_at TIMESTAMPTZ,
      CONSTRAINT hilo_rounds_ratio CHECK(numerator > 0 AND denominator > 0 AND numerator <= 10000 * denominator),
      CONSTRAINT hilo_rounds_lifecycle CHECK(
        maximum_payout = amount * 10000 AND payout BETWEEN 0 AND maximum_payout AND
        ((status = 'ACTIVE' AND settled_at IS NULL AND payout = 0) OR
         (status = 'LOST' AND settled_at IS NOT NULL AND settled_at >= created_at AND payout = 0) OR
         (status = 'CASHED_OUT' AND settled_at IS NOT NULL AND settled_at >= created_at AND success_count > 0 AND
          payout = div(amount * 100 * numerator * 2 + denominator, denominator * 2) / 100))
      )
    );
    CREATE UNIQUE INDEX idx_hilo_one_active_per_user ON hilo_rounds(user_id) WHERE status = 'ACTIVE';
    CREATE INDEX idx_hilo_history ON hilo_rounds(user_id, settled_at DESC, created_at DESC, id DESC);
    CREATE TABLE hilo_round_steps (
      round_id TEXT NOT NULL REFERENCES hilo_rounds(id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 169),
      kind TEXT NOT NULL CHECK(kind IN ('guess','skip')),
      from_card INTEGER NOT NULL CHECK(from_card BETWEEN 0 AND 51),
      card INTEGER NOT NULL CHECK(card BETWEEN 0 AND 51),
      choice TEXT CHECK(choice IN ('higher_or_equal','lower_or_equal','higher','lower','same')),
      won BOOLEAN,
      numerator NUMERIC(300,0) NOT NULL CHECK(numerator > 0),
      denominator NUMERIC(300,0) NOT NULL CHECK(denominator > 0),
      PRIMARY KEY(round_id, sequence),
      CONSTRAINT hilo_steps_action CHECK(
        (kind = 'skip' AND choice IS NULL AND won IS NULL) OR
        (kind = 'guess' AND choice IS NOT NULL AND won IS NOT NULL)
      )
    );
    ALTER TABLE financial_ledger_entries DROP CONSTRAINT financial_ledger_source_reference;
    ALTER TABLE financial_ledger_entries ADD CONSTRAINT financial_ledger_source_reference CHECK (
      (source = 'LEGACY_OPENING_BALANCE' AND actor_type = 'SYSTEM' AND reference_type = 'USER') OR
      (source = 'INITIAL_FUNDING' AND actor_type IN ('SYSTEM','ADMIN') AND reference_type = 'USER') OR
      (source = 'ADMIN_ADJUSTMENT' AND actor_type = 'ADMIN' AND reference_type = 'BALANCE_ADJUSTMENT') OR
      (source = 'BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BET') OR
      (source = 'SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'ROUND') OR
      (source = 'MINES_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'MINES_ROUND') OR
      (source = 'MINES_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'MINES_ROUND') OR
      (source = 'PLINKO_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'PLINKO_ROUND') OR
      (source = 'PLINKO_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'PLINKO_ROUND') OR
      (source = 'HILO_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'HILO_ROUND') OR
      (source = 'HILO_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'HILO_ROUND')
    );
  `,
};
