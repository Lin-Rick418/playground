import { Router } from "express";
import {
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  dailyProfitResponseSchema,
  historyResponseSchema,
  lobbyResponseSchema,
  placeBetResponseSchema,
  shoeAuditResponseSchema,
  tableStateResponseSchema,
  type ApiErrorCode,
} from "@baccarat/contracts";
import { env } from "../../config/env.js";
import { getRequestId, sendApiError } from "../../lib/api-errors.js";
import { placeBetSchema, tableIdParamsSchema } from "../../lib/account-policy.js";
import { getBusinessDayWindow } from "../../lib/business-day.js";
import { sendContractResponse } from "../../lib/contracts.js";
import {
  buildLobbyTables,
  buildTablePublicState,
  buildTableUserState,
  getShoeAuditBundle,
  getUserDailyProfit,
  listUserHistory,
} from "../../lib/db.js";
import { parseIdempotencyKey } from "../../lib/idempotency.js";
import { parseHistoryPageQuery } from "../../lib/history-pagination.js";
import { getRoundConfig } from "../../lib/round-manager.js";
import { toPublicShoeAudit } from "../../lib/shoe-audit.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";
import { placeBets } from "./place-bet-service.js";

function defaultBetErrorCode(statusCode: number): ApiErrorCode {
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 503) return "SERVICE_UNAVAILABLE";
  return "VALIDATION_ERROR";
}

function buildBetErrorResponse(
  statusCode: number,
  body: Record<string, unknown>,
  requestId: string,
) {
  const parsedCode = apiErrorCodeSchema.safeParse(body.code);

  return {
    code: parsedCode.success ? parsedCode.data : defaultBetErrorCode(statusCode),
    message: typeof body.message === "string" && body.message ? body.message : "Bet request failed",
    requestId,
  };
}

function buildBetSuccessResponse(body: Record<string, unknown>) {
  const bets = Array.isArray(body.bets)
    ? body.bets.map((value) => {
        const bet =
          typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
        return {
          id: bet.id,
          betType: bet.betType,
          amount: bet.amount,
          payout: bet.payout,
          createdAt: bet.createdAt,
        };
      })
    : body.bets;

  return {
    table: body.table,
    round: body.round,
    bets,
    balance: body.balance,
  };
}

export const gameRouter = Router();

gameRouter.use(authenticate);

gameRouter.get("/lobby", async (_req, res) => {
  const tables = await buildLobbyTables();
  return sendContractResponse(res, "game.lobby", lobbyResponseSchema, {
    tables,
    config: getRoundConfig(),
    serverTime: new Date().toISOString(),
  });
});

gameRouter.get("/tables/:tableId/state", async (req: AuthenticatedRequest, res) => {
  const params = tableIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid table id");
  }
  const publicState = await buildTablePublicState(params.data.tableId);
  if (!publicState) {
    return sendApiError(req, res, 404, "NOT_FOUND", "Table not found");
  }
  if (!publicState.round) {
    return sendApiError(req, res, 503, "SERVICE_UNAVAILABLE", "No active round for table");
  }

  const userState = await buildTableUserState(req.currentUser!.id, params.data.tableId);
  return sendContractResponse(res, "game.table.state", tableStateResponseSchema, {
    ...publicState,
    myBets: userState.myBets,
    balance: userState.balance,
    config: getRoundConfig(),
  });
});

gameRouter.get("/history", async (req: AuthenticatedRequest, res) => {
  const page = parseHistoryPageQuery(req.query);
  if (!page.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid history pagination");
  }

  return sendContractResponse(
    res,
    "game.history",
    historyResponseSchema,
    await listUserHistory(req.currentUser!.id, page.data),
  );
});

gameRouter.get("/daily-profit", async (req: AuthenticatedRequest, res) => {
  const calculatedAt = new Date();
  const window = getBusinessDayWindow(calculatedAt, env.businessTimeZone);
  const totals = await getUserDailyProfit(req.currentUser!.id, window);
  return sendContractResponse(res, "game.daily-profit", dailyProfitResponseSchema, {
    date: window.date,
    timeZone: window.timeZone,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    formula: "TOTAL_PAYOUT_MINUS_TOTAL_BET",
    recognitionTime: "ROUND_SETTLED_AT",
    ...totals,
    calculatedAt: calculatedAt.toISOString(),
  });
});

gameRouter.get("/shoes/:shoeId/audit", async (req, res) => {
  const audit = await getShoeAuditBundle(String(req.params.shoeId));

  if (!audit) {
    return sendApiError(req, res, 404, "NOT_FOUND", "Shoe audit not found");
  }

  return sendContractResponse(
    res,
    "game.shoe-audit",
    shoeAuditResponseSchema,
    toPublicShoeAudit(audit),
  );
});

gameRouter.post("/tables/:tableId/bet", async (req: AuthenticatedRequest, res) => {
  const params = tableIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid table id");
  }
  const parsed = placeBetSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "Invalid bet payload");
  }

  const requestedIdempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key"));
  if (!requestedIdempotencyKey) {
    return sendApiError(
      req,
      res,
      400,
      "VALIDATION_ERROR",
      "A valid Idempotency-Key header is required",
    );
  }

  const result = await placeBets({
    actorId: req.currentUser!.id,
    tableId: params.data.tableId,
    idempotencyKey: requestedIdempotencyKey,
    bets: parsed.data.bets,
  });

  if (result.kind === "error") {
    return sendContractResponse(
      res,
      "game.bet.error",
      apiErrorResponseSchema,
      buildBetErrorResponse(
        result.statusCode,
        result.body as Record<string, unknown>,
        getRequestId(req),
      ),
      result.statusCode,
    );
  }

  return sendContractResponse(
    res,
    "game.bet.success",
    placeBetResponseSchema,
    buildBetSuccessResponse(result.body as Record<string, unknown>),
    result.statusCode,
  );
});
