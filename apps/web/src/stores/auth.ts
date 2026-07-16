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
    logout() {
      this.token = "";
      this.user = null;
      this.error = "";
      clearStoredToken();
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
