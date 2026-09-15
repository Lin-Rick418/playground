import { defineStore } from "pinia";
import { loginResponseSchema, userSchema } from "@baccarat/contracts";
import { api } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import { clearStoredToken, getStoredToken, setStoredToken } from "../lib/settings";
import type { User } from "../types/domain";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: getStoredToken(),
    user: null as User | null,
    accessTokenExpiresAt: "",
    initialized: false,
    loading: false,
    error: "",
    userSnapshotRevision: 0,
    walletVersion: null as number | null,
  }),
  actions: {
    applyUserSnapshot(user: User | null) {
      if (!user) {
        this.user = null;
        this.walletVersion = null;
        this.userSnapshotRevision += 1;
        return null;
      }

      const incomingVersion = user.walletVersion ?? null;
      const sameUser = this.user?.id === user.id;
      const rejectsBalance = sameUser && this.walletVersion !== null && (incomingVersion === null || incomingVersion < this.walletVersion);
      this.user = rejectsBalance && this.user
        ? { ...user, balance: this.user.balance, ...(this.walletVersion === null ? {} : { walletVersion: this.walletVersion }) }
        : user;
      if (!rejectsBalance) this.walletVersion = incomingVersion;
      this.userSnapshotRevision += 1;
      return this.user;
    },
    async login(username: string, password: string) {
      this.loading = true;
      this.error = "";

      try {
        const response = await api.post("/auth/login", { username, password });
        const data = parseRuntimeContract(loginResponseSchema, response.data, "POST /auth/login");
        this.token = data.token;
        this.applyUserSnapshot(data.user);
        this.accessTokenExpiresAt = data.accessTokenExpiresAt;
        this.initialized = true;
        setStoredToken(data.token);
        return data.user;
      } catch (error) {
        this.error = "登入失敗，請確認帳號密碼。";
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async fetchMe(options: { preserveNewerLiveSnapshot?: boolean } = {}) {
      const revisionAtRequest = this.userSnapshotRevision;
      const userIdAtRequest = this.user?.id;
      const tokenAtRequest = this.token;
      const response = await api.get("/auth/me");
      const data = parseRuntimeContract(userSchema, response.data, "GET /auth/me");
      // A wallet refresh from a previous login must never restore or replace that account.
      if (this.user?.id !== userIdAtRequest || this.token !== tokenAtRequest) return this.user ?? data;
      if (options.preserveNewerLiveSnapshot && revisionAtRequest !== this.userSnapshotRevision && data.walletVersion === undefined) {
        return this.user ?? data;
      }
      return this.applyUserSnapshot(data) ?? data;
    },
    async refreshAccessToken() {
      const response = await api.post("/auth/refresh");
      const data = parseRuntimeContract(loginResponseSchema, response.data, "POST /auth/refresh");
      this.token = data.token;
      this.applyUserSnapshot(data.user);
      this.accessTokenExpiresAt = data.accessTokenExpiresAt;
      setStoredToken(data.token);
      return data;
    },
    async restoreSession() {
      if (this.initialized) {
        return this.user;
      }

      try {
        const data = await this.refreshAccessToken();
        return data.user;
      } catch {
        this.token = "";
        this.user = null;
        this.accessTokenExpiresAt = "";
        clearStoredToken();
        return null;
      } finally {
        this.initialized = true;
      }
    },
    async ensureFreshAccessToken(minValidityMs = 30_000) {
      const expiresAt = new Date(this.accessTokenExpiresAt).getTime();
      if (this.token && Number.isFinite(expiresAt) && expiresAt - Date.now() > minValidityMs) {
        return this.token;
      }

      return (await this.refreshAccessToken()).token;
    },
    async changePassword(currentPassword: string, newPassword: string) {
      const response = await api.post("/auth/change-password", { currentPassword, newPassword });
      const data = parseRuntimeContract(
        loginResponseSchema,
        response.data,
        "POST /auth/change-password",
      );
      this.token = data.token;
      this.applyUserSnapshot(data.user);
      this.accessTokenExpiresAt = data.accessTokenExpiresAt;
      setStoredToken(data.token);
      return data.user;
    },
    invalidateSession(message = "") {
      this.token = "";
      this.user = null;
      this.walletVersion = null;
      this.accessTokenExpiresAt = "";
      this.initialized = true;
      this.error = message;
      clearStoredToken();
    },
    logout() {
      void api.post("/auth/logout").catch(() => undefined);
      this.invalidateSession();
    },
    setUser(user: User | null) {
      this.applyUserSnapshot(user);
    },
    patchBalance(balance: number, walletVersion?: number) {
      if (this.user && !(this.walletVersion !== null && (walletVersion === undefined || walletVersion < this.walletVersion))) {
        this.user.balance = balance;
        if (walletVersion !== undefined) {
          this.walletVersion = walletVersion;
          this.user.walletVersion = walletVersion;
        }
        this.userSnapshotRevision += 1;
      }
    },
  },
});
