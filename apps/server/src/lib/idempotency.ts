import { createHash } from "node:crypto";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function parseIdempotencyKey(value: string | string[] | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const key = value.trim();
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
}

export function fingerprintIdempotencyRequest(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
