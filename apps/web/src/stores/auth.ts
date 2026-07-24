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
  }),
  actions: {
    async login(username: string, password: string) {
      this.loading = true;
      this.error = "";

      try {
        const response = await api.post("/auth/login", { username, password });
        const data = parseRuntimeContract(loginResponseSchema, response.data, "POST /auth/login");
        this.token = data.token;
        this.user = data.user;
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
    async fetchMe() {
      const response = await api.get("/auth/me");
      const data = parseRuntimeContract(userSchema, response.data, "GET /auth/me");
      this.user = data;
      return data;
    },
    async refreshAccessToken() {
      const response = await api.post("/auth/refresh");
      const data = parseRuntimeContract(loginResponseSchema, response.data, "POST /auth/refresh");
      this.token = data.token;
      this.user = data.user;
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
      this.user = data.user;
      this.accessTokenExpiresAt = data.accessTokenExpiresAt;
      setStoredToken(data.token);
      return data.user;
    },
    invalidateSession(message = "") {
      this.token = "";
      this.user = null;
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
      this.user = user;
    },
    patchBalance(balance: number) {
      if (this.user) {
        this.user.balance = balance;
      }
    },
  },
});
