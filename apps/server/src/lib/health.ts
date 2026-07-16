export type ReadinessInput = {
  databaseOk: boolean;
  databaseLatencyMs: number;
  workerHeartbeat: null | {
    instanceId: string;
    status: "healthy" | "degraded";
    lastSeenAt: string;
    lastHealthyAt: string | null;
  };
  now: number;
  maxWorkerAgeMs: number;
};

export function evaluateReadiness(input: ReadinessInput) {
  const lastSeenAtMs = input.workerHeartbeat ? new Date(input.workerHeartbeat.lastSeenAt).getTime() : Number.NaN;
  const lastHealthyAtMs = input.workerHeartbeat?.lastHealthyAt
    ? new Date(input.workerHeartbeat.lastHealthyAt).getTime()
    : Number.NaN;
  const workerAgeMs = Number.isFinite(lastSeenAtMs) ? Math.max(0, input.now - lastSeenAtMs) : null;
  const workerHealthyAgeMs = Number.isFinite(lastHealthyAtMs)
    ? Math.max(0, input.now - lastHealthyAtMs)
    : null;
  const workerReady = Boolean(
    input.workerHeartbeat &&
      input.workerHeartbeat.status === "healthy" &&
      workerAgeMs !== null &&
      workerAgeMs <= input.maxWorkerAgeMs &&
      workerHealthyAgeMs !== null &&
      workerHealthyAgeMs <= input.maxWorkerAgeMs,
  );
  const ready = input.databaseOk && workerReady;

  return {
    status: ready ? "ready" : "not_ready",
    checks: {
      database: {
        status: input.databaseOk ? "up" : "down",
        latencyMs: input.databaseLatencyMs,
      },
      roundWorker: {
        status: workerReady ? "up" : "down",
        instanceId: input.workerHeartbeat?.instanceId ?? null,
        reportedStatus: input.workerHeartbeat?.status ?? null,
        lastSeenAt: input.workerHeartbeat?.lastSeenAt ?? null,
        lastHealthyAt: input.workerHeartbeat?.lastHealthyAt ?? null,
        ageMs: workerAgeMs,
      },
    },
  } as const;
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Health dependency check timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
