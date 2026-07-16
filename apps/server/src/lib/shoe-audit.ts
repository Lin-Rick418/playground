import { createHash, createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dealRoundFromShoe, type TableShoeState } from "./baccarat.js";
import type { Card, RoundWinner } from "../types/domain.js";

export const SHOE_AUDIT_VERSION = 1;
export const SHOE_SHUFFLE_ALGORITHM = "hmac-sha256-fisher-yates-v1";
export const SHOE_DEAL_ALGORITHM = "baccarat-round-v1";
export const SHOE_SEED_BYTES = 32;
export const SHOE_DECK_COUNT = 8;

const RANDOM_DOMAIN = Buffer.from("baccarat-shoe-audit/random/v1\0", "utf8");
const CUT_CARD_MIN_REMAINING = 14;
const CUT_CARD_MAX_REMAINING = 52;
const suits = ["S", "H", "D", "C"] as const satisfies readonly Card["suit"][];
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const satisfies readonly Card["rank"][];

function validateSeed(seed: string) {
  if (!/^[0-9a-f]{64}$/.test(seed)) {
    throw new Error("Shoe seed must be 32 bytes encoded as lowercase hex");
  }
}

function validateDeckCount(deckCount: number) {
  if (!Number.isSafeInteger(deckCount) || deckCount < 1 || deckCount > 32) {
    throw new Error("Deck count must be an integer between 1 and 32");
  }
}

export type AuditedRoundResult = {
  playerCards: Card[];
  bankerCards: Card[];
  playerTotal: number;
  bankerTotal: number;
  winner: RoundWinner;
  playerPair: boolean;
  bankerPair: boolean;
};

export type ShoeCommitmentRecord = {
  version: number;
  shoeId: string;
  tableId: string;
  shuffleAlgorithm: string;
  dealAlgorithm: string;
  deckCount: number;
  commitment: string;
  cutCardRemaining: number;
  committedAt: string;
};

export type ShoeDealAuditRecord = {
  dealIndex: number;
  roundId: string;
  dealtCards: Card[];
  result: AuditedRoundResult;
  recordedAt: string;
};

export type ShoeRevealRecord = {
  seed: string;
  reason: string;
  revealedAt: string;
};

export type ShoeAuditBundle = ShoeCommitmentRecord & {
  reveal: ShoeRevealRecord | null;
  deals: ShoeDealAuditRecord[];
};

export type ShoeAuditVerification = {
  valid: boolean;
  status: "VALID" | "INVALID" | "CANCELLED" | "UNREVEALED";
  commitmentValid: boolean;
  dealSequenceValid: boolean;
  lifecycleValid: boolean;
  verifiedDeals: number;
  verifiedCards: number;
  remainingCards: number;
  errors: string[];
};

class HmacCounterRandom {
  private readonly seed: Buffer;
  private counter = 0n;
  private buffered = Buffer.alloc(0);

  constructor(seedHex: string) {
    validateSeed(seedHex);
    this.seed = Buffer.from(seedHex, "hex");
  }

  private nextBlock() {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(this.counter);
    this.counter += 1n;
    return createHmac("sha256", this.seed).update(RANDOM_DOMAIN).update(counter).digest();
  }

  private nextUInt32() {
    while (this.buffered.length < 4) {
      this.buffered = Buffer.concat([this.buffered, this.nextBlock()]);
    }

    const value = this.buffered.readUInt32BE(0);
    this.buffered = this.buffered.subarray(4);
    return value;
  }

  int(maxExclusive: number) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x1_0000_0000) {
      throw new Error("Deterministic random bound must be an integer between 1 and 2^32");
    }

    const range = 0x1_0000_0000;
    const acceptanceLimit = Math.floor(range / maxExclusive) * maxExclusive;

    while (true) {
      const candidate = this.nextUInt32();
      if (candidate < acceptanceLimit) {
        return candidate % maxExclusive;
      }
    }
  }
}

function buildOrderedShoe(deckCount: number) {
  validateDeckCount(deckCount);
  const cards: Card[] = [];
  for (let deck = 0; deck < deckCount; deck += 1) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ suit, rank });
      }
    }
  }
  return cards;
}

function burnValue(card: Card) {
  if (card.rank === "A") return 1;
  if (["10", "J", "Q", "K"].includes(card.rank)) return 10;
  return Number(card.rank);
}

export function generateShoeSeed() {
  return randomBytes(SHOE_SEED_BYTES).toString("hex");
}

export function createShoeFromSeed(seed: string, deckCount = SHOE_DECK_COUNT) {
  const random = new HmacCounterRandom(seed);
  const cards = buildOrderedShoe(deckCount);

  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = random.int(index + 1);
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }

  const cutMaximum = Math.min(CUT_CARD_MAX_REMAINING, cards.length - 1);
  const cutCardRemaining = CUT_CARD_MIN_REMAINING + random.int(cutMaximum - CUT_CARD_MIN_REMAINING + 1);
  const burnedCards: Card[] = [];
  const burnCard = cards.pop();
  if (!burnCard) throw new Error("Cannot burn from an empty shoe");
  burnedCards.push(burnCard);

  const extraBurnCount = Math.min(burnValue(burnCard), cards.length);
  for (let index = 0; index < extraBurnCount; index += 1) {
    const card = cards.pop();
    if (!card) throw new Error("Shoe ended during burn");
    burnedCards.push(card);
  }

  const shoe: TableShoeState = {
      cards,
      cutCardRemaining,
      cutCardReached: false,
      lastHandPending: false,
  };

  return {
    shoe,
    burnedCards,
  };
}

export function canonicalShoeCommitment(input: {
  shoeId: string;
  tableId: string;
  seed: string;
  deckCount?: number;
}) {
  const deckCount = input.deckCount ?? SHOE_DECK_COUNT;
  validateSeed(input.seed);
  validateDeckCount(deckCount);
  if (!input.shoeId || !input.tableId) throw new Error("Shoe and table identifiers are required");
  return JSON.stringify([
    "baccarat-shoe-audit",
    SHOE_AUDIT_VERSION,
    SHOE_SHUFFLE_ALGORITHM,
    SHOE_DEAL_ALGORITHM,
    input.shoeId,
    input.tableId,
    deckCount,
    input.seed,
  ]);
}

export function createShoeCommitment(input: {
  shoeId: string;
  tableId: string;
  seed: string;
  deckCount?: number;
}) {
  return createHash("sha256").update(canonicalShoeCommitment(input), "utf8").digest("hex");
}

function auditedResult(result: ReturnType<typeof dealRoundFromShoe>): AuditedRoundResult {
  return {
    playerCards: result.playerCards,
    bankerCards: result.bankerCards,
    playerTotal: result.playerTotal,
    bankerTotal: result.bankerTotal,
    winner: result.winner,
    playerPair: result.playerPair,
    bankerPair: result.bankerPair,
  };
}

function replayVersionedDeal(dealAlgorithm: string, shoe: TableShoeState) {
  if (dealAlgorithm !== SHOE_DEAL_ALGORITHM) {
    throw new Error(`Unsupported deal algorithm: ${dealAlgorithm}`);
  }

  return dealRoundFromShoe(shoe);
}

export function verifyShoeAudit(bundle: ShoeAuditBundle): ShoeAuditVerification {
  const errors: string[] = [];
  let commitmentValid = false;
  let dealSequenceValid = true;
  let lifecycleValid = false;
  let verifiedCards = 0;
  let verifiedDeals = 0;
  let remainingCards = 0;

  if (!bundle.reveal) {
    return {
      valid: false,
      status: "UNREVEALED",
      commitmentValid: false,
      dealSequenceValid: false,
      lifecycleValid: false,
      verifiedDeals: 0,
      verifiedCards: 0,
      remainingCards: 0,
      errors: ["Shoe seed has not been revealed"],
    };
  }

  try {
    if (
      bundle.version !== SHOE_AUDIT_VERSION ||
      bundle.shuffleAlgorithm !== SHOE_SHUFFLE_ALGORITHM ||
      bundle.dealAlgorithm !== SHOE_DEAL_ALGORITHM
    ) {
      errors.push("Unsupported shoe audit algorithm or version");
    }

    const expectedCommitment = createShoeCommitment({
      shoeId: bundle.shoeId,
      tableId: bundle.tableId,
      seed: bundle.reveal.seed,
      deckCount: bundle.deckCount,
    });
    commitmentValid = expectedCommitment === bundle.commitment;
    if (!commitmentValid) errors.push("Seed and metadata do not match the pre-deal commitment");

    const reconstructed = createShoeFromSeed(bundle.reveal.seed, bundle.deckCount).shoe;
    const initialCardCount = reconstructed.cards.length;
    if (reconstructed.cutCardRemaining !== bundle.cutCardRemaining) {
      dealSequenceValid = false;
      errors.push("Reconstructed cut-card position does not match committed metadata");
    }

    let terminalHandCompleted = false;
    for (let index = 0; index < bundle.deals.length; index += 1) {
      const auditDeal = bundle.deals[index];
      if (auditDeal.dealIndex !== index) {
        dealSequenceValid = false;
        errors.push(`Deal index ${auditDeal.dealIndex} is not contiguous at position ${index}`);
        break;
      }

      if (terminalHandCompleted) {
        dealSequenceValid = false;
        errors.push(`Deal ${index} was appended after the terminal hand`);
        break;
      }

      const wasLastHand = reconstructed.lastHandPending;
      const cardsBeforeDeal = reconstructed.cards.slice();
      const replayed = replayVersionedDeal(bundle.dealAlgorithm, reconstructed);
      const expectedCards = cardsBeforeDeal
        .slice()
        .reverse()
        .slice(0, cardsBeforeDeal.length - reconstructed.cards.length);
      if (!isDeepStrictEqual(expectedCards, auditDeal.dealtCards)) {
        dealSequenceValid = false;
        errors.push(`Deal ${index} card sequence does not match the committed shoe`);
        break;
      }

      if (!isDeepStrictEqual(auditedResult(replayed), auditDeal.result)) {
        dealSequenceValid = false;
        errors.push(`Deal ${index} result does not match the versioned deal replay`);
        break;
      }

      verifiedCards += expectedCards.length;
      verifiedDeals += 1;

      if (wasLastHand) {
        terminalHandCompleted = true;
      } else if (replayed.cutCardAppeared) {
        reconstructed.lastHandPending = true;
      }
    }

    remainingCards = initialCardCount - verifiedCards;

    if (bundle.reveal.reason !== "CUT_CARD_LAST_HAND") {
      errors.push(`Reveal reason ${bundle.reveal.reason} marks this shoe as cancelled, not fairness-valid`);
    } else if (!terminalHandCompleted) {
      errors.push("Audit ends before the cut-card terminal hand is complete");
    } else if (dealSequenceValid) {
      lifecycleValid = true;
    }
  } catch (error) {
    dealSequenceValid = false;
    errors.push(error instanceof Error ? error.message : "Unknown verification failure");
  }

  const valid = commitmentValid && dealSequenceValid && lifecycleValid && errors.length === 0;
  return {
    valid,
    status: valid ? "VALID" : bundle.reveal.reason === "CUT_CARD_LAST_HAND" ? "INVALID" : "CANCELLED",
    commitmentValid,
    dealSequenceValid,
    lifecycleValid,
    verifiedDeals,
    verifiedCards,
    remainingCards,
    errors,
  };
}

export function toPublicShoeAudit(bundle: ShoeAuditBundle) {
  return {
    version: bundle.version,
    shoeId: bundle.shoeId,
    tableId: bundle.tableId,
    shuffleAlgorithm: bundle.shuffleAlgorithm,
    dealAlgorithm: bundle.dealAlgorithm,
    deckCount: bundle.deckCount,
    commitment: bundle.commitment,
    committedAt: bundle.committedAt,
    cutCardRemaining: bundle.reveal ? bundle.cutCardRemaining : null,
    reveal: bundle.reveal,
    deals: bundle.deals,
    verification: bundle.reveal ? verifyShoeAudit(bundle) : null,
  };
}
