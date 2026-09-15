import { Router } from "express";
import { z } from "zod";
import {
  minesActiveResponseSchema,
  minesConfigResponseSchema,
  minesHistoryResponseSchema,
  minesMutationResponseSchema,
  minesRevealRequestSchema,
  minesRoundResponseSchema,
  minesStartRequestSchema,
  apiErrorCodeSchema,
} from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { sendContractResponse } from "../../lib/contracts.js";
import { sendApiError } from "../../lib/api-errors.js";
import { parseIdempotencyKey } from "../../lib/idempotency.js";
import { parseHistoryPageQuery } from "../../lib/history-pagination.js";
import { findMinesRound, minesHistory, mutateMines } from "./service.js";

export const minesRouter = Router();
minesRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
minesRouter.use(authenticate);
minesRouter.get("/config", (_req, res) =>
  sendContractResponse(res, "mines.config", minesConfigResponseSchema, {
    boardSize: 25,
    minMines: 3,
    maxMines: 24,
    minBet: 100,
    maxBet: 5000,
    betStep: 100,
    rtp: 0.95,
    enabled: env.minesEnabled,
  }),
);
minesRouter.get("/active", async (req: AuthenticatedRequest, res) =>
  sendContractResponse(res, "mines.active", minesActiveResponseSchema, {
    round: await findMinesRound(req.currentUser!.id),
  }),
);
minesRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  const page = parseHistoryPageQuery(req.query);
  if (!page.success)
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid history pagination");
  return sendContractResponse(
    res,
    "mines.history",
    minesHistoryResponseSchema,
    await minesHistory(req.currentUser!.id, page.data),
  );
});
minesRouter.get("/rounds/:id", async (req: AuthenticatedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid round id");
  const round = await findMinesRound(req.currentUser!.id, id.data);
  if (!round) return sendApiError(req, res, 404, "NOT_FOUND", "Mines round not found");
  return sendContractResponse(res, "mines.round", minesRoundResponseSchema, { round });
});
for (const kind of ["start", "reveal", "cashout"] as const) {
  minesRouter.post(
    kind === "start" ? "/rounds" : `/rounds/:id/${kind}`,
    async (req: AuthenticatedRequest, res) => {
      const key = parseIdempotencyKey(req.headers["idempotency-key"]);
      if (!key)
        return sendApiError(
          req,
          res,
          400,
          "VALIDATION_ERROR",
          "A valid Idempotency-Key header is required",
        );
      const start = kind === "start" ? minesStartRequestSchema.safeParse(req.body) : null;
      const reveal = kind === "reveal" ? minesRevealRequestSchema.safeParse(req.body) : null;
      const cashout = kind === "cashout" ? z.object({}).strict().safeParse(req.body) : null;
      const id = kind !== "start" ? z.string().uuid().safeParse(req.params.id) : null;
      if (
        start?.success === false ||
        reveal?.success === false ||
        cashout?.success === false ||
        id?.success === false
      ) {
        return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid Mines request");
      }
      const action = start?.success
        ? { kind: "start" as const, ...start.data }
        : reveal?.success && id?.success
          ? { kind: "reveal" as const, roundId: id.data, ...reveal.data }
          : { kind: "cashout" as const, roundId: id!.data };
      const result = await mutateMines(req.currentUser!.id, key, action);
      if (result.statusCode >= 400)
        return sendApiError(
          req,
          res,
          result.statusCode,
          apiErrorCodeSchema.parse(result.body.code),
          String(result.body.message),
        );
      return sendContractResponse(res, `mines.${kind}`, minesMutationResponseSchema, result.body);
    },
  );
}
