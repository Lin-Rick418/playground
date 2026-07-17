import type { Response } from "express";
import { apiErrorResponseSchema } from "@baccarat/contracts";
import type { z } from "zod";
import { logger, type AppLogger } from "./logger.js";

export function contractIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.join("."),
  }));
}

export function sendContractResponse<T>(
  response: Response,
  contractName: string,
  schema: z.ZodType<T>,
  payload: unknown,
  status = 200,
  contractLogger: Pick<AppLogger, "error"> = logger,
) {
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    contractLogger.error({
      event: "api_response_contract_failed",
      contract: contractName,
      issues: contractIssues(parsed.error),
    }, "API response contract validation failed");
    const requestIdHeader = response.getHeader("X-Request-Id");
    const requestId = Array.isArray(requestIdHeader)
      ? String(requestIdHeader[0] ?? "unknown")
      : String(requestIdHeader ?? "unknown");
    return response.status(500).json(apiErrorResponseSchema.parse({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId,
    }));
  }

  return response.status(status).json(parsed.data);
}
