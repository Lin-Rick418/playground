import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_ROUND_UNIQUE_INDEX,
  createOrGetActiveRound,
  isActiveRoundUniqueViolation,
} from "./active-round-invariant.js";

function activeRoundConflict() {
  return Object.assign(new Error("duplicate active round"), {
    code: "23505",
    constraint: ACTIVE_ROUND_UNIQUE_INDEX,
  });
}

test("recognizes only the active-round partial unique index violation", () => {
  assert.equal(isActiveRoundUniqueViolation(activeRoundConflict()), true);
  assert.equal(
    isActiveRoundUniqueViolation(
      Object.assign(new Error("different unique key"), {
        code: "23505",
        constraint: "users_username_key",
      }),
    ),
    false,
  );
  assert.equal(
    isActiveRoundUniqueViolation(
      Object.assign(new Error("connection failed"), {
        code: "08006",
        constraint: ACTIVE_ROUND_UNIQUE_INDEX,
      }),
    ),
    false,
  );
});

test("concurrent creators converge on the one stored active round", async () => {
  type Round = { id: string };

  const storedRound = { id: "round-1" };
  let activeRound: Round | null = null;
  let readyCount = 0;
  let releaseCreators: (() => void) | undefined;
  const creatorsReady = new Promise<void>((resolve) => {
    releaseCreators = resolve;
  });

  const createRound = async () => {
    readyCount += 1;

    if (readyCount === 2) {
      releaseCreators?.();
    }

    await creatorsReady;

    if (!activeRound) {
      activeRound = storedRound;
      return storedRound;
    }

    throw activeRoundConflict();
  };

  const results = await Promise.all([
    createOrGetActiveRound(createRound, async () => activeRound),
    createOrGetActiveRound(createRound, async () => activeRound),
  ]);

  assert.deepEqual(results.map((result) => result.round.id), [storedRound.id, storedRound.id]);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
});

test("does not hide an active-round conflict when no winning row can be read", async () => {
  const conflict = activeRoundConflict();

  await assert.rejects(
    createOrGetActiveRound(
      async () => {
        throw conflict;
      },
      async () => null,
    ),
    (error) => error === conflict,
  );
});
