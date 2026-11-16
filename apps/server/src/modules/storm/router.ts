import { Router } from "express";
import {
  STORM_STAKES,
  stormConfigResponseSchema,
  stormStateResponseSchema,
} from "@baccarat/contracts";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { sendContractResponse } from "../../lib/contracts.js";
import { sendApiError } from "../../lib/api-errors.js";
import { env } from "../../config/env.js";
import { stormState } from "./service.js";
import { activeStormProfile } from "./profiles.js";
import { pool } from "../../lib/repositories/client.js";
export const stormRouter = Router();
stormRouter.use(authenticate);
stormRouter.use((req: AuthenticatedRequest, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.currentUser?.role !== "PLAYER")
    return sendApiError(req, res, 403, "FORBIDDEN", "需要玩家帳戶。");
  next();
});
stormRouter.get("/config", async (_req, res) => {
  const profile = await activeStormProfile(pool);
  return sendContractResponse(res, "storm.config", stormConfigResponseSchema, {
    stakes: [...STORM_STAKES],
    enabled: env.stormEnabled,
    ruleVersion: profile?.settings ? 3 : profile ? 2 : 1,
    maxWinFactor: profile?.maxWinFactor ?? 25000,
    rtp: null,
    mathProfile: profile,
  });
});
stormRouter.get("/state", async (req: AuthenticatedRequest, res) => {
  const state = await stormState(req.currentUser!.id);
  if (!state) return sendApiError(req, res, 403, "FORBIDDEN", "帳戶無法進行遊戲。");
  return sendContractResponse(res, "storm.state", stormStateResponseSchema, state);
});
