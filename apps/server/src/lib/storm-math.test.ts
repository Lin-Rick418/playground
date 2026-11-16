import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { stormSpinResultSchema } from "@baccarat/contracts";
import {
  enterFeature,
  bonusShowcase,
  SUPER_BONUS,
  evaluate,
  initialState as emptyState,
  makeBoard,
  showcaseBoard,
  spin,
  tile,
  tumble,
  WEIGHTS,
  type Tile,
  type SymbolKind,
} from "../modules/storm/math.js";
const initialState = () => ({ ...emptyState(), balance: 10000 });
const balanced = (): Tile[] =>
  Array.from({ length: 30 }, (_, i) =>
    tile((["ruby", "emerald", "sapphire", "amber", "lotus", "scarab"] as SymbolKind[])[i % 6]!),
  );
function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function refillThenUpgrade() {
  const picks = [0.15, 0.3, 0.45, 0.65, 0.8, 0.89, 0.92, 0.95];
  picks.push(0.1);
  return () => picks.shift() ?? 0.99;
}
describe("server-authoritative temple rules", () => {
  it("requires eight symbols anywhere and pays each group once", () => {
    const positions = [0, 1, 5, 9, 14, 20, 27, 29];
    const board = Array.from({ length: 30 }, (_, i) =>
      tile(positions.includes(i) ? "ruby" : "scatter"),
    );
    assert.deepEqual(evaluate(board, 20), {
      win: 24,
      winners: positions,
      groups: [{ kind: "ruby", count: 8, win: 24 }],
    });
    board[positions[0]!] = tile("sun");
    assert.equal(evaluate(board, 20).win, 0);
    for (let i = 0; i < 12; i++) board[i] = tile("emerald");
    assert.ok(
      evaluate(board, 20).groups.some((value) =>
        isDeepStrictEqual(value, { kind: "emerald", count: 12, win: 60 }),
      ),
    );
  });
  it("preserves survivor identity and order within every falling column", () => {
    const board = balanced();
    const next = tumble(board, [6, 12], seeded(8));
    assert.equal(next[12], board[0]);
    assert.equal(next[18], board[18]);
    assert.equal(next[24], board[24]);
    assert.equal(next[1], board[1]);
    assert.equal(next.length, 30);
    assert.equal(new Set(next.map((t) => t.id)).size, 30);
  });
  it("debits once without mutating input and rejects invalid stakes or insufficient points", () => {
    const state = initialState();
    assert.equal(spin(state, 20, seeded(1), balanced()).state.balance, 9980);
    assert.deepEqual(state, initialState());
    assert.throws(() => spin({ ...state, balance: 9 }, 10), new RegExp("不足"));
    assert.throws(() => spin(state, 11), new RegExp("無效"));
  });
  it("grants 15 free rounds, retriggers once per round, and caps the entire series at 100", () => {
    const board = balanced();
    [0, 1, 2, 3].forEach((i) => (board[i] = tile("scatter")));
    const first = spin(initialState(), 20, seeded(2), board);
    assert.equal(first.awarded, 15);
    assert.equal(first.state.freeLeft, 15);
    const last = spin({ ...first.state, freeGranted: 98, freeLeft: 1 }, 20, seeded(3), board);
    assert.equal(last.awarded, 2);
    assert.equal(last.state.freeLeft, 2);
    assert.equal(last.state.freeGranted, 100);
    assert.equal(spin({ ...last.state, freeLeft: 1 }, 20, seeded(4), board).state.freeLeft, 0);
  });
  it("does not collect or upgrade balls on a losing free round", () => {
    const board = balanced();
    board[0] = tile("orb", 5);
    const state = { ...enterFeature(initialState()), multiplier: 7 };
    const result = spin(state, 20, () => 0, board);
    assert.equal(result.collected, 0);
    assert.deepEqual(result.upgrades, []);
    assert.equal(result.state.multiplier, 7);
    assert.equal(result.payout, 0);
    assert.equal(result.state.balance, state.balance);
    assert.equal(result.state.freeLeft, 14);
  });
  it("upgrades before collection, adds a surviving ball only once and applies the accumulated factor once", () => {
    const state = { ...enterFeature(initialState()), multiplier: 7 };
    const board = showcaseBoard();
    const result = spin(state, 20, refillThenUpgrade(), board);
    assert.equal(result.baseWin, 24);
    assert.deepEqual(result.upgrades, [{ id: board[4]!.id, from: 5, to: 10 }]);
    assert.equal(result.collected, 10);
    assert.equal(result.factor, 17);
    assert.equal(result.payout, 408);
    assert.equal(result.state.balance, 10408);
    assert.equal(result.state.multiplier, 17);
    assert.equal(board[4]!.value, 5);
    assert.equal(state.multiplier, 7);
  });
  it("uses original normal/super upgrade thresholds and caps each ball at 1000", () => {
    const rng = (last: number) => {
      const values = [0.15, 0.3, 0.45, 0.65, 0.8, 0.89, 0.92, 0.95];
      return () => values.shift() ?? last;
    };
    const normal = spin(enterFeature(initialState()), 20, rng(0.3), showcaseBoard());
    const superResult = spin(
      enterFeature(initialState(), "super"),
      20,
      rng(0.3),
      showcaseBoard(800),
    );
    assert.equal(normal.upgrades.length, 0);
    assert.equal(superResult.upgrades[0]!.to, 1000);
  });
  it("bounds repeated cascades and declares normalized original symbol weights", () => {
    assert.equal(
      WEIGHTS.reduce((n, [, w]) => n + w, 0),
      100,
    );
    assert.equal(evaluate(showcaseBoard(), 20).win, 24);
    const result = spin(
      initialState(),
      20,
      () => 0,
      makeBoard(() => 0),
    );
    assert.equal(result.frames.length, 13);
    assert.equal(result.limited, true);
    assert.equal(result.payout, 12 * 72);
  });
  it("conserves points through a seeded paid/free session", () => {
    let state = initialState(),
      expected = state.balance;
    const rng = seeded(123);
    for (let i = 0; i < 200; i++) {
      if (!state.freeLeft && state.balance < 20) break;
      const result = spin(state, 20, rng);
      expected += result.payout - (state.freeLeft ? 0 : 20);
      assert.equal(result.state.balance, expected);
      assert.equal(result.board.length, 30);
      assert.ok(result.state.freeLeft >= 0);
      state = result.state;
    }
  });
  it("does not multiply a winning free spin by old accumulated balls when no new ball appears", () => {
    const board = showcaseBoard();
    board[4] = tile("moon");
    const result = spin(
      { ...enterFeature(initialState()), multiplier: 700 },
      20,
      refillThenUpgrade(),
      board,
    );
    assert.equal(result.baseWin, 24);
    assert.equal(result.collected, 0);
    assert.equal(result.factor, 1);
    assert.equal(result.payout, 24);
    assert.equal(result.state.multiplier, 700);
  });
  it("records every consecutive upgrade, stays bounded even with constant successful RNG, and credits once", () => {
    const values = [0.15, 0.3, 0.45, 0.65, 0.8, 0.89, 0.92, 0.95];
    const result = spin(
      enterFeature(initialState()),
      20,
      () => values.shift() ?? 0,
      showcaseBoard(),
    );
    assert.deepEqual(
      result.upgrades.map((u) => [u.from, u.to]),
      [
        [5, 10],
        [10, 20],
        [20, 40],
        [40, 80],
        [80, 160],
        [160, 320],
        [320, 640],
        [640, 1000],
      ],
    );
    assert.equal(result.collected, 1000);
    assert.equal(result.payout, 24000);
    assert.equal(result.state.balance, 34000);
    assert.equal(result.state.featureWin, 24000);
  });
  it("halts before refilling at the cap, cancels free retriggers and settles exactly the capped amount", () => {
    let calls = 0;
    const board = showcaseBoard();
    [1, 2, 6].forEach((i) => (board[i] = tile("scatter")));
    const state = { ...enterFeature(initialState()), multiplier: 25000, featureWin: 80 };
    const result = spin(
      state,
      20,
      () => {
        calls++;
        return 0;
      },
      board,
    );
    assert.equal(result.capped, true);
    assert.equal(result.frames.length, 1);
    assert.equal(calls, 0);
    assert.deepEqual(result.upgrades, []);
    assert.equal(result.awarded, 0);
    assert.equal(result.state.freeLeft, 0);
    assert.equal(result.payout, 500000);
    assert.equal(result.state.balance, 510000);
    assert.equal(result.state.featureWin, 500080);
    assert.equal(state.freeLeft, 15);
  });
  it("halts consecutive upgrades immediately when their new value reaches the spin cap", () => {
    const picks = [0.15, 0.3, 0.45, 0.65, 0.8, 0.89, 0.92, 0.95];
    const result = spin(
      { ...enterFeature(initialState()), multiplier: 20800 },
      20,
      () => picks.shift() ?? 0,
      showcaseBoard(20),
    );
    assert.deepEqual(
      result.upgrades.map((u) => u.to),
      [40],
    );
    assert.equal(result.payout, 500000);
    assert.equal(result.capped, true);
    assert.equal(result.state.freeLeft, 0);
  });
  for (const count of [1, 2, 3, 4])
    it(`awards ${count} Super Bonus symbols once with the documented multiplier`, () => {
      const result = spin(
        initialState(),
        20,
        () => {
          throw new Error("must not redraw");
        },
        bonusShowcase(count),
        { showcase: true },
      );
      assert.equal(result.bonusCount, count);
      assert.equal(result.bonusWin, 20 * SUPER_BONUS[count]!);
      assert.equal(result.payout, result.bonusWin);
      assert.equal(result.state.balance, 10000 + result.payout);
      assert.equal(result.cost, 0);
      assert.equal(result.capped, count === 4);
      assert.equal(result.state.freeLeft, count === 4 ? 0 : 15);
      if (count < 4) assert.equal(result.state.feature, "super");
    });
  it("requires a free trigger for the Super Bonus award and does not pay it again during free rounds", () => {
    const board = bonusShowcase(2);
    board[0] = tile("moon");
    assert.equal(spin(initialState(), 20, () => 0.99, board).bonusWin, 0);
    const result = spin(enterFeature(initialState(), "super"), 20, () => 0.99, bonusShowcase(2));
    assert.equal(result.bonusWin, 0);
    assert.equal(result.payout, 0);
    assert.equal(result.awarded, 5);
  });
  it("enforces 1000x on every Godly ball including refills, charges no showcase points, and does not invent balls", () => {
    const result = spin(initialState(), 20, () => 0.99, showcaseBoard(5), {
      showcase: true,
      godly: true,
    });
    const balls = result.frames.flatMap((f) => f.board.filter((t) => t.kind === "orb"));
    assert.ok(balls.length > 1);
    assert.equal(
      balls.every((t) => t.value === 1000),
      true,
    );
    assert.equal(result.cost, 0);
    assert.equal(result.state.balance, 10000 + result.payout);
    assert.equal(
      spin(initialState(), 20, () => 0.5, balanced(), { godly: true, showcase: true }).board.some(
        (t) => t.kind === "orb",
      ),
      false,
    );
  });
});

it("settles decimal wallet balances exactly and emits valid bounded contracts", () => {
  let state = { ...initialState(), balance: 10000.01 };
  const rng = seeded(92841);
  for (let i = 0; i < 500; i++) {
    if (state.balance < 20 && !state.freeLeft) break;
    const result = spin(state, 20, rng);
    stormSpinResultSchema.parse(result);
    assert.equal(
      Math.round(result.state.balance * 100),
      Math.round(state.balance * 100) - result.cost * 100 + result.payout * 100,
    );
    state = result.state;
  }
});
