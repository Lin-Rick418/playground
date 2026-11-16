import { randomInt } from "node:crypto";
import {
  STORM_PAY,
  isStormStake,
  fromMinorUnits,
  toMinorUnits,
  roundHalfUp,
  type StormProgress,
  type StormSpinResult,
  type StormSymbol,
  type StormTile,
} from "@baccarat/contracts";

// Immutable balanced model. Any change to probabilities or arithmetic requires
// a new model revision and new calibration; v1 remains in math.ts.
export const MODEL_REVISION = "balanced-2.0";
export const BALANCED_WEIGHTS: readonly [StormSymbol, number][] = [
  ["ruby", 115],
  ["emerald", 125],
  ["sapphire", 170],
  ["amber", 195],
  ["lotus", 120],
  ["scarab", 165],
  ["sun", 20],
  ["moon", 20],
  ["gold", 1],
  ["scatter", 25],
  ["orb", 44],
];
export type BalancedProfile = { payoutScale: number; maxWinFactor: number };
export const SCALE_DENOMINATOR = 1_000_000;
export const MAX_FREE_SPINS = 30;
type Random = () => number;
const random: Random = () => randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1);

export function spinBalanced(
  state: StormProgress & { balance: number },
  stake: number,
  profile: BalancedProfile,
  rng: Random = random,
  captureFrames = true,
): StormSpinResult {
  if (
    !isStormStake(stake) ||
    !Number.isSafeInteger(profile.payoutScale) ||
    profile.payoutScale < 1 ||
    profile.payoutScale > 10_000_000 ||
    !Number.isInteger(profile.maxWinFactor) ||
    profile.maxWinFactor < 100 ||
    profile.maxWinFactor > 25000
  )
    throw new RangeError("Invalid balanced Storm configuration");
  const wasFree = state.freeLeft > 0;
  const cost = wasFree ? 0 : stake;
  if (state.balance < cost) throw new RangeError("Insufficient balance");
  const stakeMinor = toMinorUnits(stake);
  const previousCycle = wasFree ? toMinorUnits(state.cycleWin ?? 0) : 0n;
  const remainingCap = stakeMinor * BigInt(profile.maxWinFactor) - previousCycle;
  if (remainingCap < 0n) throw new RangeError("Invalid cycle liability");
  let id = 0;
  function draw(): StormTile {
    let pick = Math.floor(rng() * 1000);
    for (const [kind, weight] of BALANCED_WEIGHTS) {
      pick -= weight;
      if (pick < 0) {
        if (kind !== "orb") return { id: ++id, kind };
        const roll = Math.floor(rng() * 1000);
        return { id: ++id, kind, value: roll < 750 ? 2 : roll < 950 ? 3 : roll < 995 ? 5 : 10 };
      }
    }
    throw new RangeError("RNG outside [0,1)");
  }
  // Free mode has an explicit 1/3 base-pay factor. Rounded display amounts
  // never feed back into arithmetic; only final settlement is rounded.
  const denominator = 10n * BigInt(SCALE_DENOMINATOR) * (wasFree ? 3n : 1n);
  const amount = (units: number) =>
    roundHalfUp(stakeMinor * BigInt(units) * BigInt(profile.payoutScale), denominator);
  let board = Array.from({ length: 30 }, draw);
  let baseUnits = 0,
    scatterMax = 0,
    bonusCount = 0,
    limited = false;
  const frames: StormSpinResult["frames"] = [];
  for (let step = 0; step <= 12; step++) {
    const counts: Partial<Record<StormSymbol, number>> = {};
    for (const tile of board) counts[tile.kind] = (counts[tile.kind] ?? 0) + 1;
    scatterMax = Math.max(scatterMax, counts.scatter ?? 0);
    if (!wasFree && (counts.scatter ?? 0) >= 4)
      bonusCount = Math.max(bonusCount, Math.min(4, counts.gold ?? 0));
    const kinds = Object.keys(STORM_PAY).filter(
      (kind) => (counts[kind as keyof typeof STORM_PAY] ?? 0) >= 8,
    ) as (keyof typeof STORM_PAY)[];
    if (!kinds.length || step === 12) {
      limited = step === 12 && kinds.length > 0;
      if (captureFrames) frames.push({ board: [...board], winners: [], groups: [], win: 0 });
      break;
    }
    let frameUnits = 0;
    const groups = kinds.map((kind) => {
      const count = counts[kind]!;
      const units = STORM_PAY[kind] * (count >= 12 ? 3 : count >= 10 ? 2 : 1);
      frameUnits += units;
      return { kind, count, win: captureFrames ? fromMinorUnits(amount(units)) : 0 };
    });
    baseUnits += frameUnits;
    const winners = board.flatMap((tile, index) =>
      kinds.includes(tile.kind as keyof typeof STORM_PAY) ? [index] : [],
    );
    if (captureFrames)
      frames.push({ board: [...board], groups, winners, win: fromMinorUnits(amount(frameUnits)) });
    const removed = new Set(winners);
    const next = [...board];
    for (let col = 0; col < 6; col++) {
      const slots = Array.from({ length: 5 }, (_, row) => row * 6 + col);
      const survivors = slots.filter((index) => !removed.has(index)).map((index) => board[index]);
      const added = Array.from({ length: 5 - survivors.length }, draw);
      [...added, ...survivors].forEach((tile, row) => {
        next[slots[row]] = tile;
      });
    }
    board = next;
  }
  const upgrades: StormSpinResult["upgrades"] = [];
  if (wasFree && baseUnits > 0) {
    board = board.map((tile) => {
      if (tile.kind !== "orb" || rng() >= (state.feature === "super" ? 0.2 : 0.1)) return tile;
      const value = tile.value! * 2;
      upgrades.push({ id: tile.id, from: tile.value!, to: value });
      return { ...tile, value };
    });
  }
  const collected = baseUnits > 0 ? board.reduce((sum, tile) => sum + (tile.value ?? 0), 0) : 0;
  const factor = collected ? Math.min(20, collected + (wasFree ? state.multiplier : 0)) : 1;
  const bonusUnits = wasFree ? 0 : [0, 20, 50, 100, 250][bonusCount];
  const raw = amount(baseUnits * factor + bonusUnits);
  const payoutMinor = raw < remainingCap ? raw : remainingCap;
  const capped = raw >= remainingCap;
  const payout = fromMinorUnits(payoutMinor);
  let freeLeft = wasFree ? state.freeLeft - 1 : 0;
  let freeGranted = wasFree ? state.freeGranted : 0;
  let awarded = 0;
  if (!capped && (wasFree ? scatterMax >= 3 : scatterMax >= 4)) {
    awarded = wasFree ? Math.min(3, MAX_FREE_SPINS - freeGranted) : 10;
    freeLeft += awarded;
    freeGranted += awarded;
  }
  if (capped) freeLeft = 0;
  return {
    state: {
      balance: fromMinorUnits(toMinorUnits(state.balance) - toMinorUnits(cost) + payoutMinor),
      freeLeft,
      freeGranted,
      feature: wasFree ? state.feature : bonusCount ? "super" : "normal",
      multiplier: wasFree ? Math.min(10, state.multiplier + collected) : 0,
      featureWin: wasFree ? fromMinorUnits(toMinorUnits(state.featureWin) + payoutMinor) : 0,
      cycleWin: fromMinorUnits(previousCycle + payoutMinor),
    },
    frames,
    board,
    payout,
    baseWin: fromMinorUnits(amount(baseUnits)),
    factor,
    collected,
    upgrades,
    awarded,
    wasFree,
    capped,
    bonusWin: fromMinorUnits(amount(bonusUnits)),
    bonusCount,
    cost,
    limited,
  };
}
