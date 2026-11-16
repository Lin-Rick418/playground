// Presentation metadata only. Wager outcomes are generated on the server.
import type { StormTile, StormSymbol } from "@baccarat/contracts";
export type { StormTile as Tile, StormSymbol as SymbolKind } from "@baccarat/contracts";
export { STORM_LABELS as LABELS, STORM_PAY as PAY } from "@baccarat/contracts";
type SymbolKind = StormSymbol;
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
// A deterministic decorative board is shown before the first saved round.
export const previewBoard = (): StormTile[] =>
  Array.from({ length: 30 }, (_, id) => ({
    id,
    kind: (["scarab", "amber", "ruby", "sapphire", "emerald", "lotus"] as const)[id % 6]!,
  }));

// Display-only probabilities for immutable balanced-2.0; server owns all draws.
export const BALANCED_WEIGHTS: [StormSymbol, number][] = [
  ["ruby", 11.5],
  ["emerald", 12.5],
  ["sapphire", 17],
  ["amber", 19.5],
  ["lotus", 12],
  ["scarab", 16.5],
  ["sun", 2],
  ["moon", 2],
  ["gold", 0.1],
  ["scatter", 2.5],
  ["orb", 4.4],
];
