import type { BetType, RoundWinner } from "../types/domain.js";

const suits = ["S", "H", "D", "C"] as const;
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export type Card = {
  rank: (typeof ranks)[number];
  suit: (typeof suits)[number];
};

export type TableShoeState = {
  cards: Card[];
  cutCardRemaining: number;
  cutCardReached: boolean;
  lastHandPending: boolean;
};

type Hand = {
  cards: Card[];
  total: number;
};

const MASSACHUSETTS_CUT_CARD_MIN_REMAINING = 14;
const MASSACHUSETTS_CUT_CARD_MAX_REMAINING = 52;

const cardValueMap: Record<Card["rank"], number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 0,
  J: 0,
  Q: 0,
  K: 0,
};

export function buildShoe(deckCount = 8): Card[] {
  const shoe: Card[] = [];

  for (let i = 0; i < deckCount; i += 1) {
    for (const suit of suits) {
      for (const rank of ranks) {
        shoe.push({ suit, rank });
      }
    }
  }

  for (let i = shoe.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }

  return shoe;
}

function calculateTotal(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + cardValueMap[card.rank], 0) % 10;
}

function drawCard(shoe: Card[]): Card {
  const card = shoe.pop();

  if (!card) {
    throw new Error("Shoe is empty");
  }

  return card;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getBurnValue(card: Card) {
  if (card.rank === "A") {
    return 1;
  }

  if (["10", "J", "Q", "K"].includes(card.rank)) {
    return 10;
  }

  return Number(card.rank);
}

function burnInitialCards(cards: Card[]) {
  const burnCard = drawCard(cards);
  const extraBurnCount = Math.min(getBurnValue(burnCard), cards.length);

  for (let i = 0; i < extraBurnCount; i += 1) {
    drawCard(cards);
  }
}

function drawCardFromTableShoe(shoe: TableShoeState) {
  let cutCardAppeared = false;

  // Massachusetts uses a cut card near the back of the shoe. When it appears,
  // the current coup is completed, then one final hand is dealt before shuffling.
  if (!shoe.cutCardReached && shoe.cards.length === shoe.cutCardRemaining) {
    shoe.cutCardReached = true;
    cutCardAppeared = true;
  }

  return {
    card: drawCard(shoe.cards),
    cutCardAppeared,
  };
}

export function createMassachusettsShoeState(deckCount = 8): TableShoeState {
  const cards = buildShoe(deckCount);
  const cutCardRemaining = randomInt(
    MASSACHUSETTS_CUT_CARD_MIN_REMAINING,
    Math.min(MASSACHUSETTS_CUT_CARD_MAX_REMAINING, cards.length - 1),
  );

  burnInitialCards(cards);

  return {
    cards,
    cutCardRemaining,
    cutCardReached: false,
    lastHandPending: false,
  };
}

export function getMassachusettsCutCardConfig() {
  return {
    minRemaining: MASSACHUSETTS_CUT_CARD_MIN_REMAINING,
    maxRemaining: MASSACHUSETTS_CUT_CARD_MAX_REMAINING,
  };
}

function shouldBankerDraw(bankerTotal: number, playerThirdCard: Card | null): boolean {
  if (!playerThirdCard) {
    return bankerTotal <= 5;
  }

  const playerThirdValue = cardValueMap[playerThirdCard.rank];

  if (bankerTotal <= 2) {
    return true;
  }

  if (bankerTotal === 3) {
    return playerThirdValue !== 8;
  }

  if (bankerTotal === 4) {
    return playerThirdValue >= 2 && playerThirdValue <= 7;
  }

  if (bankerTotal === 5) {
    return playerThirdValue >= 4 && playerThirdValue <= 7;
  }

  if (bankerTotal === 6) {
    return playerThirdValue === 6 || playerThirdValue === 7;
  }

  return false;
}

export function dealRoundFromShoe(shoe: TableShoeState) {
  let cutCardAppeared = false;
  const draw = () => {
    const result = drawCardFromTableShoe(shoe);

    if (result.cutCardAppeared) {
      cutCardAppeared = true;
    }

    return result.card;
  };

  const playerCards = [draw(), draw()];
  const bankerCards = [draw(), draw()];

  let playerHand: Hand = {
    cards: playerCards,
    total: calculateTotal(playerCards),
  };
  let bankerHand: Hand = {
    cards: bankerCards,
    total: calculateTotal(bankerCards),
  };

  const natural = playerHand.total >= 8 || bankerHand.total >= 8;
  let playerThirdCard: Card | null = null;

  if (!natural) {
    if (playerHand.total <= 5) {
      playerThirdCard = draw();
      playerHand = {
        cards: [...playerHand.cards, playerThirdCard],
        total: calculateTotal([...playerHand.cards, playerThirdCard]),
      };
    }

    if (shouldBankerDraw(bankerHand.total, playerThirdCard)) {
      const bankerThirdCard = draw();
      bankerHand = {
        cards: [...bankerHand.cards, bankerThirdCard],
        total: calculateTotal([...bankerHand.cards, bankerThirdCard]),
      };
    }
  }

  let winner: RoundWinner = "TIE";

  if (playerHand.total > bankerHand.total) {
    winner = "PLAYER";
  } else if (bankerHand.total > playerHand.total) {
    winner = "BANKER";
  }

  return {
    playerCards: playerHand.cards,
    bankerCards: bankerHand.cards,
    playerTotal: playerHand.total,
    bankerTotal: bankerHand.total,
    winner,
    playerPair: playerCards[0]?.rank === playerCards[1]?.rank,
    bankerPair: bankerCards[0]?.rank === bankerCards[1]?.rank,
    cutCardAppeared,
  };
}

export function dealRound() {
  return dealRoundFromShoe(createMassachusettsShoeState());
}

export function calculatePayout(
  betType: BetType,
  amount: number,
  result: { winner: RoundWinner; playerPair: boolean; bankerPair: boolean },
) {
  if (betType === "PLAYER") {
    if (result.winner === "TIE") {
      return amount;
    }

    return result.winner === "PLAYER" ? amount * 2 : 0;
  }

  if (betType === "BANKER") {
    if (result.winner === "TIE") {
      return amount;
    }

    return result.winner === "BANKER" ? amount + Math.floor(amount * 0.95) : 0;
  }

  if (betType === "PLAYER_PAIR") {
    return result.playerPair ? amount * 12 : 0;
  }

  if (betType === "BANKER_PAIR") {
    return result.bankerPair ? amount * 12 : 0;
  }

  return result.winner === "TIE" ? amount * 9 : 0;
}
