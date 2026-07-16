import type { z } from "zod";

export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: Array<{ code: string; path: string }>;

  constructor(
    contract: string,
    issues: Array<{ code: string; path: string }>,
  ) {
    super(`Invalid ${contract} contract`);
    this.name = "ContractValidationError";
    this.contract = contract;
    this.issues = issues;
  }
}

export function parseRuntimeContract<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  contract: string,
  boundary: "API response" | "WebSocket message" = "API response",
) {
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.join("."),
    }));
    console.error(`${boundary} contract validation failed`, { contract, issues });
    throw new ContractValidationError(contract, issues);
  }

  return parsed.data;
}
