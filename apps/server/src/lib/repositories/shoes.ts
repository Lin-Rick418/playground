import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { type Card, type TableShoeState } from "../baccarat.js";
import { createShoeCommitment, createShoeFromSeed, generateShoeSeed, SHOE_AUDIT_VERSION, SHOE_DEAL_ALGORITHM, SHOE_DECK_COUNT, SHOE_SHUFFLE_ALGORITHM, type AuditedRoundResult, type ShoeAuditBundle, type ShoeCommitmentRecord, type ShoeDealAuditRecord } from "../shoe-audit.js";
import { type DbExecutor, type DbRow, isPoolClient, parseJsonValue, pool, queryRow, queryRows, toIsoString, withTransaction } from "./client.js";
import { getActiveRound } from "./rounds.js";
import { cancelRoundAndRefundBets } from "./round-lifecycle.js";

type PersistedTableShoe = TableShoeState & { shoeId: string };

function mapShoeCommitment(row: DbRow): ShoeCommitmentRecord {
  return {
    version: Number(row.audit_version),
    shoeId: String(row.shoe_id),
    tableId: String(row.table_id),
    shuffleAlgorithm: String(row.shuffle_algorithm),
    dealAlgorithm: String(row.deal_algorithm),
    deckCount: Number(row.deck_count),
    commitment: String(row.commitment),
    cutCardRemaining: Number(row.cut_card_remaining),
    committedAt: toIsoString(row.committed_at),
  };
}

export function publicShoeCommitment(commitment: ShoeCommitmentRecord | null) {
  if (!commitment) return null;
  return {
    version: commitment.version,
    shoeId: commitment.shoeId,
    shuffleAlgorithm: commitment.shuffleAlgorithm,
    dealAlgorithm: commitment.dealAlgorithm,
    deckCount: commitment.deckCount,
    commitment: commitment.commitment,
    committedAt: commitment.committedAt,
  };
}

function mapShoeDealAudit(row: DbRow): ShoeDealAuditRecord {
  return {
    dealIndex: Number(row.deal_index),
    roundId: String(row.round_id),
    dealtCards: parseJsonValue<Card[]>(row.dealt_cards),
    result: parseJsonValue<AuditedRoundResult>(row.round_result),
    recordedAt: toIsoString(row.recorded_at),
  };
}

export async function getShoeCommitment(shoeId: string, executor: DbExecutor = pool) {
  if (!shoeId) return null;
  const row = await queryRow(executor, "SELECT * FROM shoe_commitments WHERE shoe_id = $1", [shoeId]);
  return row ? mapShoeCommitment(row) : null;
}

export async function getShoeCommitments(shoeIds: string[], executor: DbExecutor = pool) {
  if (shoeIds.length === 0) return new Map<string, ShoeCommitmentRecord>();
  const rows = await queryRows(executor, "SELECT * FROM shoe_commitments WHERE shoe_id = ANY($1)", [shoeIds]);
  return new Map(rows.map((row: DbRow) => {
    const commitment = mapShoeCommitment(row);
    return [commitment.shoeId, commitment] as const;
  }));
}

async function lockShoeLifecycle(shoeId: string, executor: PoolClient) {
  return queryRow(
    executor,
    `SELECT c.*, s.seed_hex AS active_seed, r.shoe_id AS revealed_shoe_id
     FROM shoe_commitments c
     LEFT JOIN shoe_secrets s ON s.shoe_id = c.shoe_id
     LEFT JOIN shoe_reveals r ON r.shoe_id = c.shoe_id
     WHERE c.shoe_id = $1
     FOR UPDATE OF c`,
    [shoeId],
  );
}

export async function validateActiveShoeAudit(
  shoeId: string,
  tableId: string,
  executor: DbExecutor = pool,
): Promise<{ valid: boolean; reason: string | null }> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => validateActiveShoeAudit(shoeId, tableId, client));
  }

  const row = await lockShoeLifecycle(shoeId, executor);
  if (!row) return { valid: false, reason: "SHOE_COMMITMENT_MISSING" };
  if (String(row.table_id) !== tableId) return { valid: false, reason: "SHOE_TABLE_MISMATCH" };
  if (row.revealed_shoe_id) return { valid: false, reason: "SHOE_ALREADY_REVEALED" };
  if (!row.active_seed) return { valid: false, reason: "SHOE_ACTIVE_SECRET_MISSING" };
  if (
    Number(row.audit_version) !== SHOE_AUDIT_VERSION ||
    String(row.shuffle_algorithm) !== SHOE_SHUFFLE_ALGORITHM ||
    String(row.deal_algorithm) !== SHOE_DEAL_ALGORITHM ||
    Number(row.deck_count) !== SHOE_DECK_COUNT
  ) {
    return { valid: false, reason: "SHOE_AUDIT_VERSION_MISMATCH" };
  }

  try {
    const expectedCommitment = createShoeCommitment({
      shoeId,
      tableId,
      seed: String(row.active_seed),
      deckCount: Number(row.deck_count),
    });
    if (expectedCommitment !== String(row.commitment)) {
      return { valid: false, reason: "SHOE_COMMITMENT_INVALID" };
    }
    if (createShoeFromSeed(String(row.active_seed), Number(row.deck_count)).shoe.cutCardRemaining !== Number(row.cut_card_remaining)) {
      return { valid: false, reason: "SHOE_CUT_CARD_INVALID" };
    }
  } catch {
    return { valid: false, reason: "SHOE_COMMITMENT_INVALID" };
  }

  return { valid: true, reason: null };
}

export async function getShoeAuditBundle(shoeId: string, executor: DbExecutor = pool): Promise<ShoeAuditBundle | null> {
  const row = await queryRow(
    executor,
    `SELECT c.*, r.seed_hex, r.reveal_reason, r.revealed_at
     FROM shoe_commitments c
     LEFT JOIN shoe_reveals r ON r.shoe_id = c.shoe_id
     WHERE c.shoe_id = $1`,
    [shoeId],
  );
  if (!row) return null;

  const dealRows = await queryRows(
    executor,
    "SELECT * FROM shoe_deal_audits WHERE shoe_id = $1 ORDER BY deal_index ASC",
    [shoeId],
  );

  return {
    ...mapShoeCommitment(row),
    reveal: row.seed_hex
      ? {
          seed: String(row.seed_hex),
          reason: String(row.reveal_reason),
          revealedAt: toIsoString(row.revealed_at),
        }
      : null,
    deals: dealRows.map((dealRow: DbRow) => mapShoeDealAudit(dealRow)),
  };
}

export async function recordShoeDealAudit(
  input: {
    shoeId: string;
    roundId: string;
    dealtCards: Card[];
    result: AuditedRoundResult;
  },
  executor: DbExecutor = pool,
): Promise<ShoeDealAuditRecord> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => recordShoeDealAudit(input, client));
  }

  const lifecycle = await lockShoeLifecycle(input.shoeId, executor);
  if (!lifecycle) throw new Error(`Cannot audit uncommitted shoe ${input.shoeId}`);
  if (lifecycle.revealed_shoe_id) throw new Error(`Cannot append deal after shoe ${input.shoeId} reveal`);
  if (!lifecycle.active_seed) throw new Error(`Cannot audit shoe ${input.shoeId}: active seed is missing`);

  const indexRow = await queryRow(
    executor,
    "SELECT COALESCE(MAX(deal_index), -1) + 1 AS next_index FROM shoe_deal_audits WHERE shoe_id = $1",
    [input.shoeId],
  );
  const dealIndex = Number(indexRow?.next_index ?? 0);
  const recordedAt = new Date().toISOString();

  await executor.query(
    `INSERT INTO shoe_deal_audits (round_id, shoe_id, deal_index, dealt_cards, round_result, recorded_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      input.roundId,
      input.shoeId,
      dealIndex,
      JSON.stringify(input.dealtCards),
      JSON.stringify(input.result),
      recordedAt,
    ],
  );

  return { dealIndex, ...input, recordedAt };
}

async function revealShoeAudit(shoeId: string, reason: string, executor: DbExecutor): Promise<void> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => revealShoeAudit(shoeId, reason, client));
  }

  const lifecycle = await lockShoeLifecycle(shoeId, executor);
  if (!lifecycle) return;
  if (lifecycle.revealed_shoe_id) {
    await executor.query("DELETE FROM shoe_secrets WHERE shoe_id = $1", [shoeId]);
    return;
  }
  if (!lifecycle.active_seed) {
    // The lost seed cannot be truthfully revealed. Leave the commitment as an
    // unrevealed cancelled proof and rotate the table to a fresh commitment.
    return;
  }

  const revealedAt = new Date().toISOString();
  await executor.query(
    `INSERT INTO shoe_reveals (shoe_id, seed_hex, reveal_reason, revealed_at)
     VALUES ($1, $2, $3, $4)`,
    [shoeId, String(lifecycle.active_seed), reason, revealedAt],
  );

  await executor.query("DELETE FROM shoe_secrets WHERE shoe_id = $1", [shoeId]);
}

function normalizeLegacyShoeState(cards: Card[]): TableShoeState {
  const cutCardReached = cards.length <= 14;

  return {
    cards,
    cutCardRemaining: Math.min(14, cards.length),
    cutCardReached,
    lastHandPending: cutCardReached,
  };
}

export async function getTableShoe(
  tableId: string,
  executor: DbExecutor = pool,
  options?: { forUpdate?: boolean },
): Promise<PersistedTableShoe | null> {
  const suffix = options?.forUpdate && isPoolClient(executor) ? " FOR UPDATE" : "";
  const row = await queryRow(executor, `SELECT current_shoe_id, shoe_state FROM game_tables WHERE id = $1${suffix}`, [tableId]);

  if (!row) {
    return null;
  }

  const shoeId = String(row.current_shoe_id);
  const parsed = parseJsonValue<Partial<TableShoeState> | Card[]>(row.shoe_state);

  if (Array.isArray(parsed)) {
    return {
      shoeId,
      ...normalizeLegacyShoeState(parsed),
    };
  }

  const cards = Array.isArray(parsed.cards) ? (parsed.cards) : [];
  return {
    shoeId,
    cards,
    cutCardRemaining:
      typeof parsed.cutCardRemaining === "number" && Number.isFinite(parsed.cutCardRemaining)
        ? parsed.cutCardRemaining
        : Math.min(14, cards.length),
    cutCardReached: Boolean(parsed.cutCardReached),
    lastHandPending: Boolean(parsed.lastHandPending),
  };
}

export async function replaceTableShoe(
  tableId: string,
  executor: DbExecutor = pool,
  revealReason = "ROTATED",
): Promise<PersistedTableShoe> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => replaceTableShoe(tableId, client, revealReason));
  }

  const currentShoe = await getTableShoe(tableId, executor, { forUpdate: true });
  if (currentShoe?.shoeId) {
    await revealShoeAudit(currentShoe.shoeId, revealReason, executor);
  }

  const shoeId = randomUUID();
  const seed = generateShoeSeed();
  const createdAt = new Date().toISOString();
  const nextShoe = createShoeFromSeed(seed, SHOE_DECK_COUNT).shoe;
  const commitment = createShoeCommitment({ shoeId, tableId, seed, deckCount: SHOE_DECK_COUNT });

  await executor.query(
    `INSERT INTO shoe_commitments (
       shoe_id, table_id, audit_version, shuffle_algorithm, deal_algorithm,
       deck_count, commitment, cut_card_remaining, committed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      shoeId,
      tableId,
      SHOE_AUDIT_VERSION,
      SHOE_SHUFFLE_ALGORITHM,
      SHOE_DEAL_ALGORITHM,
      SHOE_DECK_COUNT,
      commitment,
      nextShoe.cutCardRemaining,
      createdAt,
    ],
  );
  await executor.query(
    "INSERT INTO shoe_secrets (shoe_id, seed_hex, created_at) VALUES ($1, $2, $3)",
    [shoeId, seed, createdAt],
  );
  await executor.query("UPDATE game_tables SET current_shoe_id = $1, shoe_state = $2::jsonb WHERE id = $3", [
    shoeId,
    JSON.stringify({
      cards: nextShoe.cards,
      cutCardRemaining: nextShoe.cutCardRemaining,
      cutCardReached: nextShoe.cutCardReached,
      lastHandPending: nextShoe.lastHandPending,
    }),
    tableId,
  ]);
  return { shoeId, ...nextShoe };
}

export async function saveTableShoe(tableId: string, shoeId: string, shoe: TableShoeState, executor: DbExecutor = pool) {
  await executor.query("UPDATE game_tables SET current_shoe_id = $1, shoe_state = $2::jsonb WHERE id = $3", [
    shoeId,
    JSON.stringify({
      cards: shoe.cards,
      cutCardRemaining: shoe.cutCardRemaining,
      cutCardReached: shoe.cutCardReached,
      lastHandPending: shoe.lastHandPending,
    }),
    tableId,
  ]);
  return {
    shoeId,
    ...shoe,
  };
}

export async function ensureTableShoe(
  tableId: string,
  executor: DbExecutor = pool,
): Promise<PersistedTableShoe> {
  if (!isPoolClient(executor)) {
    return withTransaction((client) => ensureTableShoe(tableId, client));
  }

  const currentShoe = await getTableShoe(tableId, executor, { forUpdate: true });

  const commitment = currentShoe?.shoeId ? await getShoeCommitment(currentShoe.shoeId, executor) : null;

  if (currentShoe?.shoeId && commitment) {
    const validation = await validateActiveShoeAudit(currentShoe.shoeId, tableId, executor);
    if (!validation.valid) {
      return replaceTableShoe(tableId, executor, validation.reason ?? "SHOE_AUDIT_INVALID");
    }
  }

  if (!currentShoe || !currentShoe.shoeId || currentShoe.cards.length < 6 || !commitment) {
    return replaceTableShoe(
      tableId,
      executor,
      commitment ? "INSUFFICIENT_CARDS" : "LEGACY_UPGRADE",
    );
  }

  return currentShoe;
}

export async function migrateTableShoeAtStartup(tableId: string, executor: PoolClient) {
  const activeRound = await getActiveRound(tableId, executor, { forUpdate: true });
  const currentShoe = await getTableShoe(tableId, executor, { forUpdate: true });
  const commitment = currentShoe?.shoeId ? await getShoeCommitment(currentShoe.shoeId, executor) : null;

  if (commitment && currentShoe) {
    const validation = await validateActiveShoeAudit(currentShoe.shoeId, tableId, executor);
    if (!validation.valid) {
      if (activeRound) {
        await cancelRoundAndRefundBets(activeRound.id, validation.reason ?? "SHOE_AUDIT_INVALID", executor);
      }
      return {
        shoe: await replaceTableShoe(tableId, executor, validation.reason ?? "SHOE_AUDIT_INVALID"),
        fatalReason: null,
      };
    }
  }

  const requiresRotation = !currentShoe || !currentShoe.shoeId || !commitment || currentShoe.cards.length < 6;
  if (
    activeRound &&
    (requiresRotation || !currentShoe || activeRound.shoeId !== currentShoe.shoeId)
  ) {
    const cancellationReason = !commitment
      ? "LEGACY_SHOE_UNAUDITED"
      : currentShoe && currentShoe.cards.length < 6
        ? "INSUFFICIENT_COMMITTED_CARDS"
        : "SHOE_BINDING_INVALID";
    await cancelRoundAndRefundBets(activeRound.id, cancellationReason, executor);
  }

  if (requiresRotation) {
    return {
      shoe: await replaceTableShoe(
        tableId,
        executor,
        commitment ? "INSUFFICIENT_CARDS_CANCELLED" : "LEGACY_UPGRADE",
      ),
      fatalReason: null,
    };
  }

  return { shoe: currentShoe, fatalReason: null };
}
