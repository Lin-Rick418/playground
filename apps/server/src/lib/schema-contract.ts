import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { coreIntegrityConstraints } from "./database-integrity.js";

type SchemaExecutor = Pick<Pool | PoolClient, "query">;

const columns = {
  game_tables: {
    id: ["text", "NO"], code: ["text", "NO"], name: ["text", "NO"], display_order: ["integer", "NO"],
    round_duration_ms: ["integer", "NO"], round_phase_offset_ms: ["integer", "NO"],
    round_schedule_version: ["integer", "NO"], min_bet: ["integer", "NO"], max_bet: ["integer", "NO"],
    current_shoe_id: ["text", "NO"], shoe_state: ["jsonb", "NO"], created_at: ["timestamp with time zone", "NO"],
  },
  users: {
    id: ["text", "NO"], username: ["text", "NO"], password_hash: ["text", "NO"], role: ["text", "NO"],
    is_active: ["boolean", "NO"], balance: ["integer", "NO"], created_at: ["timestamp with time zone", "NO"],
    updated_at: ["timestamp with time zone", "NO"],
  },
  game_rounds: {
    id: ["text", "NO"], table_id: ["text", "NO"], shoe_id: ["text", "NO"], player_cards: ["jsonb", "NO"],
    banker_cards: ["jsonb", "NO"], player_total: ["integer", "NO"], banker_total: ["integer", "NO"],
    winner: ["text", "NO"], player_pair: ["boolean", "NO"], banker_pair: ["boolean", "NO"], status: ["text", "NO"],
    cancellation_reason: ["text", "YES"], betting_opens_at: ["timestamp with time zone", "NO"],
    betting_closes_at: ["timestamp with time zone", "NO"], settled_at: ["timestamp with time zone", "YES"],
    created_at: ["timestamp with time zone", "NO"],
  },
  bets: {
    id: ["text", "NO"], user_id: ["text", "NO"], round_id: ["text", "NO"], bet_type: ["text", "NO"],
    amount: ["integer", "NO"], payout: ["integer", "NO"], created_at: ["timestamp with time zone", "NO"],
  },
  balance_adjustments: {
    id: ["text", "NO"], admin_id: ["text", "NO"], user_id: ["text", "NO"], amount: ["integer", "NO"],
    note: ["text", "YES"], created_at: ["timestamp with time zone", "NO"],
  },
  login_rate_limits: {
    scope: ["text", "NO"], key_hash: ["text", "NO"], failures: ["integer", "NO"],
    window_started_at: ["timestamp with time zone", "NO"], expires_at: ["timestamp with time zone", "NO"],
    updated_at: ["timestamp with time zone", "NO"],
  },
  idempotency_keys: {
    actor_id: ["text", "NO"], scope: ["text", "NO"], idempotency_key: ["text", "NO"], request_hash: ["text", "NO"],
    status_code: ["integer", "YES"], response_json: ["jsonb", "YES"], created_at: ["timestamp with time zone", "NO"],
    completed_at: ["timestamp with time zone", "YES"],
  },
  financial_ledger_entries: {
    id: ["text", "NO"], entry_sequence: ["bigint", "NO"], user_id: ["text", "NO"], actor_type: ["text", "NO"],
    actor_id: ["text", "YES"], source: ["text", "NO"], reference_type: ["text", "NO"], reference_id: ["text", "NO"],
    delta: ["integer", "NO"], balance_before: ["integer", "NO"], balance_after: ["integer", "NO"],
    metadata: ["jsonb", "NO"], created_at: ["timestamp with time zone", "NO"],
  },
  service_heartbeats: {
    service_name: ["text", "NO"], instance_id: ["text", "NO"], status: ["text", "NO"], detail: ["text", "YES"],
    last_seen_at: ["timestamp with time zone", "NO"], last_healthy_at: ["timestamp with time zone", "YES"],
  },
  auth_sessions: {
    id: ["text", "NO"], user_id: ["text", "NO"], refresh_token_hash: ["text", "NO"],
    expires_at: ["timestamp with time zone", "NO"], revoked_at: ["timestamp with time zone", "YES"],
    created_at: ["timestamp with time zone", "NO"], last_used_at: ["timestamp with time zone", "NO"],
  },
  shoe_commitments: {
    shoe_id: ["text", "NO"], table_id: ["text", "NO"], audit_version: ["integer", "NO"],
    shuffle_algorithm: ["text", "NO"], deal_algorithm: ["text", "NO"], deck_count: ["integer", "NO"],
    commitment: ["text", "NO"], cut_card_remaining: ["integer", "NO"], committed_at: ["timestamp with time zone", "NO"],
  },
  shoe_secrets: { shoe_id: ["text", "NO"], seed_hex: ["text", "NO"], created_at: ["timestamp with time zone", "NO"] },
  shoe_reveals: {
    shoe_id: ["text", "NO"], seed_hex: ["text", "NO"], reveal_reason: ["text", "NO"],
    revealed_at: ["timestamp with time zone", "NO"],
  },
  shoe_deal_audits: {
    round_id: ["text", "NO"], shoe_id: ["text", "NO"], deal_index: ["integer", "NO"], dealt_cards: ["jsonb", "NO"],
    round_result: ["jsonb", "NO"], recorded_at: ["timestamp with time zone", "NO"],
  },
} as const;

const requiredConstraints = [
  ...coreIntegrityConstraints.map(({ name }) => name),
  "users_balance_policy", "game_tables_bet_policy", "bets_amount_policy", "balance_adjustments_amount_policy",
  "game_rounds_cancellation_reason_ck", "financial_ledger_user_fk", "financial_ledger_balance_transition",
  "financial_ledger_actor", "financial_ledger_source_reference", "financial_ledger_source_reference_unique",
  "auth_sessions_user_fk", "service_heartbeats_status_ck",
] as const;

const requiredIndexes = [
  "idx_game_rounds_one_active_per_table", "idx_users_username_normalized", "uq_game_tables_display_order",
  "idx_game_rounds_active", "idx_game_rounds_settled", "idx_game_rounds_shoe_settled", "idx_bets_user_round_created",
  "idx_bets_round_created", "idx_login_rate_limits_expires", "idx_financial_ledger_user_sequence",
  "idx_auth_sessions_user_active", "idx_shoe_commitments_table_created", "idx_shoe_deal_audits_shoe_index",
] as const;

const requiredTriggers = [
  "financial_ledger_no_update_delete", "financial_ledger_no_truncate", "users_balance_requires_ledger",
  "prevent_mutation_shoe_commitments", "prevent_mutation_shoe_reveals", "prevent_mutation_shoe_deal_audits",
  "prevent_update_shoe_secrets", "prevent_deal_after_shoe_reveal", "serialize_shoe_reveal_insert",
] as const;

function expectedColumnDescriptors() {
  return Object.entries(columns).flatMap(([table, tableColumns]) =>
    Object.entries(tableColumns).map(([column, [dataType, nullable]]) => `column:${table}.${column}:${dataType}:${nullable}`),
  );
}

const expectedDescriptors = [
  ...expectedColumnDescriptors(),
  ...requiredConstraints.map((name) => `constraint:${name}`),
  ...requiredIndexes.map((name) => `index:${name}`),
  ...requiredTriggers.map((name) => `trigger:${name}`),
  "view:financial_balance_reconciliation",
].sort();

function fingerprint(descriptors: readonly string[]) {
  return createHash("sha256").update(JSON.stringify(descriptors)).digest("hex");
}

export const expectedDatabaseSchemaFingerprint = fingerprint(expectedDescriptors);

export async function getDatabaseSchemaFingerprint(executor: SchemaExecutor) {
  const tableNames = Object.keys(columns);
  // Keep these sequential: node-postgres clients do not support concurrent
  // query execution, and migration validation often runs on a locked client.
  const columnRows = await executor.query<QueryResultRow>(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1)
     ORDER BY table_name, ordinal_position`,
    [tableNames],
  );
  const constraintRows = await executor.query<QueryResultRow>(
    "SELECT conname FROM pg_constraint WHERE conname = ANY($1)",
    [requiredConstraints],
  );
  const indexRows = await executor.query<QueryResultRow>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1)",
    [requiredIndexes],
  );
  const triggerRows = await executor.query<QueryResultRow>(
    "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)",
    [requiredTriggers],
  );
  const viewRows = await executor.query<QueryResultRow>(
    "SELECT table_name FROM information_schema.views WHERE table_schema = current_schema() AND table_name = 'financial_balance_reconciliation'",
  );

  const actualDescriptors = [
    ...columnRows.rows.map((row) => `column:${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`),
    ...constraintRows.rows.map((row) => `constraint:${row.conname}`),
    ...indexRows.rows.map((row) => `index:${row.indexname}`),
    ...triggerRows.rows.map((row) => `trigger:${row.tgname}`),
    ...viewRows.rows.map((row) => `view:${row.table_name}`),
  ].sort();

  const expectedSet = new Set(expectedDescriptors);
  const actualSet = new Set(actualDescriptors);
  return {
    expectedFingerprint: expectedDatabaseSchemaFingerprint,
    actualFingerprint: fingerprint(actualDescriptors),
    missing: expectedDescriptors.filter((descriptor) => !actualSet.has(descriptor)),
    unexpected: actualDescriptors.filter((descriptor) => !expectedSet.has(descriptor)),
  };
}

export async function assertDatabaseSchemaContract(executor: SchemaExecutor) {
  const result = await getDatabaseSchemaFingerprint(executor);
  if (result.missing.length > 0 || result.unexpected.length > 0) {
    throw new Error(
      `Database schema fingerprint drift: expected ${result.expectedFingerprint}, got ${result.actualFingerprint}; ` +
      `missing=${result.missing.slice(0, 5).join(",") || "none"}; ` +
      `unexpected=${result.unexpected.slice(0, 5).join(",") || "none"}`,
    );
  }
  return result.actualFingerprint;
}

const legacyRequiredColumns = [
  "column:game_tables.id:text:NO", "column:game_tables.code:text:NO", "column:users.id:text:NO",
  "column:users.username:text:NO", "column:users.balance:integer:NO", "column:game_rounds.id:text:NO",
  "column:game_rounds.table_id:text:NO", "column:bets.id:text:NO", "column:bets.user_id:text:NO",
  "column:balance_adjustments.id:text:NO", "column:balance_adjustments.user_id:text:NO",
] as const;

export async function assertUnmanagedSchemaAdoptable(executor: SchemaExecutor) {
  const coreTables = ["game_tables", "users", "game_rounds", "bets", "balance_adjustments"];
  const relations = await executor.query<QueryResultRow>(
    "SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND relname = ANY($1)",
    [coreTables],
  );
  if (relations.rows.length === 0) return "empty" as const;
  if (relations.rows.length !== coreTables.length) {
    throw new Error("Refusing to adopt unmanaged database schema: core table set is incomplete");
  }

  const actualColumns = await executor.query<QueryResultRow>(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [coreTables],
  );
  const descriptors = new Set(
    actualColumns.rows.map((row) => `column:${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`),
  );
  const missing = legacyRequiredColumns.filter((descriptor) => !descriptors.has(descriptor));
  if (missing.length > 0) {
    throw new Error(`Refusing to adopt unmanaged database schema: incompatible core fingerprint (${missing.join(",")})`);
  }
  return "compatible" as const;
}
