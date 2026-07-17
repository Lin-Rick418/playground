import type { Server } from "node:http";

export type ShutdownReason = "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection";

type ShutdownLogger = Pick<Console, "error" | "info">;

type ProcessEventSource = {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
};

export function closeHttpServer(server: Server) {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function withShutdownTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Graceful shutdown exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function installProcessShutdownHandlers(options: {
  serviceName: string;
  shutdown: (reason: ShutdownReason) => Promise<void>;
  timeoutMs: number;
  logger?: ShutdownLogger;
  eventSource?: ProcessEventSource;
  exit?: (code: number) => void;
}) {
  const logger = options.logger ?? console;
  const eventSource = options.eventSource ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shutdownPromise: Promise<void> | null = null;
  let requestedExitCode = 0;

  const requestShutdown = (reason: ShutdownReason, error?: unknown) => {
    if (error !== undefined) {
      requestedExitCode = 1;
      logger.error(`${options.serviceName} received ${reason}`, error);
    } else {
      logger.info(`${options.serviceName} received ${reason}; shutting down`);
    }

    if (shutdownPromise) {
      return;
    }

    shutdownPromise = withShutdownTimeout(options.shutdown(reason), options.timeoutMs)
      .then(() => {
        logger.info(`${options.serviceName} shutdown complete`);
        exit(requestedExitCode);
      })
      .catch((shutdownError: unknown) => {
        logger.error(`${options.serviceName} graceful shutdown failed`, shutdownError);
        exit(1);
      });
  };

  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");
  const onUncaughtException = (error: unknown) => requestShutdown("uncaughtException", error);
  const onUnhandledRejection = (error: unknown) => requestShutdown("unhandledRejection", error);

  eventSource.once("SIGINT", onSigint);
  eventSource.once("SIGTERM", onSigterm);
  eventSource.once("uncaughtException", onUncaughtException);
  eventSource.once("unhandledRejection", onUnhandledRejection);

  return () => {
    eventSource.off("SIGINT", onSigint);
    eventSource.off("SIGTERM", onSigterm);
    eventSource.off("uncaughtException", onUncaughtException);
    eventSource.off("unhandledRejection", onUnhandledRejection);
  };
}
