import axios from "axios";
import { useAuthStore } from "./auth";
import { defineStore } from "pinia";
import {
  plinkoConfigResponseSchema,
  plinkoHistoryResponseSchema,
  plinkoMutationResponseSchema,
  plinkoRoundResponseSchema,
  plinkoStartRequestSchema,
  type PlinkoRisk,
  type PlinkoMutationResponse,
} from "@baccarat/contracts";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type { PlinkoConfig, PlinkoRound } from "../types/domain";

type Payload = { amount: number; rows: number; risk: PlinkoRisk; ruleVersion: number };
type Pending = { key: string; payload: Payload };

function storageKey(userId: string) {
  return `plinko.pending.${userId}`;
}

function keepPending(error: unknown) {
  return (
    !(
      axios.isAxiosError(error) &&
      error.response?.status === 503 &&
      error.response.data?.code === "SERVICE_UNAVAILABLE"
    ) && shouldReuseIdempotencyKey(error)
  );
}

export function isValidPlinkoStake(amount: number, config: PlinkoConfig | null) {
  return Boolean(
    config &&
    Number.isInteger(amount) &&
    amount >= config.minBet &&
    amount <= config.maxBet &&
    (amount - config.minBet) % config.betStep === 0,
  );
}

export class PendingPlinkoMutationError extends Error {
  constructor() {
    super("上一筆 Plinko 投注仍在確認中，請先確認結果。");
  }
}

export const usePlinkoStore = defineStore("plinko", {
  state: () => ({
    config: null as PlinkoConfig | null,
    history: [] as PlinkoRound[],
    historyNextCursor: null as string | null,
    pending: null as Pending | null,
    requestInFlight: false,
    requestToken: 0,
    storageError: "",
    userId: "",
    generation: 0,
  }),
  actions: {
    acceptResponse(userId: string, generation: number, result: PlinkoMutationResponse) {
      if (!this.isCurrent(userId, generation)) return;
      this.history = [
        result.round,
        ...this.history.filter((round) => round.id !== result.round.id),
      ].slice(0, 50);
      const auth = useAuthStore();
      if (auth.user?.id === userId) auth.patchBalance(result.balance, result.walletVersion);
      this.persist(userId, null);
    },
    isCurrent(userId: string, generation: number) {
      return this.userId === userId && this.generation === generation;
    },
    restorePending(userId: string) {
      if (this.userId && this.userId !== userId) {
        this.history = [];
        this.historyNextCursor = null;
        this.pending = null;
        this.generation += 1;
      }
      this.userId = userId;
      this.storageError = "";
      try {
        const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
        if (value === null) this.pending = null;
        else {
          const candidate = value as Partial<Pending>;
          const payload = plinkoStartRequestSchema.safeParse(candidate.payload);
          if (
            typeof candidate.key !== "string" ||
            candidate.key.length < 8 ||
            candidate.key.length > 128 ||
            !payload.success
          )
            throw new Error("Invalid saved wager");
          this.pending = { key: candidate.key, payload: payload.data };
        }
      } catch {
        this.pending = null;
        this.storageError = "待確認投注資料無法讀取，請聯絡客服核對投注結果。";
      }
    },
    persist(userId: string, pending: Pending | null) {
      if (this.userId !== userId) return;
      this.pending = pending;
      if (pending) sessionStorage.setItem(storageKey(userId), JSON.stringify(pending));
      else sessionStorage.removeItem(storageKey(userId));
    },
    async fetchConfig() {
      const response = await api.get("/plinko/config");
      this.config = parseRuntimeContract(
        plinkoConfigResponseSchema,
        response.data,
        "GET /plinko/config",
      );
      return this.config;
    },
    async fetchHistory(cursor?: string) {
      const userId = this.userId;
      const generation = this.generation;
      const response = await api.get("/plinko/history", {
        params: cursor ? { cursor } : undefined,
      });
      const page = parseRuntimeContract(
        plinkoHistoryResponseSchema,
        response.data,
        "GET /plinko/history",
      );
      if (!this.isCurrent(userId, generation)) return page;
      if (cursor) {
        const ids = new Set(this.history.map((round) => round.id));
        this.history.push(...page.items.filter((round) => !ids.has(round.id)));
      } else this.history = page.items;
      this.historyNextCursor = page.nextCursor;
      return page;
    },
    async place(userId: string, payload: Payload) {
      if (this.requestInFlight || this.storageError) throw new PendingPlinkoMutationError();
      if (this.userId !== userId) this.restorePending(userId);
      const generation = this.generation;
      const previous = this.pending;
      if (previous) throw new PendingPlinkoMutationError();
      const pending = {
        key: createIdempotencyKey(),
        payload: plinkoStartRequestSchema.parse(payload),
      };
      this.persist(userId, pending);
      this.requestInFlight = true;
      const requestToken = ++this.requestToken;
      try {
        const response = await api.post("/plinko/rounds", pending.payload, {
          headers: { "Idempotency-Key": pending.key },
        });
        const result = parseRuntimeContract(
          plinkoMutationResponseSchema,
          response.data,
          "POST /plinko/rounds",
        );
        this.acceptResponse(userId, generation, result);
        return result;
      } catch (error) {
        if (!keepPending(error) && this.isCurrent(userId, generation)) {
          this.persist(userId, null);
          await this.fetchConfig().catch(() => undefined);
        }
        throw error;
      } finally {
        if (requestToken === this.requestToken) this.requestInFlight = false;
      }
    },
    async reconcilePending(userId: string) {
      if (this.requestInFlight || this.storageError) throw new PendingPlinkoMutationError();
      if (this.userId !== userId) this.restorePending(userId);
      const pending = this.pending;
      if (!pending) return null;
      const generation = this.generation;
      this.requestInFlight = true;
      const requestToken = ++this.requestToken;
      try {
        const response = await api.post("/plinko/rounds", pending.payload, {
          headers: { "Idempotency-Key": pending.key },
        });
        const result = parseRuntimeContract(
          plinkoMutationResponseSchema,
          response.data,
          "POST /plinko/rounds replay",
        );
        this.acceptResponse(userId, generation, result);
        return result;
      } catch (error) {
        if (!keepPending(error) && this.isCurrent(userId, generation)) {
          this.persist(userId, null);
          await this.fetchConfig().catch(() => undefined);
        }
        throw error;
      } finally {
        if (requestToken === this.requestToken) this.requestInFlight = false;
      }
    },
    async fetchRound(id: string) {
      const response = await api.get(`/plinko/rounds/${id}`);
      return parseRuntimeContract(
        plinkoRoundResponseSchema,
        response.data,
        "GET /plinko/rounds/:id",
      ).round;
    },
  },
});
