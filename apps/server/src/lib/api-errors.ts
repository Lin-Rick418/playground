import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiErrorCode } from "@baccarat/contracts";
import { logger } from "./logger.js";

export type { ApiErrorCode } from "@baccarat/contracts";

type RequestWithId = Request & { requestId?: string };

export type ApiErrorLogger = {
  warn(entry: {
    event: "http_request_rejected";
    requestId: string;
    method: string;
    path: string;
    statusCode: number;
  }): void;
  error(entry: {
    event: "http_request_failed";
    requestId: string;
    method: string;
    path: string;
    errorName: string;
    errorMessage: string;
    stack?: string;
  }): void;
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function getRequestId(req: Request) {
  return (req as RequestWithId).requestId ?? "unknown";
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incomingRequestId = req.header("x-request-id")?.trim();
  const requestId = incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId) ? incomingRequestId : randomUUID();

  (req as RequestWithId).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
};

export function createRejectedRequestLogger(errorLogger: ApiErrorLogger = logger): RequestHandler {
  return (req, res, next) => {
    res.once("finish", () => {
      if (res.statusCode < 400 || res.locals.internalErrorLogged === true) {
        return;
      }

      errorLogger.warn({
        event: "http_request_rejected",
        requestId: getRequestId(req),
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
      });
    });
    next();
  };
}

export function sendApiError(
  req: Request,
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
) {
  return res.status(status).json({
    code,
    message,
    requestId: getRequestId(req),
  });
}

type HttpErrorLike = {
  code?: string;
  status?: number;
  statusCode?: number;
  type?: string;
};

function asErrorLike(error: unknown): HttpErrorLike {
  return typeof error === "object" && error !== null ? (error as HttpErrorLike) : {};
}

function parserErrorResponse(error: unknown) {
  const errorLike = asErrorLike(error);

  if (errorLike.type === "entity.parse.failed") {
    return { status: 400, code: "MALFORMED_JSON", message: "Malformed JSON request body" } as const;
  }

  if (errorLike.type === "entity.too.large" || errorLike.status === 413 || errorLike.statusCode === 413) {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } as const;
  }

  if (errorLike.type === "encoding.unsupported" || errorLike.status === 415 || errorLike.statusCode === 415) {
    return { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported request encoding" } as const;
  }

  const status = errorLike.status ?? errorLike.statusCode;
  if (status && status >= 400 && status < 500) {
    return { status, code: "VALIDATION_ERROR", message: "Invalid request" } as const;
  }

  return null;
}

export function notFoundHandler(req: Request, res: Response) {
  return sendApiError(req, res, 404, "NOT_FOUND", "Route not found");
}

export function createGlobalErrorHandler(errorLogger: ApiErrorLogger = logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(error);
    }

    const parserResponse = parserErrorResponse(error);

    if (parserResponse) {
      return sendApiError(req, res, parserResponse.status, parserResponse.code, parserResponse.message);
    }

    if (asErrorLike(error).code === "23505") {
      return sendApiError(req, res, 409, "CONFLICT", "Resource already exists");
    }

    const requestId = getRequestId(req);
    res.locals.internalErrorLogged = true;
    errorLogger.error({
      event: "http_request_failed",
      requestId,
      method: req.method,
      path: req.originalUrl,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    return sendApiError(req, res, 500, "INTERNAL_ERROR", "Internal server error");
  };
}
