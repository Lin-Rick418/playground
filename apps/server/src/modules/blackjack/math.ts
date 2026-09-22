import { randomInt, randomUUID } from "node:crypto";
import {
  fromMinorUnits,
  toMinorUnits,
  type BlackjackAction,
  type BlackjackHand,
  type BlackjackRound,
} from "@baccarat/contracts";
export const rank = (card: number) => Math.floor(card / 4) + 1;
export const value = (card: number) => Math.min(rank(card), 10);
export function total(cards: number[]) {
  let result = cards.reduce((sum, card) => sum + value(card), 0);
  const soft = cards.some((card) => rank(card) === 1) && result + 10 <= 21;
  if (soft) result += 10;
  return { total: result, soft };
}
export function shuffleShoe() {
  const shoe = Array.from({ length: 312 }, (_, i) => i);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}
export type BlackjackState = {
  shoe: number[];
  position: number;
  dealer: number[];
  hands: BlackjackHand[];
  phase: BlackjackRound["phase"];
  insurance: BlackjackRound["insurance"];
};
function draw(state: BlackjackState) {
  const card = state.shoe[state.position++];
  if (card === undefined) throw new Error("Blackjack shoe exhausted");
  return card % 52;
}
function hand(cards: number[], amount: number, split = false, splitAces = false): BlackjackHand {
  const score = total(cards);
  return {
    id: randomUUID(),
    cards,
    amount,
    ...score,
    status: score.total >= 21 || splitAces ? "STOOD" : "PLAYING",
    split,
    splitAces,
    doubled: false,
    outcome: "PENDING",
    payout: 0,
  };
}
const natural = (h: BlackjackHand) => !h.split && h.cards.length === 2 && h.total === 21;
export function activeHand(state: BlackjackState) {
  return state.phase === "PLAYER_TURN"
    ? (state.hands.find((h) => h.status === "PLAYING") ?? null)
    : null;
}
export function allowedActions(state: BlackjackState): BlackjackRound["allowedActions"] {
  if (state.phase === "INSURANCE") return ["insurance"];
  const h = activeHand(state);
  if (!h) return [];
  const actions: BlackjackRound["allowedActions"] = ["hit", "stand"];
  if (h.cards.length === 2 && !h.splitAces) {
    actions.push("double");
    if (state.hands.length < 4 && value(h.cards[0]) === value(h.cards[1])) actions.push("split");
  }
  return actions;
}
function multiply(amount: number, numerator: bigint, denominator = 1n) {
  return fromMinorUnits((toMinorUnits(amount) * numerator * 2n + denominator) / (denominator * 2n));
}
export function totalBet(state: BlackjackState) {
  return fromMinorUnits(
    state.hands.reduce(
      (sum, h) => sum + toMinorUnits(h.amount),
      toMinorUnits(state.insurance.amount),
    ),
  );
}
export function payout(state: BlackjackState) {
  return fromMinorUnits(
    state.hands.reduce(
      (sum, h) => sum + toMinorUnits(h.payout),
      toMinorUnits(state.insurance.payout),
    ),
  );
}
// Only public information contributes to exposure, never the dealer hole card.
export function maximumPayout(state: BlackjackState) {
  return fromMinorUnits(
    state.hands.reduce(
      (sum, h) =>
        sum + toMinorUnits(multiply(h.amount, natural(h) ? 5n : 2n, natural(h) ? 2n : 1n)),
      toMinorUnits(multiply(state.insurance.amount, 3n)),
    ),
  );
}
function finish(state: BlackjackState) {
  const dealerNatural = state.dealer.length === 2 && total(state.dealer).total === 21;
  if (!dealerNatural && state.hands.some((h) => h.status !== "BUST" && !natural(h))) {
    while (total(state.dealer).total < 17) state.dealer.push(draw(state));
  }
  const dealerTotal = total(state.dealer).total;
  for (const h of state.hands) {
    h.status = h.total > 21 ? "BUST" : "STOOD";
    h.outcome =
      h.total > 21
        ? "LOSE"
        : dealerNatural
          ? natural(h)
            ? "PUSH"
            : "LOSE"
          : natural(h)
            ? "BLACKJACK"
            : dealerTotal > 21 || h.total > dealerTotal
              ? "WIN"
              : h.total === dealerTotal
                ? "PUSH"
                : "LOSE";
    h.payout =
      h.outcome === "BLACKJACK"
        ? multiply(h.amount, 5n, 2n)
        : h.outcome === "WIN"
          ? multiply(h.amount, 2n)
          : h.outcome === "PUSH"
            ? h.amount
            : 0;
  }
  state.insurance.payout = dealerNatural ? multiply(state.insurance.amount, 3n) : 0;
  state.phase = "SETTLED";
}
export function startRound(amount: number, shoe = shuffleShoe()): BlackjackState {
  if (
    shoe.length !== 312 ||
    new Set(shoe).size !== 312 ||
    shoe.some((n) => !Number.isInteger(n) || n < 0 || n >= 312)
  )
    throw new Error("Invalid Blackjack shoe");
  const state: BlackjackState = {
    shoe: [...shoe],
    position: 0,
    dealer: [],
    hands: [],
    phase: "PLAYER_TURN",
    insurance: { amount: 0, payout: 0, decided: false },
  };
  const first = draw(state);
  state.dealer.push(draw(state));
  state.hands.push(hand([first, draw(state)], amount));
  state.dealer.push(draw(state));
  if (rank(state.dealer[0]) === 1) state.phase = "INSURANCE";
  else {
    state.insurance.decided = true;
    if (total(state.dealer).total === 21 || !activeHand(state)) finish(state);
  }
  return state;
}
export function additionalStake(
  state: BlackjackState,
  action: Exclude<BlackjackAction, { kind: "start" }>,
) {
  if (!allowedActions(state).includes(action.kind)) throw new Error("目前不能執行此操作。");
  if (action.kind === "insurance") return action.accept ? state.hands[0].amount / 2 : 0;
  const h = activeHand(state);
  if (!h || h.id !== action.handId) throw new Error("請先完成目前的手牌。");
  return action.kind === "split" || action.kind === "double" ? h.amount : 0;
}
export function play(state: BlackjackState, action: Exclude<BlackjackAction, { kind: "start" }>) {
  additionalStake(state, action);
  if (action.kind === "insurance") {
    state.insurance = {
      amount: action.accept ? state.hands[0].amount / 2 : 0,
      payout: 0,
      decided: true,
    };
    state.phase = "PLAYER_TURN";
    if (total(state.dealer).total === 21 || !activeHand(state)) finish(state);
    return;
  }
  const h = activeHand(state)!;
  if (action.kind === "stand") h.status = "STOOD";
  else if (action.kind === "split") {
    const aces = rank(h.cards[0]) === 1;
    const left = hand([h.cards[0], draw(state)], h.amount, true, aces);
    const right = hand([h.cards[1], draw(state)], h.amount, true, aces);
    state.hands.splice(state.hands.indexOf(h), 1, left, right);
  } else {
    if (action.kind === "double") {
      h.amount *= 2;
      h.doubled = true;
    }
    h.cards.push(draw(state));
    Object.assign(h, total(h.cards));
    if (h.total > 21) h.status = "BUST";
    else if (h.total === 21 || action.kind === "double") h.status = "STOOD";
  }
  if (!activeHand(state)) finish(state);
}
