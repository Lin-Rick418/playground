import type { MigrationDefinition } from "./types.js";
export const blackjackMigration: MigrationDefinition = {
  version: 14, name: "blackjack", up: `
    CREATE TABLE blackjack_rounds (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount NUMERIC(20,2) NOT NULL CHECK(amount BETWEEN 100 AND 5000 AND amount % 100 = 0),
      total_bet NUMERIC(20,2) NOT NULL, payout NUMERIC(20,2) NOT NULL DEFAULT 0,
      maximum_payout NUMERIC(20,2) NOT NULL,
      state JSONB NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','SETTLED')),
      version INTEGER NOT NULL CHECK(version > 0),
      rule_version INTEGER NOT NULL DEFAULT 1 CHECK(rule_version = 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), settled_at TIMESTAMPTZ,
      CONSTRAINT blackjack_rounds_money CHECK(total_bet BETWEEN amount AND amount * 8.5 AND maximum_payout BETWEEN 0 AND amount * 17.5 AND payout BETWEEN 0 AND maximum_payout),
      CONSTRAINT blackjack_rounds_state CHECK(
        jsonb_typeof(state) = 'object' AND state ?& ARRAY['shoe','position','hands','dealer','phase','insurance'] AND
        jsonb_typeof(state->'shoe')='array' AND jsonb_array_length(state->'shoe')=312 AND
        (state->>'position')::integer BETWEEN 4 AND 312 AND
        jsonb_typeof(state->'hands')='array' AND jsonb_array_length(state->'hands') BETWEEN 1 AND 4 AND
        jsonb_typeof(state->'dealer')='array' AND jsonb_array_length(state->'dealer') BETWEEN 2 AND 22),
      CONSTRAINT blackjack_rounds_lifecycle CHECK(
        (status='ACTIVE' AND state->>'phase' IN ('INSURANCE','PLAYER_TURN') AND settled_at IS NULL AND payout=0) OR
        (status='SETTLED' AND state->>'phase'='SETTLED' AND settled_at IS NOT NULL AND settled_at>=created_at))
    );
    CREATE UNIQUE INDEX idx_blackjack_one_active_per_user ON blackjack_rounds(user_id) WHERE status='ACTIVE';
    CREATE INDEX idx_blackjack_history ON blackjack_rounds(user_id,settled_at DESC,created_at DESC,id DESC);
    CREATE TABLE blackjack_round_actions (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES blackjack_rounds(id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK(sequence>0),
      kind TEXT NOT NULL CHECK(kind IN ('start','hit','stand','double','split','insurance')),
      debit NUMERIC(20,2) NOT NULL CHECK(debit BETWEEN 0 AND 5000), action JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
      CONSTRAINT blackjack_actions_sequence UNIQUE(round_id,sequence)
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
      (source = 'HILO_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'HILO_ROUND') OR
      (source = 'BLACKJACK_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BLACKJACK_ACTION') OR
      (source = 'BLACKJACK_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'BLACKJACK_ROUND')
    );
  `,
};
