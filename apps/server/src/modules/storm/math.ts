import { randomInt } from "node:crypto";
import {
  sumMoney,
  isStormStake,
  STORM_PAY as PAY,
  type StormTile as Tile,
  type StormSymbol as SymbolKind,
  type StormProgress,
  type StormSpinResult as SpinResult,
} from "@baccarat/contracts";
export type {
  StormTile as Tile,
  StormSymbol as SymbolKind,
  StormSpinResult as SpinResult,
} from "@baccarat/contracts";
export type DemoState = StormProgress & { balance: number };
export type Feature = StormProgress["feature"];
export type Frame = SpinResult["frames"][number];
export type WinGroup = Frame["groups"][number];
export const secureRandom = () => randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1);
export const initialState = (): DemoState => ({
  balance: 0,
  freeLeft: 0,
  freeGranted: 0,
  feature: "normal",
  multiplier: 0,
  featureWin: 0,
});
let nextId = 1;
export const tile = (kind: SymbolKind, value?: number): Tile => ({
  id: nextId++,
  kind,
  ...(value === undefined ? {} : { value }),
});
type Random = () => number;
export const WEIGHTS: [SymbolKind, number][] = [
  ["ruby", 12],
  ["emerald", 13],
  ["sapphire", 16],
  ["amber", 17],
  ["lotus", 14],
  ["scarab", 15],
  ["gold", 1],
  ["sun", 3],
  ["moon", 3],
  ["scatter", 3],
  ["orb", 3],
];
function randomTile(rng: Random): Tile {
  let pick = rng() * 100;
  for (const [kind, weight] of WEIGHTS) {
    pick -= weight;
    if (pick < 0)
      return tile(kind, kind === "orb" ? [2, 3, 5, 10][Math.floor(rng() * 4)] : undefined);
  }
  return tile("scarab");
}
export function makeBoard(rng: Random = secureRandom): Tile[] {
  return Array.from({ length: 30 }, () => randomTile(rng));
}
export function evaluate(board: Tile[], stake: number) {
  const winners: number[] = [];
  const groups: WinGroup[] = [];
  for (const [kind, pay] of Object.entries(PAY)) {
    const matches = board.flatMap((t, i) => (t.kind === kind ? [i] : []));
    if (matches.length < 8) continue;
    const win =
      Math.round((stake * pay) / 10) * (matches.length >= 12 ? 3 : matches.length >= 10 ? 2 : 1);
    groups.push({ kind: kind as SymbolKind, count: matches.length, win });
    winners.push(...matches);
  }
  return { win: groups.reduce((n, g) => n + g.win, 0), winners, groups };
}
export function tumble(board: Tile[], winners: number[], rng: Random): Tile[] {
  const removed = new Set(winners);
  const next = [...board];
  for (let col = 0; col < 6; col++) {
    const slots = Array.from({ length: 5 }, (_, row) => row * 6 + col);
    const survivors = slots.filter((i) => !removed.has(i)).map((i) => board[i]);
    const added = Array.from({ length: 5 - survivors.length }, () => randomTile(rng));
    [...added, ...survivors].forEach((t, i) => {
      next[slots[i]] = t;
    });
  }
  return next;
}
// Deterministic fixtures are test helpers only; the service never accepts a board from a client.
export function showcaseBoard(value = 5): Tile[] {
  const kinds: SymbolKind[] = [
    "ruby",
    "sun",
    "moon",
    "ruby",
    "orb",
    "ruby",
    "sun",
    "ruby",
    "ruby",
    "moon",
    "ruby",
    "ruby",
    "moon",
    "ruby",
    "sun",
    "emerald",
    "sapphire",
    "amber",
    "lotus",
    "scarab",
    "emerald",
    "sapphire",
    "amber",
    "lotus",
    "scarab",
    "emerald",
    "sapphire",
    "amber",
    "lotus",
    "scarab",
  ];
  return kinds.map((k) => tile(k, k === "orb" ? value : undefined));
}
export function enterFeature(state: DemoState, feature: Feature = "normal"): DemoState {
  return { ...state, freeLeft: 15, freeGranted: 15, feature, multiplier: 0, featureWin: 0 };
}
// Public rules: https://gameresource3.rsg-games.com/WebUI3/help/PowerOfThor2/help.html?lang=zh-TW
// Symbol weights, upgrade odds and doubling increments remain original demo assumptions.
export const MAX_WIN_FACTOR = 25000;
export const SUPER_BONUS = [0, 100, 500, 5000, 25000] as const;
export function bonusShowcase(count: number): Tile[] {
  if (![1, 2, 3, 4].includes(count)) throw new Error("無效的超級符號數量");
  const kinds: SymbolKind[] = ["ruby", "emerald", "sapphire", "amber", "lotus", "scarab"];
  const board = Array.from({ length: 30 }, (_, i) => tile(kinds[i % 6]));
  for (let i = 0; i < 4; i++) board[i] = tile("scatter");
  for (let i = 0; i < count; i++) board[6 + i] = tile("gold");
  return board;
}
export function spin(
  state: DemoState,
  stake: number,
  rng: Random = secureRandom,
  fixture?: Tile[],
  options: { showcase?: boolean; godly?: boolean } = {},
): SpinResult {
  if (!isStormStake(stake)) throw new Error("無效的投注額");
  const wasFree = state.freeLeft > 0;
  const cost = wasFree || options.showcase ? 0 : stake;
  if (state.balance < cost) throw new Error("遊戲幣餘額不足");
  const next: DemoState = {
    ...state,
    balance: sumMoney([state.balance, -cost]),
    freeLeft: Math.max(0, state.freeLeft - 1),
  };
  const normalizeBalls = (tiles: Tile[]) =>
    tiles.map((t) =>
      t.kind === "orb" ? { ...t, value: options.godly ? 1000 : Math.min(1000, t.value ?? 2) } : t,
    );
  let board = normalizeBalls(fixture?.map((t) => ({ ...t })) ?? makeBoard(rng));
  const frames: Frame[] = [];
  const cap = stake * MAX_WIN_FACTOR;
  let baseWin = 0,
    scatterMax = 0,
    bonusCount = 0,
    bonusWin = 0,
    capped = false;
  const balls = () => board.reduce((n, t) => n + (t.kind === "orb" ? t.value! : 0), 0);
  // The existing total applies ONLY when this spin has new balls AND a symbol win.
  const multiplier = () =>
    baseWin > 0 && balls() > 0 ? balls() + (wasFree ? state.multiplier : 0) : 1;
  const reachedCap = () => bonusWin + baseWin * multiplier() >= cap;
  for (let step = 0; step <= 12; step++) {
    const scatters = board.filter((t) => t.kind === "scatter").length;
    scatterMax = Math.max(scatterMax, scatters);
    if (!wasFree && scatters >= 4) {
      bonusCount = Math.max(bonusCount, Math.min(4, board.filter((t) => t.kind === "gold").length));
      bonusWin = stake * SUPER_BONUS[bonusCount];
    }
    // Four Super Bonus symbols can finish the spin before another cascade is drawn.
    if (reachedCap()) {
      capped = true;
      frames.push({ board: [...board], winners: [], win: 0, groups: [] });
      break;
    }
    const result = evaluate(board, stake);
    if (!result.winners.length || step === 12) {
      frames.push({ board: [...board], winners: [], win: 0, groups: [] });
      break;
    }
    baseWin += result.win;
    frames.push({ board: [...board], ...result });
    if (reachedCap()) {
      capped = true;
      break;
    }
    board = normalizeBalls(tumble(board, result.winners, rng));
  }
  const upgrades: SpinResult["upgrades"] = [];
  // A bounded sequence: each successful step strictly increases the ball up to 1000.
  // Events retain each intermediate value for presentation; rendering never resamples RNG.
  if (!capped && wasFree && baseWin > 0) {
    for (let i = 0; i < board.length && !capped; i++) {
      let t = board[i];
      if (t.kind !== "orb") continue;
      while (t.value! < 1000 && rng() < (state.feature === "super" ? 0.6 : 0.2)) {
        const value = Math.min(1000, t.value! * 2);
        upgrades.push({ id: t.id, from: t.value!, to: value });
        t = { ...t, value };
        board[i] = t;
        if (reachedCap()) {
          capped = true;
          break;
        }
      }
    }
  }
  const collected = baseWin > 0 ? balls() : 0;
  const factor = multiplier();
  const payout = Math.min(cap, baseWin * factor + bonusWin);
  capped ||= payout >= cap;
  // This is the only credit operation. All following state changes are non-monetary.
  next.balance = sumMoney([next.balance, payout]);
  let awarded = 0;
  if (wasFree) {
    next.multiplier += collected;
    next.featureWin += payout;
    if (!capped && scatterMax >= 3) {
      awarded = Math.max(0, Math.min(5, 100 - next.freeGranted));
      next.freeLeft += awarded;
      next.freeGranted += awarded;
    }
  } else if (!capped && scatterMax >= 4) {
    awarded = 15;
    Object.assign(next, enterFeature(next, bonusCount ? "super" : "normal"));
  } else {
    next.multiplier = 0;
    next.featureWin = 0;
  }
  if (capped) next.freeLeft = 0;
  return {
    state: next,
    frames,
    board,
    payout,
    baseWin,
    factor,
    collected,
    upgrades,
    awarded,
    wasFree,
    capped,
    bonusWin,
    bonusCount,
    cost,
    limited: !capped && frames.length === 13 && evaluate(board, stake).winners.length > 0,
  };
}
