import { Router } from "express";
import { z } from "zod";
import {
  blackjackConfigResponseSchema,
  blackjackStateResponseSchema,
  blackjackRoundResponseSchema,
  blackjackHistoryResponseSchema,
} from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { sendContractResponse } from "../../lib/contracts.js";
import { sendApiError } from "../../lib/api-errors.js";
import { parseHistoryPageQuery } from "../../lib/history-pagination.js";
import { findBlackjackRound, blackjackHistory } from "./service.js";
export const blackjackRouter = Router();
blackjackRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
blackjackRouter.use(authenticate);
blackjackRouter.use((req: AuthenticatedRequest, res, next) => {
  if (req.currentUser?.role !== "PLAYER")
    return sendApiError(req, res, 403, "FORBIDDEN", "Player access required");
  next();
});
blackjackRouter.get("/config", (_req, res) =>
  sendContractResponse(res, "blackjack.config", blackjackConfigResponseSchema, {
    minBet: 100,
    maxBet: 5000,
    betStep: 100,
    rtp: null,
    decks: 6,
    maxHands: 4,
    ruleVersion: 1,
    enabled: env.blackjackEnabled,
  }),
);
blackjackRouter.get("/state", async (req: AuthenticatedRequest, res) =>
  sendContractResponse(res, "blackjack.state", blackjackStateResponseSchema, {
    round: await findBlackjackRound(req.currentUser!.id),
  }),
);
blackjackRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  const page = parseHistoryPageQuery(req.query);
  if (!page.success)
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid history pagination");
  return sendContractResponse(
    res,
    "blackjack.history",
    blackjackHistoryResponseSchema,
    await blackjackHistory(req.currentUser!.id, page.data),
  );
});
blackjackRouter.get("/rounds/:id", async (req: AuthenticatedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid round id");
  const round = await findBlackjackRound(req.currentUser!.id, id.data);
  if (!round) return sendApiError(req, res, 404, "NOT_FOUND", "Blackjack round not found");
  return sendContractResponse(res, "blackjack.round", blackjackRoundResponseSchema, { round });
});
