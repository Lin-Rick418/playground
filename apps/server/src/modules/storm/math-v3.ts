import { randomInt } from "node:crypto";
import {
  type StormSettings,
  STORM_MAX_PAYOUT_SCALE,
  isStormStake,
  fromMinorUnits,
  toMinorUnits,
  roundHalfUp,
  type StormProgress,
  type StormSpinResult,
  type StormSymbol,
  type StormTile,
} from "@baccarat/contracts";

export const CONFIGURABLE_MODEL_REVISION = "configurable-3.0";
export type ConfigurableProfile = {
  payoutScale: number;
  maxWinFactor: number;
  settings: StormSettings;
};
type Random = () => number;
const random: Random = () => randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1);

// Compile a validated immutable profile once for an offline run.
export function configuredSpinner(profile: ConfigurableProfile) {
  const config = profile.settings;
  const weights = Object.entries(config.symbolWeights) as [StormSymbol, number][];
  const orbWeights = Object.entries(config.orbWeights).map(([value, weight]) => [
    Number(value),
    weight,
  ]);
  const payKinds = Object.keys(config.paytable) as (keyof typeof config.paytable)[];
  return function spinConfigured(
    state: StormProgress & { balance: number },
    stake: number,
    rng: Random = random,
    captureFrames = true,
  ): StormSpinResult {
    if (
      !isStormStake(stake) ||
      !Number.isSafeInteger(profile.payoutScale) ||
      profile.payoutScale < 0 ||
      profile.payoutScale > STORM_MAX_PAYOUT_SCALE ||
      !Number.isInteger(profile.maxWinFactor) ||
      profile.maxWinFactor < 100 ||
      profile.maxWinFactor > 25000
    )
      throw new RangeError("Invalid Storm profile");
    const wasFree = state.freeLeft > 0;
    const cost = wasFree ? 0 : stake;
    if (state.balance < cost) throw new RangeError("Insufficient balance");
    const stakeMinor = toMinorUnits(stake);
    const previousCycle = wasFree ? toMinorUnits(state.cycleWin ?? 0) : 0n;
    const remainingCap =
      stakeMinor * BigInt(profile.maxWinFactor) -
      (config.capScope === "cycle" ? previousCycle : 0n);
    if (remainingCap < 0n) throw new RangeError("Invalid cycle liability");
    let id = 0;
    function draw(): StormTile {
      let pick = Math.floor(rng() * 10000);
      for (const [kind, weight] of weights) {
        pick -= weight;
        if (pick < 0) {
          if (kind !== "orb") return { id: ++id, kind };
          let roll = Math.floor(rng() * 10000);
          for (const [value, weight] of orbWeights) {
            roll -= weight;
            if (roll < 0) return { id: ++id, kind, value };
          }
          throw new RangeError("RNG outside [0,1)");
        }
      }
      throw new RangeError("RNG outside [0,1)");
    }
    // Free mode uses the configured base-pay divisor. Rounded display amounts
    // never feed back into arithmetic; only final settlement is rounded.
    const denominator = 100n * 1_000_000n * (wasFree ? BigInt(config.freePayDivisor) : 1n);
    const amount = (units: number) =>
      roundHalfUp(stakeMinor * BigInt(units) * BigInt(profile.payoutScale), denominator);
    let board = Array.from({ length: 30 }, draw);
    let baseUnits = 0,
      scatterMax = 0,
      bonusCount = 0,
      limited = false;
    const frames: StormSpinResult["frames"] = [];
    for (let step = 0; step <= config.maxCascades; step++) {
      const counts: Partial<Record<StormSymbol, number>> = {};
      for (const tile of board) counts[tile.kind] = (counts[tile.kind] ?? 0) + 1;
      scatterMax = Math.max(scatterMax, counts.scatter ?? 0);
      if (!wasFree && (counts.scatter ?? 0) >= config.scatterTrigger)
        bonusCount = Math.max(bonusCount, Math.min(4, counts.gold ?? 0));
      const kinds = payKinds.filter((kind) => (counts[kind] ?? 0) >= 8);
      if (!kinds.length || step === config.maxCascades) {
        limited = step === config.maxCascades && kinds.length > 0;
        if (captureFrames) frames.push({ board: [...board], winners: [], groups: [], win: 0 });
        break;
      }
      let frameUnits = 0;
      const groups = kinds.map((kind) => {
        const count = counts[kind]!;
        const units =
          config.paytable[kind] *
          (count >= 12 ? config.count12Factor : count >= 10 ? config.count10Factor : 1);
        frameUnits += units;
        return { kind, count, win: captureFrames ? fromMinorUnits(amount(units)) : 0 };
      });
      baseUnits += frameUnits;
      const winners = board.flatMap((tile, index) =>
        kinds.includes(tile.kind as keyof typeof config.paytable) ? [index] : [],
      );
      if (captureFrames)
        frames.push({
          board: [...board],
          groups,
          winners,
          win: fromMinorUnits(amount(frameUnits)),
        });
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
        if (tile.kind !== "orb") return tile;
        let value = tile.value!;
        const chance =
          (state.feature === "super" ? config.superUpgradeChance : config.normalUpgradeChance) /
          10000;
        while (value < config.orbMax && rng() < chance) {
          const next = Math.min(config.orbMax, value * 2);
          upgrades.push({ id: tile.id, from: value, to: next });
          value = next;
          if (config.upgradeMode === "once") break;
        }
        return { ...tile, value };
      });
    }
    const collected = baseUnits > 0 ? board.reduce((sum, tile) => sum + (tile.value ?? 0), 0) : 0;
    const factor = collected
      ? Math.min(config.factorCap, collected + (wasFree ? state.multiplier : 0))
      : 1;
    const bonusUnits = wasFree ? 0 : [0, ...config.superBonus][bonusCount];
    const raw = amount(baseUnits * factor + bonusUnits);
    const payoutMinor = raw < remainingCap ? raw : remainingCap;
    const capped = raw >= remainingCap;
    const payout = fromMinorUnits(payoutMinor);
    let freeLeft = wasFree ? state.freeLeft - 1 : 0;
    let freeGranted = wasFree ? state.freeGranted : 0;
    let awarded = 0;
    if (
      !capped &&
      (wasFree ? scatterMax >= config.scatterRetrigger : scatterMax >= config.scatterTrigger)
    ) {
      awarded = wasFree
        ? Math.min(config.freeRetrigger, config.freeMax - freeGranted)
        : config.freeInitial;
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
        multiplier: wasFree ? Math.min(config.accumulatorCap, state.multiplier + collected) : 0,
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
  };
}
