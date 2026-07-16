import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePayout,
  dealRoundFromShoe,
  shouldBankerDraw,
  type Card,
  type TableShoeState,
} from "./baccarat.js";

function card(rank: Card["rank"], suit: Card["suit"] = "S"): Card {
  return { rank, suit };
}

function shoeWithDrawOrder(drawOrder: Card[]): TableShoeState {
  return {
    cards: [...drawOrder].reverse(),
    cutCardRemaining: 0,
    cutCardReached: false,
    lastHandPending: false,
  };
}

test("calculates main, tie, pair, and banker commission payouts", () => {
  const playerWin = { winner: "PLAYER", playerPair: false, bankerPair: false } as const;
  const bankerWin = { winner: "BANKER", playerPair: false, bankerPair: false } as const;
  const tieWithPairs = { winner: "TIE", playerPair: true, bankerPair: true } as const;

  assert.equal(calculatePayout("PLAYER", 100, playerWin), 200);
  assert.equal(calculatePayout("PLAYER", 100, bankerWin), 0);
  assert.equal(calculatePayout("PLAYER", 100, tieWithPairs), 100);
  assert.equal(calculatePayout("BANKER", 101, bankerWin), 196);
  assert.equal(calculatePayout("BANKER", 100, tieWithPairs), 100);
  assert.equal(calculatePayout("TIE", 100, tieWithPairs), 900);
  assert.equal(calculatePayout("PLAYER_PAIR", 100, tieWithPairs), 1200);
  assert.equal(calculatePayout("BANKER_PAIR", 100, tieWithPairs), 1200);
});

test("implements the banker third-card table", () => {
  const thirdCardCases: Array<[number, Card["rank"], boolean]> = [
    [0, "8", true],
    [2, "K", true],
    [3, "8", false],
    [3, "7", true],
    [4, "A", false],
    [4, "2", true],
    [4, "7", true],
    [4, "8", false],
    [5, "3", false],
    [5, "4", true],
    [5, "7", true],
    [5, "8", false],
    [6, "5", false],
    [6, "6", true],
    [6, "7", true],
    [6, "8", false],
    [7, "6", false],
  ];

  assert.equal(shouldBankerDraw(5, null), true);
  assert.equal(shouldBankerDraw(6, null), false);

  for (const [bankerTotal, rank, expected] of thirdCardCases) {
    assert.equal(shouldBankerDraw(bankerTotal, card(rank)), expected);
  }
});

test("a natural ends the deal after the four opening cards", () => {
  const shoe = shoeWithDrawOrder([card("4"), card("5"), card("2"), card("3")]);
  const result = dealRoundFromShoe(shoe);

  assert.equal(result.playerCards.length, 2);
  assert.equal(result.bankerCards.length, 2);
  assert.equal(shoe.cards.length, 0);
  assert.ok(result.playerTotal >= 8 || result.bankerTotal >= 8);
});

test("a player total at or below five draws exactly one third card when banker stands", () => {
  const shoe = shoeWithDrawOrder([
    card("2"),
    card("2", "H"),
    card("3"),
    card("3", "H"),
    card("8"),
  ]);
  const result = dealRoundFromShoe(shoe);

  assert.equal(result.playerCards.length, 3);
  assert.equal(result.bankerCards.length, 2);
  assert.equal(shoe.cards.length, 0);
});
