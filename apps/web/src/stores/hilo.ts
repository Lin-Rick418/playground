import axios from "axios";
import { defineStore } from "pinia";
import {
  hiloActionSchema,
  hiloConfigResponseSchema,
  hiloStateResponseSchema,
  hiloRoundResponseSchema,
  hiloMutationResponseSchema,
  type HiloConfig,
  type HiloRound,
  type HiloPreview,
  type HiloAction,
} from "@baccarat/contracts";
import { api, createIdempotencyKey, shouldReuseIdempotencyKey } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type { HiloTransport } from "../lib/hilo-rpc";
import { useAuthStore } from "./auth";

type Pending = { key: string; action: HiloAction };
const storageKey = (id: string) => `hilo.pending.${id}`;
function uncertain(error: unknown) {
  if (
    axios.isAxiosError(error) &&
    error.response?.status === 503 &&
    error.response.data?.code === "SERVICE_UNAVAILABLE"
  )
    return false;
  return shouldReuseIdempotencyKey(error);
}
export const useHiloStore = defineStore("hilo", {
  state: () => ({
    config: null as HiloConfig | null,
    round: null as HiloRound | null,
    preview: null as HiloPreview | null,
    pending: null as Pending | null,
    userId: "",
    generation: 0,
    revision: 0,
    busy: false,
    transport: null as HiloTransport | null,
  }),
  actions: {
    setUser(userId: string) {
      if (this.userId === userId) return;
      this.userId = userId;
      this.generation++;
      this.revision++;
      this.round = null;
      this.preview = null;
      this.pending = null;
      this.config = null;
      this.busy = false;
      if (!userId) return;
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
        if (saved && typeof saved.key === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(saved.key))
          this.pending = { key: saved.key, action: hiloActionSchema.parse(saved.action) };
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
    apply(round: HiloRound | null, preview: HiloPreview | null) {
      if (round && this.round?.id === round.id && round.version < this.round.version) return;
      if (preview && this.preview?.id === preview.id && preview.version < this.preview.version)
        return;
      this.round = round;
      this.preview = preview;
    },
    async fetchConfig() {
      const id = this.userId,
        generation = this.generation;
      const response = await api.get("/hilo/config");
      const config = parseRuntimeContract(hiloConfigResponseSchema, response.data, "hilo.config");
      if (this.current(id, generation)) this.config = config;
    },
    async sync(roundId?: string) {
      const id = this.userId,
        generation = this.generation,
        revision = ++this.revision;
      const response = await api.get("/hilo/state");
      const state = parseRuntimeContract(hiloStateResponseSchema, response.data, "hilo.state");
      const previous = roundId ?? this.round?.id;
      if (!state.round && previous) {
        const response = await api.get(`/hilo/rounds/${previous}`);
        state.round = parseRuntimeContract(
          hiloRoundResponseSchema,
          response.data,
          "hilo.round",
        ).round;
      }
      if (this.current(id, generation) && revision === this.revision)
        this.apply(state.round, state.preview);
    },
    async mutate(action: HiloAction) {
      if (this.busy || this.pending) throw new Error("上一個操作仍在確認中。");
      if (!this.transport || !this.userId) throw new Error("Hi-Lo 連線尚未就緒。");
      const pending = { key: createIdempotencyKey(), action: hiloActionSchema.parse(action) };
      this.persist(pending);
      this.busy = true;
      const id = this.userId,
        generation = this.generation,
        revision = ++this.revision;
      try {
        const response = await this.transport({
          idempotencyKey: pending.key,
          action: pending.action,
        });
        const data = parseRuntimeContract(hiloMutationResponseSchema, response, "hilo.mutation");
        if (!this.current(id, generation)) return;
        if (revision === this.revision) this.apply(data.round, data.preview);
        const auth = useAuthStore();
        if (auth.user?.id === id) auth.patchBalance(data.balance, data.walletVersion);
        this.persist(null);
      } catch (error) {
        if (this.current(id, generation) && !uncertain(error)) {
          this.persist(null);
          await this.sync("roundId" in action ? action.roundId : undefined);
          await this.fetchConfig();
        }
        throw error;
      } finally {
        if (this.current(id, generation)) this.busy = false;
      }
    },
    async reconcile() {
      if (this.busy) return;
      const id = this.userId,
        generation = this.generation;
      this.busy = true;
      const pending = this.pending;
      try {
        await this.sync(
          pending && "roundId" in pending.action ? pending.action.roundId : undefined,
        );
        if (!this.current(id, generation) || !pending) return;
        if (!this.transport) throw new Error("Hi-Lo 連線尚未就緒。");
        const response = await this.transport({
          idempotencyKey: pending.key,
          action: pending.action,
        });
        const data = parseRuntimeContract(hiloMutationResponseSchema, response, "hilo.reconcile");
        if (!this.current(id, generation)) return;
        const auth = useAuthStore();
        if (auth.user?.id === id) auth.patchBalance(data.balance, data.walletVersion);
        // Replays contain historical snapshots. Never apply their preview/round directly.
        await this.sync(data.round?.id);
        if (this.current(id, generation)) this.persist(null);
      } catch (error) {
        if (this.current(id, generation) && !uncertain(error)) {
          this.persist(null);
          await this.sync();
        }
        throw error;
      } finally {
        if (this.current(id, generation)) this.busy = false;
      }
    },
  },
});
