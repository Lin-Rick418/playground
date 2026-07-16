import assert from "node:assert/strict";
import test from "node:test";
import { dealRoundFromShoe } from "./baccarat.js";
import {
  createShoeCommitment,
  createShoeFromSeed,
  generateShoeSeed,
  SHOE_AUDIT_VERSION,
  SHOE_DEAL_ALGORITHM,
  SHOE_DECK_COUNT,
  SHOE_SHUFFLE_ALGORITHM,
  toPublicShoeAudit,
  verifyShoeAudit,
  type AuditedRoundResult,
  type ShoeAuditBundle,
} from "./shoe-audit.js";

const fixedSeed = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

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

function buildRevealedBundle(): ShoeAuditBundle {
  const shoeId = "shoe-fixed";
  const tableId = "table-fixed";
  const reconstructed = createShoeFromSeed(fixedSeed).shoe;
  const deals = [];

  for (let dealIndex = 0; ; dealIndex += 1) {
    const wasLastHand = reconstructed.lastHandPending;
    const before = [...reconstructed.cards];
    const result = dealRoundFromShoe(reconstructed);
    deals.push({
      dealIndex,
      roundId: `round-${dealIndex}`,
      dealtCards: before.slice().reverse().slice(0, before.length - reconstructed.cards.length),
      result: auditedResult(result),
      recordedAt: `2026-01-01T00:00:0${dealIndex}.000Z`,
    });

    if (wasLastHand) break;
    if (result.cutCardAppeared) reconstructed.lastHandPending = true;
  }

  return {
    version: SHOE_AUDIT_VERSION,
    shoeId,
    tableId,
    shuffleAlgorithm: SHOE_SHUFFLE_ALGORITHM,
    dealAlgorithm: SHOE_DEAL_ALGORITHM,
    deckCount: SHOE_DECK_COUNT,
    commitment: createShoeCommitment({ shoeId, tableId, seed: fixedSeed }),
    cutCardRemaining: createShoeFromSeed(fixedSeed).shoe.cutCardRemaining,
    committedAt: "2026-01-01T00:00:00.000Z",
    reveal: {
      seed: fixedSeed,
      reason: "CUT_CARD_LAST_HAND",
      revealedAt: "2026-01-01T01:00:00.000Z",
    },
    deals,
  };
}

test("reconstructs a stable shoe and commitment from the published algorithm", () => {
  const first = createShoeFromSeed(fixedSeed);
  const second = createShoeFromSeed(fixedSeed);

  assert.deepEqual(first, second);
  assert.equal(first.shoe.cutCardRemaining, 39);
  assert.deepEqual(first.burnedCards.slice(0, 3), [
    { suit: "S", rank: "9" },
    { suit: "H", rank: "8" },
    { suit: "C", rank: "J" },
  ]);
  assert.deepEqual(first.shoe.cards.slice().reverse().slice(0, 4), [
    { suit: "S", rank: "10" },
    { suit: "D", rank: "10" },
    { suit: "D", rank: "9" },
    { suit: "D", rank: "4" },
  ]);
  assert.equal(
    createShoeCommitment({ shoeId: "shoe-fixed", tableId: "table-fixed", seed: fixedSeed }),
    "960bddc1c2ed9127e3468ba0e2b7e19247d42e88b77d558768527326ec513364",
  );
});

test("generates independent 256-bit production seeds", () => {
  const first = generateShoeSeed();
  const second = generateShoeSeed();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test("verifies commitment, dealt-card sequence, and round results", () => {
  const bundle = buildRevealedBundle();
  assert.deepEqual(verifyShoeAudit(bundle), {
    valid: true,
    status: "VALID",
    commitmentValid: true,
    dealSequenceValid: true,
    lifecycleValid: true,
    verifiedDeals: bundle.deals.length,
    verifiedCards: bundle.deals.reduce((total, deal) => total + deal.dealtCards.length, 0),
    remainingCards: createShoeFromSeed(fixedSeed).shoe.cards.length - bundle.deals.reduce((total, deal) => total + deal.dealtCards.length, 0),
    errors: [],
  });
});

test("rejects a changed seed, card, result, or non-contiguous deal index", () => {
  const seedTamper = buildRevealedBundle();
  seedTamper.reveal!.seed = "f".repeat(64);
  assert.equal(verifyShoeAudit(seedTamper).commitmentValid, false);

  const cardTamper = buildRevealedBundle();
  cardTamper.deals[1].dealtCards[0] = { suit: "S", rank: "A" };
  assert.equal(verifyShoeAudit(cardTamper).dealSequenceValid, false);

  const resultTamper = buildRevealedBundle();
  resultTamper.deals[0].result.playerTotal = (resultTamper.deals[0].result.playerTotal + 1) % 10;
  assert.equal(verifyShoeAudit(resultTamper).dealSequenceValid, false);

  const indexTamper = buildRevealedBundle();
  indexTamper.deals[1].dealIndex = 4;
  assert.equal(verifyShoeAudit(indexTamper).dealSequenceValid, false);
});

test("rejects swapped player and banker hands even when recomputed fields are internally consistent", () => {
  const bundle = buildRevealedBundle();
  const original = bundle.deals[0].result;
  const playerTotal = original.bankerTotal;
  const bankerTotal = original.playerTotal;
  bundle.deals[0].result = {
    playerCards: original.bankerCards,
    bankerCards: original.playerCards,
    playerTotal,
    bankerTotal,
    winner: playerTotal === bankerTotal ? "TIE" : playerTotal > bankerTotal ? "PLAYER" : "BANKER",
    playerPair: original.bankerPair,
    bankerPair: original.playerPair,
  };

  const verification = verifyShoeAudit(bundle);
  assert.equal(verification.valid, false);
  assert.equal(verification.dealSequenceValid, false);
  assert.match(verification.errors.join(" "), /versioned deal replay/);
});

test("rejects empty, truncated, and abnormally rotated audit lifecycles", () => {
  const empty = buildRevealedBundle();
  empty.deals = [];
  assert.equal(verifyShoeAudit(empty).lifecycleValid, false);

  const prefix = buildRevealedBundle();
  prefix.deals = prefix.deals.slice(0, -1);
  assert.equal(verifyShoeAudit(prefix).lifecycleValid, false);

  const cancelled = buildRevealedBundle();
  cancelled.reveal!.reason = "MANUAL_ROTATION";
  const verification = verifyShoeAudit(cancelled);
  assert.equal(verification.valid, false);
  assert.equal(verification.status, "CANCELLED");
  assert.equal(verification.lifecycleValid, false);
});

test("never verifies or exposes proof before reveal", () => {
  const bundle = buildRevealedBundle();
  bundle.reveal = null;
  const result = verifyShoeAudit(bundle);
  assert.equal(result.valid, false);
  assert.equal(result.status, "UNREVEALED");
  assert.match(result.errors[0], /not been revealed/);

  const response = toPublicShoeAudit(bundle);
  assert.equal(response.reveal, null);
  assert.equal(response.verification, null);
  assert.equal(response.cutCardRemaining, null);
  assert.equal(JSON.stringify(response).includes(fixedSeed), false);
});
