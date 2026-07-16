import assert from "node:assert/strict";
import test from "node:test";
import { chunkItems } from "./batch.js";

test("database writes are split into bounded batches without losing order", () => {
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkItems([], 2), []);
  assert.throws(() => chunkItems([1], 0), /positive integer/);
});
