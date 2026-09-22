import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  blackjackActionSchema,
  blackjackCommandSchema,
  liveClientMessageSchema,
  liveServerMessageSchema,
} from "./index.js";
test("Blackjack strict commands are part of the common WebSocket contract", () => {
  const command = {
    type: "blackjack_command",
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    action: { kind: "start", amount: 100 },
  };
  assert.deepEqual(liveClientMessageSchema.parse(command), command);
  assert.equal(blackjackCommandSchema.safeParse({ ...command, userId: "someone" }).success, false);
  assert.equal(
    blackjackActionSchema.safeParse({ kind: "start", amount: 100, payout: 200 }).success,
    false,
  );
  const reply = {
    type: "blackjack_result",
    requestId: command.requestId,
    result: {
      ok: false,
      status: 409,
      error: { code: "CONFLICT", message: "Updated", requestId: command.requestId },
    },
  };
  assert.deepEqual(liveServerMessageSchema.parse(reply), reply);
});
