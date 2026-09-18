import { Router } from "express";
import { z } from "zod";
import {
  hiloConfigResponseSchema,
  hiloStateResponseSchema,
  hiloRoundResponseSchema,
  hiloHistoryResponseSchema,
} from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { sendContractResponse } from "../../lib/contracts.js";
import { sendApiError } from "../../lib/api-errors.js";
import { parseHistoryPageQuery } from "../../lib/history-pagination.js";
import { findHiloRound, hiloHistory, hiloState } from "./service.js";
export const hiloRouter = Router();
hiloRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
hiloRouter.use(authenticate);
hiloRouter.use((req: AuthenticatedRequest, res, next) => {
  if (req.currentUser?.role !== "PLAYER")
    return sendApiError(req, res, 403, "FORBIDDEN", "Player access required");
  next();
});
hiloRouter.get("/config", (_req, res) =>
  sendContractResponse(res, "hilo.config", hiloConfigResponseSchema, {
    minBet: 100,
    maxBet: 5000,
    betStep: 100,
    rtp: 0.94,
    maxMultiplier: 10000,
    maxSkips: 52,
    ruleVersion: 1,
    enabled: env.hiloEnabled,
  }),
);
hiloRouter.get("/state", async (req: AuthenticatedRequest, res) =>
  sendContractResponse(
    res,
    "hilo.state",
    hiloStateResponseSchema,
    await hiloState(req.currentUser!.id),
  ),
);
hiloRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  const page = parseHistoryPageQuery(req.query);
  if (!page.success)
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid history pagination");
  return sendContractResponse(
    res,
    "hilo.history",
    hiloHistoryResponseSchema,
    await hiloHistory(req.currentUser!.id, page.data),
  );
});
hiloRouter.get("/rounds/:id", async (req: AuthenticatedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid round id");
  const round = await findHiloRound(req.currentUser!.id, id.data);
  if (!round) return sendApiError(req, res, 404, "NOT_FOUND", "Hi-Lo round not found");
  return sendContractResponse(res, "hilo.round", hiloRoundResponseSchema, { round });
});
