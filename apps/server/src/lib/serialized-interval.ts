export type SerializedIntervalRunner = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createSerializedIntervalRunner(
  task: () => Promise<void>,
  intervalMs: number,
): SerializedIntervalRunner {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("Interval must be a positive safe integer");
  }

  let interval: NodeJS.Timeout | null = null;
  let currentTask: Promise<void> | null = null;
  let stopped = true;

  function run() {
    if (currentTask) {
      return currentTask;
    }

    const running = task().finally(() => {
      if (currentTask === running) {
        currentTask = null;
      }
    });
    currentTask = running;
    return running;
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;

      try {
        await run();
      } catch (error) {
        stopped = true;
        throw error;
      }

      if (!stopped) {
        interval = setInterval(() => {
          void run();
        }, intervalMs);
      }
    },

    async stop() {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await currentTask;
    },
  };
}
