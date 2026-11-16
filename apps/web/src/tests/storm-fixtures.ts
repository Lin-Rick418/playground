import {
  initialStormProgress,
  STORM_STAKES,
  type StormMutationResponse,
  type StormStateResponse,
} from "@baccarat/contracts";
import { previewBoard } from "../lib/storm-demo";
export const stormUser = {
  id: "storm-player",
  username: "player",
  role: "PLAYER" as const,
  isActive: true,
  balance: 10000,
  walletVersion: 1,
};
export const stormConfig = {
  stakes: [...STORM_STAKES],
  enabled: true,
  ruleVersion: 1,
  maxWinFactor: 25000,
  rtp: null,
};
export const stormSnapshot = (): StormStateResponse => ({
  session: { progress: initialStormProgress(), amount: 10, version: 0, ruleVersion: 1 },
  lastRound: null,
  recent: [],
  balance: 10000,
  walletVersion: 1,
});
export function stormResult(
  version = 1,
  payout = 24,
  freeLeft = 0,
  amount: StormMutationResponse["round"]["amount"] = 10,
): StormMutationResponse {
  const progress = { ...initialStormProgress(), freeLeft, freeGranted: freeLeft ? 15 : 0 };
  const board = previewBoard();
  return {
    session: { progress, amount, version, ruleVersion: 1 },
    balance: 10000 - amount + payout,
    walletVersion: version + 1,
    round: {
      id: `10000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
      version,
      amount,
      ruleVersion: 1,
      createdAt: "2026-10-24T10:00:00.000Z",
      result: {
        state: { ...progress, balance: 10000 - amount + payout },
        board,
        frames: [{ board, winners: [], win: 0, groups: [] }],
        payout,
        baseWin: payout,
        factor: 1,
        collected: 0,
        upgrades: [],
        awarded: freeLeft,
        wasFree: false,
        capped: false,
        bonusWin: 0,
        bonusCount: 0,
        cost: amount,
        limited: false,
      },
    },
  };
}
