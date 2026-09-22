import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  blackjackActionSchema,
  blackjackRoundSchema,
  type BlackjackAction,
} from "@baccarat/contracts";
import {
  activeHand,
  additionalStake,
  allowedActions,
  maximumPayout,
  payout,
  play,
  shuffleShoe,
  startRound,
  total,
  totalBet,
  type BlackjackState,
} from "../modules/blackjack/math.js";
import { publicBlackjackRound } from "../modules/blackjack/service.js";
function shoe(ranks: number[]) {
  const remaining = Array.from({ length: 312 }, (_, i) => i);
  return [
    ...ranks.map((rank) => {
      const index = remaining.findIndex((card) => Math.floor((card % 52) / 4) + 1 === rank);
      return remaining.splice(index, 1)[0];
    }),
    ...remaining,
  ];
}
function act(state: BlackjackState, kind: "hit" | "stand" | "double" | "split") {
  play(state, { kind, roundId: randomUUID(), expectedVersion: 1, handId: activeHand(state)!.id });
}
function insure(state: BlackjackState, accept: boolean) {
  play(state, { kind: "insurance", roundId: randomUUID(), expectedVersion: 1, accept });
}
test("Blackjack scores multiple aces and securely shuffles six complete decks", () => {
  assert.deepEqual(total([0, 1, 32]), { total: 21, soft: true });
  assert.deepEqual(total([0, 1, 32, 36]), { total: 21, soft: false });
  const deck = shuffleShoe();
  assert.equal(deck.length, 312);
  assert.deepEqual(
    [...deck].sort((a, b) => a - b),
    Array.from({ length: 312 }, (_, i) => i),
  );
  assert.throws(() => startRound(100, Array(312).fill(0)), /Invalid/);
});
test("Blackjack natural pays 3:2, beats ordinary 21, and pushes dealer natural", () => {
  let state = startRound(100, shoe([1, 9, 13, 7]));
  assert.equal(state.phase, "SETTLED");
  assert.equal(payout(state), 250);
  assert.equal(state.position, 4);
  state = startRound(100, shoe([1, 1, 13, 10]));
  assert.equal(state.phase, "INSURANCE");
  insure(state, false);
  assert.equal(payout(state), 100);
  state = startRound(100, shoe([10, 10, 9, 1]));
  assert.equal(payout(state), 0);
  assert.equal(state.phase, "SETTLED");
});
test("Blackjack insurance offers both choices before peek, including player natural", () => {
  let state = startRound(100, shoe([10, 1, 9, 10]));
  assert.deepEqual(allowedActions(state), ["insurance"]);
  insure(state, true);
  assert.equal(totalBet(state), 150);
  assert.equal(payout(state), 150);
  state = startRound(100, shoe([1, 1, 10, 10]));
  insure(state, true);
  assert.equal(payout(state), 250);
  state = startRound(100, shoe([1, 1, 10, 9]));
  insure(state, true);
  assert.equal(payout(state), 250);
  assert.equal(state.insurance.payout, 0);
  state = startRound(100, shoe([10, 1, 9, 6]));
  insure(state, false);
  act(state, "stand");
  assert.equal(state.position, 4);
  assert.equal(payout(state), 200); // soft 17 stands
});
test("Blackjack doubles exactly once and draws one card; dealer pushes ordinary 21", () => {
  const state = startRound(100, shoe([5, 10, 6, 7, 10, 10]));
  act(state, "double");
  assert.equal(state.hands[0].amount, 200);
  assert.equal(state.hands[0].cards.length, 3);
  assert.equal(payout(state), 400);
  assert.equal(state.position, 5);
  const tie = startRound(100, shoe([10, 10, 5, 7, 6, 4]));
  act(tie, "hit");
  assert.equal(tie.hands[0].total, 21);
  assert.equal(payout(tie), 200); // dealer stands 17
  const push = startRound(100, shoe([10, 7, 5, 4, 6, 10]));
  act(push, "hit");
  assert.equal(payout(push), 100);
});
test("Blackjack splits ten-valued faces, caps four hands and allows doubles after split", () => {
  const state = startRound(100, shoe([10, 6, 13, 10, 10, 12, 10, 11, 9, 8, 2, 5]));
  act(state, "split");
  act(state, "split");
  act(state, "split");
  assert.equal(state.hands.length, 4);
  assert.equal(totalBet(state), 400);
  assert.ok(!allowedActions(state).includes("split"));
  act(state, "double");
  assert.equal(state.hands[0].amount, 200);
  while (activeHand(state)) act(state, "stand");
  assert.equal(totalBet(state), 500);
  assert.equal(state.phase, "SETTLED");
  assert.ok(state.hands.every((h) => h.outcome !== "BLACKJACK"));
});
test("Blackjack split aces receive one card only and their 21 pays 1:1", () => {
  const state = startRound(100, shoe([1, 10, 1, 8, 10, 9]));
  act(state, "split");
  assert.equal(state.phase, "SETTLED");
  assert.equal(state.position, 6);
  assert.deepEqual(
    state.hands.map((h) => h.cards.length),
    [2, 2],
  );
  assert.equal(payout(state), 400);
  assert.deepEqual(allowedActions(state), []);
});
test("Blackjack all-bust ends without dealer drawing and rejects out-of-turn operations", () => {
  const state = startRound(100, shoe([10, 6, 9, 10, 5]));
  assert.throws(
    () =>
      additionalStake(state, {
        kind: "hit",
        roundId: randomUUID(),
        expectedVersion: 1,
        handId: randomUUID(),
      }),
    /目前的手牌/,
  );
  act(state, "hit");
  assert.equal(state.phase, "SETTLED");
  assert.equal(state.position, 5);
  assert.equal(payout(state), 0);
  assert.throws(
    () =>
      play(state, { kind: "insurance", roundId: randomUUID(), expectedVersion: 1, accept: true }),
    /不能/,
  );
});
test("Blackjack public projection and exposure cannot reveal hole card or shoe", () => {
  const state = startRound(100, shoe([8, 1, 8, 10]));
  const row = {
    id: randomUUID(),
    amount: 100,
    total_bet: 100,
    payout: 0,
    status: "ACTIVE",
    version: 1,
    rule_version: 1,
    created_at: new Date(),
    settled_at: null,
    state,
  };
  const visible = publicBlackjackRound(row);
  blackjackRoundSchema.parse(visible);
  assert.equal(visible.dealerCards.length, 1);
  assert.equal(visible.dealerTotal, null);
  assert.equal(visible.dealerSoft, null);
  assert.ok(!JSON.stringify(visible).includes('"shoe"'));
  assert.ok(!JSON.stringify(visible).includes('"position"'));
  const before = maximumPayout(state);
  state.dealer[1] = 20;
  assert.equal(maximumPayout(state), before);
  assert.deepEqual(publicBlackjackRound(row), visible);
});
test("Blackjack contract rejects client outcome injection and malformed stakes", () => {
  for (const amount of [0, 99, 101, 5001, Infinity])
    assert.equal(blackjackActionSchema.safeParse({ kind: "start", amount }).success, false);
  assert.equal(
    blackjackActionSchema.safeParse({ kind: "start", amount: 100, cards: [0, 36] }).success,
    false,
  );
  assert.equal(
    blackjackActionSchema.safeParse({
      kind: "insurance",
      roundId: randomUUID(),
      expectedVersion: 1,
      accept: true,
      amount: 1,
    }).success,
    false,
  );
  assert.equal(
    blackjackActionSchema.safeParse({
      kind: "hit",
      roundId: randomUUID(),
      expectedVersion: 0,
      handId: randomUUID(),
    } satisfies BlackjackAction).success,
    false,
  );
});

test("Blackjack fixed shoe rotations conserve physical cards, stakes and payout bounds", () => {
  const ordered = Array.from({ length: 312 }, (_, i) => i);
  for (let offset = 0; offset < 312; offset += 7) {
    const deck = [...ordered.slice(offset), ...ordered.slice(0, offset)];
    const state = startRound(100, deck);
    if (state.phase === "INSURANCE") insure(state, offset % 2 === 0);
    let operations = 0;
    while (activeHand(state)) {
      const h = activeHand(state)!;
      if (allowedActions(state).includes("split")) act(state, "split");
      else if (allowedActions(state).includes("double") && h.total <= 11) act(state, "double");
      else act(state, h.total < 17 ? "hit" : "stand");
      assert.ok(++operations < 100);
    }
    assert.equal(state.phase, "SETTLED");
    assert.equal(
      state.position,
      state.dealer.length + state.hands.reduce((n, h) => n + h.cards.length, 0),
    );
    assert.ok(totalBet(state) <= 850);
    assert.ok(payout(state) <= maximumPayout(state));
    const cards = [...state.dealer, ...state.hands.flatMap((h) => h.cards)].sort((a, b) => a - b);
    assert.deepEqual(
      cards,
      deck
        .slice(0, state.position)
        .map((n) => n % 52)
        .sort((a, b) => a - b),
    );
  }
});
