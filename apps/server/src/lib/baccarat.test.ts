import assert from "node:assert/strict";
import test from "node:test";
import { dealRoundFromShoe, type Card, type TableShoeState } from "./baccarat.js";

function createDeterministicShoe(cardsInDealOrder: Card[]): TableShoeState {
  return {
    cards: [...cardsInDealOrder].reverse(),
    cutCardRemaining: 0,
    cutCardReached: true,
    lastHandPending: false,
  };
}

test("deals the opening four cards in Player, Banker, Player, Banker order", () => {
  const firstPlayer = { suit: "S", rank: "4" } as const;
  const firstBanker = { suit: "H", rank: "5" } as const;
  const secondPlayer = { suit: "D", rank: "4" } as const;
  const secondBanker = { suit: "C", rank: "3" } as const;
  const shoe = createDeterministicShoe([
    firstPlayer,
    firstBanker,
    secondPlayer,
    secondBanker,
  ]);

  const result = dealRoundFromShoe(shoe);

  assert.deepEqual(result.playerCards, [firstPlayer, secondPlayer]);
  assert.deepEqual(result.bankerCards, [firstBanker, secondBanker]);
  assert.equal(result.playerTotal, 8);
  assert.equal(result.bankerTotal, 8);
  assert.equal(result.playerPair, true);
  assert.equal(result.bankerPair, false);
  assert.equal(result.winner, "TIE");
});

test("applies third-card rules after assigning the interleaved opening cards", () => {
  const firstPlayer = { suit: "S", rank: "2" } as const;
  const firstBanker = { suit: "H", rank: "4" } as const;
  const secondPlayer = { suit: "D", rank: "3" } as const;
  const secondBanker = { suit: "C", rank: "2" } as const;
  const playerThird = { suit: "S", rank: "7" } as const;
  const bankerThird = { suit: "H", rank: "9" } as const;
  const shoe = createDeterministicShoe([
    firstPlayer,
    firstBanker,
    secondPlayer,
    secondBanker,
    playerThird,
    bankerThird,
  ]);

  const result = dealRoundFromShoe(shoe);

  assert.deepEqual(result.playerCards, [firstPlayer, secondPlayer, playerThird]);
  assert.deepEqual(result.bankerCards, [firstBanker, secondBanker, bankerThird]);
  assert.equal(result.playerTotal, 2);
  assert.equal(result.bankerTotal, 5);
  assert.equal(result.winner, "BANKER");
  assert.equal(shoe.cards.length, 0);
});
