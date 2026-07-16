import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { listUsers } from "./db.js";

describe("admin users pagination", () => {
  it("uses a stable bounded page query and reports the full total", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const executor = {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });

        if (text.includes("count(*)")) {
          return { rows: [{ total: "5" }] };
        }

        return {
          rows: [
            {
              id: "user-3",
              username: "player3",
              role: "PLAYER",
              is_active: true,
              balance: 500,
              created_at: new Date("2026-07-16T10:00:00.000Z"),
            },
          ],
        };
      },
    } as unknown as Pool;

    const result = await listUsers({ page: 2, pageSize: 2 }, executor);

    assert.equal(result.total, 5);
    assert.deepEqual(result.items, [
      {
        id: "user-3",
        username: "player3",
        role: "PLAYER",
        isActive: true,
        balance: 500,
        createdAt: "2026-07-16T10:00:00.000Z",
      },
    ]);
    assert.match(calls[1].text, /ORDER BY created_at ASC, id ASC/);
    assert.deepEqual(calls[1].values, [2, 2]);
  });
});
