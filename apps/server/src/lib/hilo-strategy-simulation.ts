import { toMinorUnits, type HiloChoice } from "@baccarat/contracts";
import {
  drawCard,
  INITIAL_RATIO,
  MAX_SKIPS,
  nextRatio,
  payout,
  rank,
  winningRanks,
  wins,
  withinLimit,
} from "../modules/hilo/math.js";

export const STRATEGY_BET = 100;
export const STRATEGY_TARGET = 50n;

export function strategyChoice(card: number): HiloChoice | null {
  const value = rank(card);
  if (value === 1) return "higher";
  if (value <= 3) return "higher_or_equal";
  if (value === 13) return "lower";
  if (value >= 11) return "lower_or_equal";
  return null;
}

/** Pure in-memory simulation: no API requests, database writes, or wallet mutations. */
export function simulateStrategyRound(draw: () => number = drawCard, target = STRATEGY_TARGET) {
  if (target < 1n) throw new RangeError("Cashout target must be at least 1x");
  let card = draw();
  let previewRefreshes = 0;
  // The real game permits unlimited free preview changes before placing a bet.
  while (strategyChoice(card) === null) {
    card = draw();
    previewRefreshes++;
  }
  let ratio = INITIAL_RATIO;
  let guesses = 0;
  let skips = 0;
  const result = (reason: "lost" | "target_cashout" | "skip_limit_cashout") => ({
    reason,
    payoutCents: reason === "lost" ? 0n : toMinorUnits(payout(STRATEGY_BET, ratio)),
    guesses,
    skips,
    previewRefreshes,
  });
  while (true) {
    const choice = strategyChoice(card);
    if (choice === null) {
      // Starting on a permitted card guarantees at least one success if still alive here.
      if (skips === MAX_SKIPS) return result("skip_limit_cashout");
      card = draw();
      skips++;
      continue;
    }
    const next = nextRatio(ratio, winningRanks(card, choice));
    if (!withinLimit(next)) throw new Error("Strategy unexpectedly exceeded the game cap");
    const nextCard = draw();
    guesses++;
    if (!wins(card, nextCard, choice)) return result("lost");
    ratio = next;
    card = nextCard;
    // Strictly above the target, using the exact ratio, never the rounded display value.
    if (ratio.numerator > target * ratio.denominator) return result("target_cashout");
  }
}

export function simulateStrategy(rounds: number, target = STRATEGY_TARGET) {
  if (!Number.isSafeInteger(rounds) || rounds < 2)
    throw new RangeError("At least 2 rounds required");
  const outcomes = { lost: 0, target_cashout: 0, skip_limit_cashout: 0 };
  let payoutCents = 0n;
  let squaredPayoutCents = 0n;
  let guesses = 0;
  let skips = 0;
  let previewRefreshes = 0;
  let maxPayoutCents = 0n;
  for (let index = 0; index < rounds; index++) {
    const round = simulateStrategyRound(drawCard, target);
    outcomes[round.reason]++;
    payoutCents += round.payoutCents;
    squaredPayoutCents += round.payoutCents ** 2n;
    maxPayoutCents = round.payoutCents > maxPayoutCents ? round.payoutCents : maxPayoutCents;
    guesses += round.guesses;
    skips += round.skips;
    previewRefreshes += round.previewRefreshes;
  }
  const betCents = toMinorUnits(STRATEGY_BET);
  const totalBetCents = BigInt(rounds) * betCents;
  const mean = Number(payoutCents) / rounds;
  const variance = (Number(squaredPayoutCents) - rounds * mean ** 2) / (rounds - 1);
  const rtpPercent = (Number(payoutCents) / Number(totalBetCents)) * 100;
  const standardErrorPp = (Math.sqrt(variance / rounds) / Number(betCents)) * 100;
  return {
    rounds,
    betPerRound: STRATEGY_BET,
    targetMultiplierExclusive: Number(target),
    maxSkipsPerRound: MAX_SKIPS,
    rng: "production drawCard: crypto.randomInt(52), independent with replacement",
    startingCard: "Free preview changes until A/2/3/J/Q/K, then bet",
    skipLimitPolicy: "Cash out at current exact multiplier when no strategy choice remains",
    theoreticalRtpPercentBeforeCentRounding: 94,
    totalBetCents: totalBetCents.toString(),
    totalPayoutCents: payoutCents.toString(),
    playerNetCents: (payoutCents - totalBetCents).toString(),
    rtpPercent,
    standardErrorPercentagePoints: standardErrorPp,
    approximate95PercentInterval: [
      rtpPercent - 1.96 * standardErrorPp,
      rtpPercent + 1.96 * standardErrorPp,
    ],
    outcomes,
    unfinishedRounds: 0,
    guesses,
    skips,
    previewRefreshes,
    maxPayoutCents: maxPayoutCents.toString(),
  };
}
