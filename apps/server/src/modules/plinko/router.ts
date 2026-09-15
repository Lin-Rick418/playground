import { Router } from "express";
import { z } from "zod";
import {
  apiErrorCodeSchema,
  plinkoConfigResponseSchema,
  plinkoHistoryResponseSchema,
  plinkoMutationResponseSchema,
  plinkoRoundResponseSchema,
  plinkoStartRequestSchema,
} from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { sendContractResponse } from "../../lib/contracts.js";
import { sendApiError } from "../../lib/api-errors.js";
import { parseIdempotencyKey } from "../../lib/idempotency.js";
import { parseHistoryPageQuery } from "../../lib/history-pagination.js";
import { findPlinkoRound, placePlinkoBet, plinkoHistory } from "./service.js";
import { plinkoTables, PLINKO_RISKS, PLINKO_RULE_VERSION } from "./math.js";

export const plinkoRouter = Router();
plinkoRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
plinkoRouter.use(authenticate);
plinkoRouter.get("/config", (_req, res) =>
  sendContractResponse(res, "plinko.config", plinkoConfigResponseSchema, {
    minRows: 8,
    maxRows: 16,
    risks: [...PLINKO_RISKS],
    minBet: 100,
    maxBet: 5000,
    betStep: 100,
    ruleVersion: PLINKO_RULE_VERSION,
    enabled: env.plinkoEnabled,
    tables: plinkoTables.map(({ rows, risk, multipliers, rtp }) => ({
      rows,
      risk,
      multipliers: [...multipliers],
      rtp,
    })),
  }),
);
plinkoRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  const page = parseHistoryPageQuery(req.query);
  if (!page.success)
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid history pagination");
  return sendContractResponse(
    res,
    "plinko.history",
    plinkoHistoryResponseSchema,
    await plinkoHistory(req.currentUser!.id, page.data),
  );
});
plinkoRouter.get("/rounds/:id", async (req: AuthenticatedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid round id");
  const round = await findPlinkoRound(req.currentUser!.id, id.data);
  if (!round) return sendApiError(req, res, 404, "NOT_FOUND", "Plinko round not found");
  return sendContractResponse(res, "plinko.round", plinkoRoundResponseSchema, { round });
});
plinkoRouter.post("/rounds", async (req: AuthenticatedRequest, res) => {
  const key = parseIdempotencyKey(req.headers["idempotency-key"]);
  const payload = plinkoStartRequestSchema.safeParse(req.body);
  if (!key || !payload.success)
    return sendApiError(
      req,
      res,
      400,
      "VALIDATION_ERROR",
      "Invalid Plinko request or Idempotency-Key",
    );
  const result = await placePlinkoBet(req.currentUser!.id, key, payload.data);
  if (result.statusCode >= 400) {
    if (result.statusCode === 429) res.setHeader("Retry-After", "60");
    return sendApiError(
      req,
      res,
      result.statusCode,
      apiErrorCodeSchema.parse(result.body.code),
      String(result.body.message),
    );
  }
  return sendContractResponse(res, "plinko.start", plinkoMutationResponseSchema, result.body);
});
