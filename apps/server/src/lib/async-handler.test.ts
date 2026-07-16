import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSafely } from "./async-handler.js";

test("safe dispatch contains rejected async callbacks", async () => {
  const expected = new Error("snapshot failed");
  let captured: unknown;

  await dispatchSafely(
    async () => {
      throw expected;
    },
    { type: "table_changed" },
    (error) => {
      captured = error;
    },
  );

  assert.equal(captured, expected);
});
