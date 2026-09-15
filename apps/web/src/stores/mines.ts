import axios from "axios";
import { defineStore } from "pinia";
import {
  minesActiveResponseSchema,
  minesConfigResponseSchema,
  minesHistoryResponseSchema,
  minesMutationResponseSchema,
  minesRoundResponseSchema,
} from "@baccarat/contracts";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type { MinesConfig, MinesRound } from "../types/domain";

type Pending = { key: string; payload: string; operation: string; roundId?: string };

function shouldKeepPending(error: unknown) {
  // This authenticated business rejection is definitive even though it is a 503.
  if (
    axios.isAxiosError(error) &&
    error.response?.status === 503 &&
    error.response.data?.code === "SERVICE_UNAVAILABLE"
  )
    return false;
  return shouldReuseIdempotencyKey(error);
}

function storageKey(userId: string) {
  return `mines.pending.${userId}`;
}

export function isValidMinesStake(amount: number, config: MinesConfig | null) {
  return Boolean(
    config &&
    Number.isInteger(amount) &&
    amount >= config.minBet &&
    amount <= config.maxBet &&
    (amount - config.minBet) % config.betStep === 0,
  );
}

export class PendingMinesMutationError extends Error {
  constructor() {
    super("上一個 Mines 操作仍在確認中，請等待重試完成。");
  }
}

export const useMinesStore = defineStore("mines", {
  state: () => ({
    config: null as MinesConfig | null,
    round: null as MinesRound | null,
    history: [] as MinesRound[],
    historyNextCursor: null as string | null,
    loading: false,
    message: "",
    pending: null as Pending | null,
    roundRequestVersion: 0,
    userId: "",
    userGeneration: 0,
  }),
  actions: {
    isCurrentUser(userId: string, generation: number) {
      return this.userId === userId && this.userGeneration === generation;
    },
    applyRound(round: MinesRound | null) {
      if (round && this.round?.id === round.id && this.round.version > round.version) return;
      this.round = round;
    },
    restorePending(userId: string) {
      if (this.userId && this.userId !== userId) {
        this.round = null;
        this.history = [];
        this.historyNextCursor = null;
        this.pending = null;
        this.roundRequestVersion += 1;
        this.userGeneration += 1;
      }
      this.userId = userId;
      try {
        this.pending = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
      } catch {
        this.pending = null;
      }
    },
    persistPending(userId: string, pending: Pending | null) {
      if (userId !== this.userId) return;
      this.pending = pending;
      if (pending) sessionStorage.setItem(storageKey(userId), JSON.stringify(pending));
      else sessionStorage.removeItem(storageKey(userId));
    },
    async fetchConfig() {
      const response = await api.get("/mines/config");
      this.config = parseRuntimeContract(
        minesConfigResponseSchema,
        response.data,
        "GET /mines/config",
      );
      return this.config;
    },
    async fetchActive() {
      const requestVersion = ++this.roundRequestVersion;
      const userId = this.userId;
      const generation = this.userGeneration;
      const response = await api.get("/mines/active");
      const data = parseRuntimeContract(
        minesActiveResponseSchema,
        response.data,
        "GET /mines/active",
      );
      if (this.isCurrentUser(userId, generation) && requestVersion === this.roundRequestVersion)
        this.applyRound(data.round);
      return data.round;
    },
    async fetchRound(roundId: string) {
      const requestVersion = ++this.roundRequestVersion;
      const userId = this.userId;
      const generation = this.userGeneration;
      const response = await api.get(`/mines/rounds/${roundId}`);
      const data = parseRuntimeContract(
        minesRoundResponseSchema,
        response.data,
        "GET /mines/rounds/:id",
      );
      if (this.isCurrentUser(userId, generation) && requestVersion === this.roundRequestVersion)
        this.applyRound(data.round);
      return data.round;
    },
    async fetchHistory(cursor?: string) {
      const userId = this.userId;
      const generation = this.userGeneration;
      const response = await api.get("/mines/history", { params: cursor ? { cursor } : undefined });
      const page = parseRuntimeContract(
        minesHistoryResponseSchema,
        response.data,
        "GET /mines/history",
      );
      if (!this.isCurrentUser(userId, generation)) return page;
      if (cursor) {
        const seen = new Set(this.history.map((round) => round.id));
        this.history.push(...page.items.filter((round) => !seen.has(round.id)));
      } else this.history = page.items;
      this.historyNextCursor = page.nextCursor;
      return page;
    },
    async mutation(
      userId: string,
      operation: string,
      url: string,
      payload: object,
      roundId?: string,
    ) {
      if (this.userId !== userId) this.restorePending(userId);
      const generation = this.userGeneration;
      const payloadText = JSON.stringify(payload);
      const current = this.pending;
      if (
        current &&
        (current.operation !== operation ||
          current.payload !== payloadText ||
          current.roundId !== roundId)
      ) {
        throw new PendingMinesMutationError();
      }
      const pending =
        current &&
        current.operation === operation &&
        current.payload === payloadText &&
        current.roundId === roundId
          ? current
          : { key: createIdempotencyKey(), payload: payloadText, operation, roundId };
      this.persistPending(userId, pending);
      const requestVersion = ++this.roundRequestVersion;
      try {
        const response = await api.post(url, payload, {
          headers: { "Idempotency-Key": pending.key },
        });
        const data = parseRuntimeContract(
          minesMutationResponseSchema,
          response.data,
          `POST ${url}`,
        );
        if (this.isCurrentUser(userId, generation) && requestVersion === this.roundRequestVersion)
          this.applyRound(data.round);
        if (this.isCurrentUser(userId, generation)) this.persistPending(userId, null);
        return data;
      } catch (error) {
        if (!shouldKeepPending(error) && this.isCurrentUser(userId, generation)) {
          this.persistPending(userId, null);
          await this.fetchConfig();
          if (roundId) await this.fetchRound(roundId);
          else await this.fetchActive();
        }
        throw error;
      }
    },
    async reconcilePending(userId: string) {
      if (this.userId !== userId) this.restorePending(userId);
      const generation = this.userGeneration;
      const pending = this.pending;
      if (!pending) return;
      if (pending.operation === "start") {
        await this.fetchActive();
        if (!this.isCurrentUser(userId, generation)) return;
        if (this.round) {
          this.persistPending(userId, null);
          return;
        }
      }
      if (pending.roundId) {
        await this.fetchRound(pending.roundId);
      }
      if (!this.isCurrentUser(userId, generation)) return;
      if (this.round && this.round.status !== "ACTIVE") this.persistPending(userId, null);
      if (!this.pending) return;
      const url =
        pending.operation === "start"
          ? "/mines/rounds"
          : pending.operation === "reveal"
            ? `/mines/rounds/${pending.roundId}/reveal`
            : `/mines/rounds/${pending.roundId}/cashout`;
      try {
        await api.post(url, JSON.parse(pending.payload), {
          headers: { "Idempotency-Key": pending.key },
        });
        if (!this.isCurrentUser(userId, generation)) return;
        // The replay response can be an older idempotency snapshot. Re-read the
        // current round so a subsequent reveal/cashout cannot be regressed.
        if (pending.roundId) await this.fetchRound(pending.roundId);
        else await this.fetchActive();
        this.persistPending(userId, null);
      } catch (error) {
        if (!shouldKeepPending(error) && this.isCurrentUser(userId, generation)) {
          this.persistPending(userId, null);
          await this.fetchConfig();
          if (pending.roundId) await this.fetchRound(pending.roundId);
          else await this.fetchActive();
        }
        throw error;
      }
    },
    start(userId: string, amount: number, mineCount: number) {
      return this.mutation(userId, "start", "/mines/rounds", { amount, mineCount });
    },
    reveal(userId: string, roundId: string, cellIndex: number) {
      return this.mutation(
        userId,
        "reveal",
        `/mines/rounds/${roundId}/reveal`,
        { cellIndex },
        roundId,
      );
    },
    cashout(userId: string, roundId: string) {
      return this.mutation(userId, "cashout", `/mines/rounds/${roundId}/cashout`, {}, roundId);
    },
  },
});
