import assert from "node:assert/strict";
import test from "node:test";
import { parsePagination } from "./pagination.js";

test("pagination applies safe defaults, offsets, and a hard page-size cap", () => {
  assert.deepEqual(parsePagination({}), { page: 1, pageSize: 25, offset: 0 });
  assert.deepEqual(parsePagination({ page: "3", pageSize: "50" }), { page: 3, pageSize: 50, offset: 100 });
  assert.deepEqual(parsePagination({ page: "0", pageSize: "999" }), { page: 1, pageSize: 100, offset: 0 });
  assert.deepEqual(parsePagination({ page: "1 OR 1=1", pageSize: "-1" }), { page: 1, pageSize: 25, offset: 0 });
});
