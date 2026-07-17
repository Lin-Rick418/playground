import { hostname } from "node:os";
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export const sensitiveLogPaths = [
  "password",
  "*.password",
  "*.*.password",
  "token",
  "*.token",
  "*.*.token",
  "cookie",
  "*.cookie",
  "headers.cookie",
  "*.headers.cookie",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "body",
  "req.body",
  "request.body",
] as const;

export type AppLogger = Logger;

export function toLogError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export function createServiceLogger(options: {
  service: string;
  instanceId?: string;
  environment?: string;
  level?: string;
  destination?: DestinationStream;
}): AppLogger {
  const environment = options.environment ?? process.env.NODE_ENV ?? "development";
  const loggerOptions: LoggerOptions = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    enabled: environment !== "test" || Boolean(options.destination),
    base: {
      service: options.service,
      instanceId: options.instanceId ?? `${hostname()}:${process.pid}`,
    },
    redact: {
      paths: [...sensitiveLogPaths],
      censor: "[REDACTED]",
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  if (environment === "development" && !options.destination) {
    loggerOptions.transport = {
      target: "pino-pretty",
      options: {
        colorize: process.stdout.isTTY,
        singleLine: true,
        translateTime: "SYS:standard",
      },
    };
  }

  return pino(loggerOptions, options.destination);
}

export const logger = createServiceLogger({
  service: process.env.BACCARAT_SERVICE_NAME ?? "baccarat",
});
