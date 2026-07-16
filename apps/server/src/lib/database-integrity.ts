type IntegrityConstraint = {
  table: "game_tables" | "users" | "game_rounds" | "bets" | "balance_adjustments";
  name: string;
  definition: string;
};

export const coreIntegrityConstraints = [
  { table: "game_tables", name: "game_tables_id_not_blank_ck", definition: "CHECK (btrim(id) <> '')" },
  { table: "game_tables", name: "game_tables_code_not_blank_ck", definition: "CHECK (btrim(code) <> '')" },
  { table: "game_tables", name: "game_tables_name_not_blank_ck", definition: "CHECK (btrim(name) <> '')" },
  {
    table: "game_tables",
    name: "game_tables_schedule_values_ck",
    definition:
      "CHECK (display_order >= 0 AND round_duration_ms > 0 AND round_phase_offset_ms >= 0 AND round_phase_offset_ms < round_duration_ms AND round_schedule_version >= 0)",
  },
  {
    table: "game_tables",
    name: "game_tables_bet_limits_ck",
    definition: "CHECK (min_bet > 0 AND max_bet >= min_bet)",
  },
  {
    table: "game_tables",
    name: "game_tables_shoe_state_object_ck",
    definition: "CHECK (jsonb_typeof(shoe_state) = 'object')",
  },
  { table: "users", name: "users_id_not_blank_ck", definition: "CHECK (btrim(id) <> '')" },
  {
    table: "users",
    name: "users_username_format_ck",
    definition: "CHECK (username ~ '^[A-Za-z0-9_]{3,24}$')",
  },
  { table: "users", name: "users_password_hash_not_blank_ck", definition: "CHECK (btrim(password_hash) <> '')" },
  { table: "users", name: "users_role_ck", definition: "CHECK (role IN ('ADMIN', 'PLAYER'))" },
  { table: "users", name: "users_balance_nonnegative_ck", definition: "CHECK (balance >= 0)" },
  { table: "users", name: "users_timestamps_ck", definition: "CHECK (updated_at >= created_at)" },
  { table: "game_rounds", name: "game_rounds_id_not_blank_ck", definition: "CHECK (btrim(id) <> '')" },
  {
    table: "game_rounds",
    name: "game_rounds_table_fk",
    definition: "FOREIGN KEY (table_id) REFERENCES game_tables(id) ON DELETE RESTRICT",
  },
  {
    table: "game_rounds",
    name: "game_rounds_cards_array_ck",
    definition: "CHECK (jsonb_typeof(player_cards) = 'array' AND jsonb_typeof(banker_cards) = 'array')",
  },
  {
    table: "game_rounds",
    name: "game_rounds_totals_ck",
    definition: "CHECK (player_total BETWEEN 0 AND 9 AND banker_total BETWEEN 0 AND 9)",
  },
  {
    table: "game_rounds",
    name: "game_rounds_winner_ck",
    definition: "CHECK (winner IN ('PLAYER', 'BANKER', 'TIE'))",
  },
  {
    table: "game_rounds",
    name: "game_rounds_status_ck",
    definition: "CHECK (status IN ('OPEN', 'LOCKED', 'SETTLED', 'CANCELLED'))",
  },
  {
    table: "game_rounds",
    name: "game_rounds_time_window_ck",
    definition: "CHECK (betting_opens_at < betting_closes_at)",
  },
  {
    table: "game_rounds",
    name: "game_rounds_settlement_ck",
    definition:
      "CHECK (((status IN ('SETTLED', 'CANCELLED')) = (settled_at IS NOT NULL)) AND (settled_at IS NULL OR (settled_at >= created_at)))",
  },
  { table: "bets", name: "bets_id_not_blank_ck", definition: "CHECK (btrim(id) <> '')" },
  {
    table: "bets",
    name: "bets_user_fk",
    definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT",
  },
  {
    table: "bets",
    name: "bets_round_fk",
    definition: "FOREIGN KEY (round_id) REFERENCES game_rounds(id) ON DELETE RESTRICT",
  },
  {
    table: "bets",
    name: "bets_type_ck",
    definition: "CHECK (bet_type IN ('PLAYER', 'BANKER', 'TIE', 'PLAYER_PAIR', 'BANKER_PAIR'))",
  },
  {
    table: "bets",
    name: "bets_amounts_ck",
    definition: "CHECK (amount > 0 AND payout >= 0 AND payout::bigint <= amount::bigint * 12)",
  },
  {
    table: "balance_adjustments",
    name: "balance_adjustments_id_not_blank_ck",
    definition: "CHECK (btrim(id) <> '')",
  },
  {
    table: "balance_adjustments",
    name: "balance_adjustments_admin_fk",
    definition: "FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE RESTRICT",
  },
  {
    table: "balance_adjustments",
    name: "balance_adjustments_user_fk",
    definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT",
  },
  {
    table: "balance_adjustments",
    name: "balance_adjustments_amount_nonzero_ck",
    definition: "CHECK (amount <> 0)",
  },
  {
    table: "balance_adjustments",
    name: "balance_adjustments_note_length_ck",
    definition: "CHECK (note IS NULL OR length(note) <= 200)",
  },
] as const satisfies readonly IntegrityConstraint[];

function addConstraintSql(constraint: IntegrityConstraint) {
  return `
    DO $integrity$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = '${constraint.table}'::regclass
          AND conname = '${constraint.name}'
      ) THEN
        ALTER TABLE ${constraint.table}
          ADD CONSTRAINT ${constraint.name} ${constraint.definition} NOT VALID;
      END IF;
    END
    $integrity$;
  `;
}

function validateConstraintSql(constraint: IntegrityConstraint) {
  return `ALTER TABLE ${constraint.table} VALIDATE CONSTRAINT ${constraint.name};`;
}

// A single node-postgres simple-query message is one implicit transaction.
// If any existing row fails validation, PostgreSQL rolls back the complete
// constraint/index batch and service startup fails with the offending name.
export const coreDatabaseIntegritySql = `
  ${coreIntegrityConstraints.map(addConstraintSql).join("\n")}
  ${coreIntegrityConstraints.map(validateConstraintSql).join("\n")}

  CREATE UNIQUE INDEX IF NOT EXISTS uq_game_tables_display_order
    ON game_tables (display_order);
  CREATE INDEX IF NOT EXISTS idx_balance_adjustments_admin_id
    ON balance_adjustments (admin_id);
  CREATE INDEX IF NOT EXISTS idx_balance_adjustments_user_id
    ON balance_adjustments (user_id);
`;
