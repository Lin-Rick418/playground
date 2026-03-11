import { defineStore } from "pinia";
import { api } from "../lib/api";

export type User = {
  id: string;
  username: string;
  role: "ADMIN" | "PLAYER";
  isActive: boolean;
  balance: number;
};

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: localStorage.getItem("baccarat_token") ?? "",
    user: null as User | null,
    loading: false,
    error: "",
  }),
  actions: {
    async login(username: string, password: string) {
      this.loading = true;
      this.error = "";

      try {
        const { data } = await api.post("/auth/login", { username, password });
        this.token = data.token;
        this.user = data.user;
        localStorage.setItem("baccarat_token", data.token);
      } catch (error) {
        this.error = "登入失敗，請確認帳號密碼。";
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async fetchMe() {
      const { data } = await api.get("/auth/me");
      this.user = data;
      return data;
    },
    logout() {
      this.token = "";
      this.user = null;
      this.error = "";
      localStorage.removeItem("baccarat_token");
    },
    patchBalance(balance: number) {
      if (this.user) {
        this.user.balance = balance;
      }
    },
  },
});
