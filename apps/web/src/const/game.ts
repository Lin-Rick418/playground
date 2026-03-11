import type { BetType, RoundWinner } from "../types/domain";

export const CHIP_VALUES = [100, 500, 1000, 10000, 50000] as const;
export const DEFAULT_CHIP_VALUE = CHIP_VALUES[1];

export const BET_TYPE_LABELS: Record<BetType, string> = {
  PLAYER: "閒",
  BANKER: "莊",
  TIE: "和",
  PLAYER_PAIR: "閒對",
  BANKER_PAIR: "莊對",
};

export const WINNER_LABELS: Record<RoundWinner, string> = {
  PLAYER: "閒贏",
  BANKER: "莊贏",
  TIE: "和局",
};

export const BET_OPTIONS = [
  { key: "PLAYER", label: BET_TYPE_LABELS.PLAYER, payout: "1:1", accent: "player", gridClass: "grid-player" },
  { key: "TIE", label: BET_TYPE_LABELS.TIE, payout: "8:1", accent: "tie", gridClass: "grid-tie" },
  { key: "BANKER", label: BET_TYPE_LABELS.BANKER, payout: "0.95:1", accent: "banker", gridClass: "grid-banker" },
  {
    key: "PLAYER_PAIR",
    label: BET_TYPE_LABELS.PLAYER_PAIR,
    payout: "11:1",
    accent: "pair-player",
    gridClass: "grid-player-pair",
  },
  {
    key: "BANKER_PAIR",
    label: BET_TYPE_LABELS.BANKER_PAIR,
    payout: "11:1",
    accent: "pair-banker",
    gridClass: "grid-banker-pair",
  },
] as const satisfies ReadonlyArray<{
  key: BetType;
  label: string;
  payout: string;
  accent: string;
  gridClass: string;
}>;

export const DEAL_ANIMATION_TIMINGS = {
  baseCardIntervalMs: 520,
  baseRevealDelayMs: 2400,
  bonusPhaseDelayMs: 620,
  bonusCardIntervalMs: 620,
  bonusRevealDelayMs: 600,
  noBonusRevealDelayMs: 850,
  finalRevealDelayMs: 520,
} as const;
