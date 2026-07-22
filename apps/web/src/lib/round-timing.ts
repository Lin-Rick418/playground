type RoundBettingWindow = {
  bettingOpensAt: string;
  bettingClosesAt: string;
};

export function getClientClockAtServerTime(
  clientNowMs: number,
  serverTimeOffsetMs: number,
  targetServerTimeMs: number,
) {
  if (
    !Number.isFinite(clientNowMs) ||
    !Number.isFinite(serverTimeOffsetMs) ||
    !Number.isFinite(targetServerTimeMs)
  ) {
    return clientNowMs;
  }

  return Math.max(clientNowMs, targetServerTimeMs - serverTimeOffsetMs);
}

export function getRoundCountdownSeconds(
  round: RoundBettingWindow | null | undefined,
  nowMs: number,
) {
  if (!round || !Number.isFinite(nowMs)) {
    return 0;
  }

  const opensAtMs = Date.parse(round.bettingOpensAt);
  const closesAtMs = Date.parse(round.bettingClosesAt);
  if (!Number.isFinite(opensAtMs) || !Number.isFinite(closesAtMs)) {
    return 0;
  }

  if (nowMs < opensAtMs || nowMs >= closesAtMs) {
    return 0;
  }

  return Math.ceil((closesAtMs - nowMs) / 1000);
}

export function getDisplayDurationBeforeDeadline(
  preferredDurationMs: number,
  deadlineIso: string | null | undefined,
  nowMs: number,
) {
  const deadlineMs = deadlineIso ? Date.parse(deadlineIso) : Number.NaN;
  if (
    !Number.isFinite(preferredDurationMs) ||
    preferredDurationMs <= 0 ||
    !Number.isFinite(deadlineMs) ||
    !Number.isFinite(nowMs)
  ) {
    return 0;
  }

  return Math.max(0, Math.min(preferredDurationMs, deadlineMs - nowMs));
}
