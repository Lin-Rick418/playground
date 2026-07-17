import { type DbExecutor, parseJsonValue, queryRow } from "./client.js";

export type IdempotencyClaim<T> =
  | { kind: "claimed" }
  | { kind: "conflict" }
  | { kind: "replay"; statusCode: number; response: T };

export async function claimIdempotencyKey<T>(
  input: { actorId: string; scope: string; key: string; requestHash: string },
  executor: DbExecutor,
): Promise<IdempotencyClaim<T>> {
  const createdAt = new Date().toISOString();
  const inserted = await queryRow(
    executor,
    `INSERT INTO idempotency_keys (actor_id, scope, idempotency_key, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (actor_id, scope, idempotency_key) DO NOTHING
     RETURNING actor_id`,
    [input.actorId, input.scope, input.key, input.requestHash, createdAt],
  );

  if (inserted) {
    return { kind: "claimed" };
  }

  const existing = await queryRow(
    executor,
    `SELECT request_hash, status_code, response_json
     FROM idempotency_keys
     WHERE actor_id = $1 AND scope = $2 AND idempotency_key = $3
     FOR UPDATE`,
    [input.actorId, input.scope, input.key],
  );

  if (!existing) {
    throw new Error("Idempotency key disappeared during conflict resolution");
  }

  if (String(existing.request_hash) !== input.requestHash) {
    return { kind: "conflict" };
  }

  if (existing.status_code === null || existing.status_code === undefined || existing.response_json === null) {
    throw new Error("Idempotency key was committed without a response");
  }

  return {
    kind: "replay",
    statusCode: Number(existing.status_code),
    response: parseJsonValue<T>(existing.response_json),
  };
}

export async function completeIdempotencyKey(
  input: {
    actorId: string;
    scope: string;
    key: string;
    requestHash: string;
    statusCode: number;
    response: unknown;
  },
  executor: DbExecutor,
) {
  const completedAt = new Date().toISOString();
  const result = await executor.query(
    `UPDATE idempotency_keys
     SET status_code = $1, response_json = $2::jsonb, completed_at = $3
     WHERE actor_id = $4 AND scope = $5 AND idempotency_key = $6
       AND request_hash = $7 AND response_json IS NULL`,
    [
      input.statusCode,
      JSON.stringify(input.response),
      completedAt,
      input.actorId,
      input.scope,
      input.key,
      input.requestHash,
    ],
  );

  if (result.rowCount !== 1) {
    throw new Error("Idempotency response could not be recorded");
  }
}
