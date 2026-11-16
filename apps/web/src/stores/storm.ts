import axios from "axios";
import { defineStore } from "pinia";
import {
  stormActionSchema,
  stormConfigResponseSchema,
  stormMutationResponseSchema,
  stormStateResponseSchema,
  type StormAction,
  type StormConfig,
  type StormSession,
  type StormRound,
  type StormStateResponse,
} from "@baccarat/contracts";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type { StormTransport } from "../lib/storm-rpc";
import { useAuthStore } from "./auth";

type Pending = { key: string; action: StormAction };
const storageKey = (id: string) => `storm.pending.${id}`;

export const useStormStore = defineStore("storm", {
  state: () => ({
    userId: "",
    generation: 0,
    requestToken: 0,
    requestInFlight: false,
    session: null as StormSession | null,
    lastRound: null as StormRound | null,
    recent: [] as StormStateResponse["recent"],
    config: null as StormConfig | null,
    pending: null as Pending | null,
    storageError: "",
    transport: null as StormTransport | null,
  }),
  actions: {
    isCurrent(id: string, generation: number) {
      return this.userId === id && this.generation === generation && useAuthStore().user?.id === id;
    },
    bind(id: string) {
      if (id === this.userId) return;
      this.generation++;
      this.requestToken++;
      this.requestInFlight = false;
      this.userId = id;
      this.session = null;
      this.lastRound = null;
      this.recent = [];
      this.config = null;
      this.pending = null;
      this.storageError = "";
      if (!id) return;
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null");
        if (saved !== null) {
          const candidate = saved as Partial<Pending>;
          const action = stormActionSchema.parse(candidate.action);
          if (typeof candidate.key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(candidate.key))
            throw new Error("Invalid pending key");
          this.pending = { key: candidate.key, action };
        }
      } catch {
        this.storageError = "待確認投注資料無法讀取，請聯絡客服核對投注結果。";
      }
    },
    persist(pending: Pending | null) {
      // Persist before sending so a reload can only replay the same wager.
      try {
        if (pending) sessionStorage.setItem(storageKey(this.userId), JSON.stringify(pending));
        else sessionStorage.removeItem(storageKey(this.userId));
        this.pending = pending;
      } catch {
        this.storageError = "無法保存投注確認資料，請允許此網站使用儲存空間。";
        throw new Error(this.storageError);
      }
    },
    async refresh() {
      const id = this.userId,
        generation = this.generation;
      if (!id) return;
      const [configResponse, stateResponse] = await Promise.all([
        api.get("/storm/config"),
        api.get("/storm/state"),
      ]);
      const config = parseRuntimeContract(
        stormConfigResponseSchema,
        configResponse.data,
        "GET /storm/config",
      );
      const state = parseRuntimeContract(
        stormStateResponseSchema,
        stateResponse.data,
        "GET /storm/state",
      );
      if (!this.isCurrent(id, generation)) return;
      this.config = config;
      if (!this.session || state.session.version >= this.session.version) {
        this.session = state.session;
        this.lastRound = state.lastRound;
        this.recent = state.recent;
      }
      useAuthStore().patchBalance(state.balance, state.walletVersion);
    },
    async spin(amount: number) {
      if (!this.isCurrent(this.userId, this.generation))
        throw new Error("帳戶已變更，請重新同步。");
      if (!this.session || this.requestInFlight || this.storageError)
        throw new Error(this.storageError || "遊戲狀態尚未就緒。");
      const id = this.userId,
        generation = this.generation;
      const pending = this.pending ?? {
        key: createIdempotencyKey(),
        action: stormActionSchema.parse({
          kind: "spin",
          amount,
          expectedVersion: this.session.version,
          ruleVersion: this.session.ruleVersion,
          mathProfileId: this.session.mathProfile?.id ?? null,
        }),
      };
      this.persist(pending);
      this.requestInFlight = true;
      const token = ++this.requestToken;
      try {
        if (!this.transport) throw new Error("正在連線，請稍後確認本次結果。");
        const result = parseRuntimeContract(
          stormMutationResponseSchema,
          await this.transport({ action: pending.action, idempotencyKey: pending.key }),
          "WS storm.spin",
        );
        if (!this.isCurrent(id, generation)) return null;
        this.persist(null);
        useAuthStore().patchBalance(result.balance, result.walletVersion);
        // A replay may predate a state snapshot from another tab.
        if (result.session.version < this.session.version) return null;
        this.session = result.session;
        this.lastRound = result.round;
        const entry = {
          id: result.round.id,
          amount: result.round.result.cost,
          stake: result.round.amount,
          payout: result.round.result.payout,
          wasFree: result.round.result.wasFree,
          createdAt: result.round.createdAt,
        };
        this.recent = [entry, ...this.recent.filter((r) => r.id !== entry.id)].slice(0, 5);
        return result;
      } catch (error) {
        const unavailable =
          axios.isAxiosError(error) &&
          error.response?.status === 503 &&
          error.response.data?.code === "SERVICE_UNAVAILABLE";
        if (this.isCurrent(id, generation) && (unavailable || !shouldReuseIdempotencyKey(error))) {
          this.persist(null);
          await this.refresh().catch(() => undefined);
        }
        throw error;
      } finally {
        if (token === this.requestToken) this.requestInFlight = false;
      }
    },
  },
});
