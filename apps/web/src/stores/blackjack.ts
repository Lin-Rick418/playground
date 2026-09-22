import axios from "axios";
import { defineStore } from "pinia";
import {
  blackjackActionSchema,
  blackjackConfigResponseSchema,
  blackjackMutationResponseSchema,
  blackjackRoundResponseSchema,
  blackjackStateResponseSchema,
  type BlackjackAction,
  type BlackjackConfig,
  type BlackjackRound,
} from "@baccarat/contracts";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type { BlackjackTransport } from "../lib/blackjack-rpc";
import { useAuthStore } from "./auth";

type Pending = { key: string; action: BlackjackAction };
const storageKey = (id: string) => `blackjack.pending.${id}`;
const uncertain = (error: unknown) =>
  !(
    axios.isAxiosError(error) &&
    error.response?.status === 503 &&
    error.response.data?.code === "SERVICE_UNAVAILABLE"
  ) && shouldReuseIdempotencyKey(error);

export const useBlackjackStore = defineStore("blackjack", {
  state: () => ({
    config: null as BlackjackConfig | null,
    round: null as BlackjackRound | null,
    pending: null as Pending | null,
    busy: false,
    userId: "",
    generation: 0,
    revision: 0,
    transport: null as BlackjackTransport | null,
  }),
  actions: {
    setUser(userId: string) {
      if (userId === this.userId) return;
      this.userId = userId;
      this.generation++;
      this.revision++;
      this.round = null;
      this.config = null;
      this.pending = null;
      this.busy = false;
      if (!userId) return;
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
        if (
          saved &&
          typeof saved === "object" &&
          "key" in saved &&
          "action" in saved &&
          typeof saved.key === "string" &&
          /^[A-Za-z0-9._:-]{8,128}$/.test(saved.key)
        )
          this.pending = { key: saved.key, action: blackjackActionSchema.parse(saved.action) };
      } catch {
        this.pending = null;
      }
    },
    current(userId: string, generation: number) {
      return this.userId === userId && this.generation === generation;
    },
    persist(pending: Pending | null) {
      if (pending) sessionStorage.setItem(storageKey(this.userId), JSON.stringify(pending));
      else sessionStorage.removeItem(storageKey(this.userId));
      this.pending = pending;
    },
    apply(round: BlackjackRound | null) {
      if (round && this.round?.id === round.id && round.version < this.round.version) return;
      this.round = round;
    },
    async fetchConfig() {
      const userId = this.userId,
        generation = this.generation;
      const response = await api.get("/blackjack/config");
      const config = parseRuntimeContract(
        blackjackConfigResponseSchema,
        response.data,
        "blackjack.config",
      );
      if (this.current(userId, generation)) this.config = config;
    },
    async sync(roundId?: string) {
      const userId = this.userId,
        generation = this.generation,
        revision = ++this.revision;
      const response = await api.get("/blackjack/state");
      const state = parseRuntimeContract(
        blackjackStateResponseSchema,
        response.data,
        "blackjack.state",
      );
      const previous = roundId ?? this.round?.id;
      if (!state.round && previous) {
        const historical = await api.get(`/blackjack/rounds/${previous}`);
        state.round = parseRuntimeContract(
          blackjackRoundResponseSchema,
          historical.data,
          "blackjack.round",
        ).round;
      }
      if (this.current(userId, generation) && revision === this.revision) this.apply(state.round);
    },
    async mutate(action: BlackjackAction) {
      if (this.busy || this.pending) throw new Error("上一個操作仍在確認中。");
      if (!this.transport || !this.userId) throw new Error("Blackjack 連線尚未就緒。");
      const pending = { key: createIdempotencyKey(), action: blackjackActionSchema.parse(action) };
      this.persist(pending);
      this.busy = true;
      const userId = this.userId,
        generation = this.generation,
        revision = ++this.revision;
      try {
        const response = await this.transport({
          idempotencyKey: pending.key,
          action: pending.action,
        });
        const data = parseRuntimeContract(
          blackjackMutationResponseSchema,
          response,
          "blackjack.mutation",
        );
        if (!this.current(userId, generation)) return;
        if (revision === this.revision) this.apply(data.round);
        const auth = useAuthStore();
        if (auth.user?.id === userId) auth.patchBalance(data.balance, data.walletVersion);
        this.persist(null);
      } catch (error) {
        if (this.current(userId, generation) && !uncertain(error)) {
          this.persist(null);
          await this.sync("roundId" in action ? action.roundId : undefined);
          await this.fetchConfig();
        }
        throw error;
      } finally {
        if (this.current(userId, generation)) this.busy = false;
      }
    },
    async reconcile() {
      if (this.busy) return;
      const userId = this.userId,
        generation = this.generation,
        pending = this.pending;
      this.busy = true;
      try {
        await this.sync(
          pending && "roundId" in pending.action ? pending.action.roundId : undefined,
        );
        if (!this.current(userId, generation) || !pending) return;
        if (!this.transport) throw new Error("Blackjack 連線尚未就緒。");
        const response = await this.transport({
          idempotencyKey: pending.key,
          action: pending.action,
        });
        const data = parseRuntimeContract(
          blackjackMutationResponseSchema,
          response,
          "blackjack.reconcile",
        );
        if (!this.current(userId, generation)) return;
        const auth = useAuthStore();
        if (auth.user?.id === userId) auth.patchBalance(data.balance, data.walletVersion);
        await this.sync(data.round.id);
        if (this.current(userId, generation)) this.persist(null);
      } catch (error) {
        if (this.current(userId, generation) && !uncertain(error)) {
          this.persist(null);
          await this.sync();
        }
        throw error;
      } finally {
        if (this.current(userId, generation)) this.busy = false;
      }
    },
  },
});
