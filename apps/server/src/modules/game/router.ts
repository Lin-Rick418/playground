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
import {
  getMaximumPayout,
  getSafeBalanceAfterChange,
  isValidBetForTable,
  isValidTableMoneyPolicy,
  MAX_ACCOUNT_BALANCE,
  placeBetSchema,
  tableIdParamsSchema,
} from "../../lib/account-policy.js";
import { getBusinessDayWindow } from "../../lib/business-day.js";
import { sendContractResponse } from "../../lib/contracts.js";
import {
  applyBalanceMutation,
  buildLobbyTables,
  buildTablePublicState,
  buildTableUserState,
  claimIdempotencyKey,
  completeIdempotencyKey,
  createBet,
  findTableById,
  findUserById,
  getActiveRound,
  getShoeAuditBundle,
  getUserDailyProfit,
  getUserUnsettledMaximumPayout,
  listUserHistory,
  listUserRoundBets,
  withTransaction,
} from "../../lib/db.js";
import { fingerprintIdempotencyRequest, parseIdempotencyKey } from "../../lib/idempotency.js";
import { parseHistoryPageQuery } from "../../lib/history-pagination.js";
import { publishLiveEvent } from "../../lib/live-events.js";
import { getRoundConfig } from "../../lib/round-manager.js";
import { toPublicShoeAudit } from "../../lib/shoe-audit.js";
import { authenticate, type AuthenticatedRequest } from "../../middleware/authenticate.js";

const BETTING_OPEN_GRACE_MS = 400;

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
        const bet = typeof value === "object" && value !== null
          ? value as Record<string, unknown>
          : {};
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
    return sendApiError(req, res, 400, "VALIDATION_ERROR", "A valid Idempotency-Key header is required");
  }

  const idempotencyKey: string = requestedIdempotencyKey;
  const tableId = params.data.tableId;
  const scope = `game.bet:${tableId}`;
  const requestHash = fingerprintIdempotencyRequest({ tableId, bets: parsed.data.bets });
  const actorId = req.currentUser!.id;

  const result = await withTransaction(async (client) => {
    const totalBet = parsed.data.bets.reduce((sum, bet) => sum + bet.amount, 0);
    const claim = await claimIdempotencyKey<Record<string, unknown>>(
      { actorId, scope, key: idempotencyKey, requestHash },
      client,
    );

    if (claim.kind === "replay") {
      return { statusCode: claim.statusCode, body: claim.response } as const;
    }
    if (claim.kind === "conflict") {
      return {
        statusCode: 409,
        body: {
          code: "CONFLICT",
          message: "Idempotency-Key was already used for a different request",
        },
      } as const;
    }

    async function fail(statusCode: number, code: ApiErrorCode, message: string) {
      const body = { code, message };
      await completeIdempotencyKey(
        { actorId, scope, key: idempotencyKey, requestHash, statusCode, response: body },
        client,
      );
      return { statusCode, body } as const;
    }

    const table = await findTableById(tableId, client);
    if (!table) return fail(404, "NOT_FOUND", "Table not found");
    if (!isValidTableMoneyPolicy(table.minBet, table.maxBet)) {
      return fail(503, "SERVICE_UNAVAILABLE", "Table betting policy is invalid");
    }

    const activeRound = await getActiveRound(table.id, client, { forUpdate: true });
    if (!activeRound || activeRound.status !== "OPEN") {
      return fail(400, "VALIDATION_ERROR", "Betting is closed");
    }

    const now = Date.now();
    if (
      now < new Date(activeRound.bettingOpensAt).getTime() - BETTING_OPEN_GRACE_MS ||
      now >= new Date(activeRound.bettingClosesAt).getTime()
    ) {
      return fail(400, "VALIDATION_ERROR", "Betting is closed");
    }
    if (parsed.data.bets.some((bet) => !isValidBetForTable(bet.amount, table.minBet, table.maxBet))) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `Each bet must be between ${table.minBet} and ${table.maxBet} in supported denominations`,
      );
    }

    const user = await findUserById(actorId, client, { forUpdate: true });
    if (!user) return fail(404, "NOT_FOUND", "User not found");
    if (!user.isActive || user.role !== "PLAYER") {
      return fail(403, "FORBIDDEN", "Account is not allowed to bet");
    }

    const existingRoundBets = await listUserRoundBets(user.id, activeRound.id, client);
    const existingBetTotals = new Map<string, number>();
    for (const bet of existingRoundBets) {
      existingBetTotals.set(bet.betType, (existingBetTotals.get(bet.betType) ?? 0) + bet.amount);
    }
    for (const bet of parsed.data.bets) {
      const nextTotal = (existingBetTotals.get(bet.betType) ?? 0) + bet.amount;
      if (nextTotal > table.maxBet) {
        return fail(400, "VALIDATION_ERROR", `單一玩法最高下注 ${table.maxBet}`);
      }
    }

    if (user.balance < totalBet) return fail(400, "VALIDATION_ERROR", "Insufficient balance");
    const balanceAfterStake = getSafeBalanceAfterChange(user.balance, -totalBet);
    if (balanceAfterStake === null) {
      return fail(400, "VALIDATION_ERROR", "Bet would make balance invalid");
    }

    const [existingUnsettledMaximumPayout, newMaximumPayout] = await Promise.all([
      getUserUnsettledMaximumPayout(user.id, client),
      Promise.resolve(parsed.data.bets.reduce((sum, bet) => sum + getMaximumPayout(bet.betType, bet.amount), 0)),
    ]);
    const maximumPossibleBalance = balanceAfterStake + existingUnsettledMaximumPayout + newMaximumPayout;
    if (!Number.isSafeInteger(maximumPossibleBalance) || maximumPossibleBalance > MAX_ACCOUNT_BALANCE) {
      return fail(400, "VALIDATION_ERROR", "Bet could exceed the supported account balance");
    }

    const bets = [];
    let updatedUser = user;
    for (const bet of parsed.data.bets) {
      const createdBet = await createBet(
        { userId: user.id, roundId: activeRound.id, betType: bet.betType, amount: bet.amount },
        client,
      );
      bets.push({
        id: createdBet.id,
        betType: createdBet.betType,
        amount: createdBet.amount,
        payout: createdBet.payout,
        createdAt: createdBet.createdAt,
      });
      const mutation = await applyBalanceMutation(
        {
          userId: user.id,
          delta: -bet.amount,
          actorType: "PLAYER",
          actorId: user.id,
          source: "BET_DEBIT",
          referenceType: "BET",
          referenceId: createdBet.id,
          metadata: { roundId: activeRound.id, betType: bet.betType },
        },
        client,
      );
      updatedUser = mutation.user;
    }

    const body = { table, round: activeRound, bets, balance: updatedUser.balance };
    await publishLiveEvent(
      { type: "user_changed", userId: user.id, reason: "bet_placed", at: new Date().toISOString() },
      client,
    );
    await completeIdempotencyKey(
      { actorId, scope, key: idempotencyKey, requestHash, statusCode: 200, response: body },
      client,
    );
    return { statusCode: 200, body } as const;
  });

  if (result.statusCode >= 400) {
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
