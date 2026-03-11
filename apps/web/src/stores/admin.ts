import { defineStore } from "pinia";
import { api } from "../lib/api";

export type AdminUser = {
  id: string;
  username: string;
  role: "ADMIN" | "PLAYER";
  isActive: boolean;
  balance: number;
  createdAt: string;
};

export type Adjustment = {
  id: string;
  amount: number;
  note?: string;
  createdAt: string;
  admin: {
    username: string;
  };
  user: {
    username: string;
  };
};

export type RoundBetDetail = {
  id: string;
  userId: string;
  username: string;
  roundId: string;
  betType: "PLAYER" | "BANKER" | "TIE";
  amount: number;
  payout: number;
  createdAt: string;
};

export const useAdminStore = defineStore("admin", {
  state: () => ({
    users: [] as AdminUser[],
    adjustments: [] as Adjustment[],
    roundDetail: null as null | {
      round: {
        id: string;
        winner: "PLAYER" | "BANKER" | "TIE";
        playerTotal: number;
        bankerTotal: number;
      };
      bets: RoundBetDetail[];
    },
    loading: false,
  }),
  actions: {
    async fetchDashboard() {
      this.loading = true;

      try {
        const [usersRes, adjustmentsRes] = await Promise.all([
          api.get("/admin/users"),
          api.get("/admin/adjustments"),
        ]);

        this.users = usersRes.data;
        this.adjustments = adjustmentsRes.data;
      } finally {
        this.loading = false;
      }
    },
    async adjustBalance(userId: string, amount: number, note: string) {
      await api.post("/admin/adjust-balance", {
        userId,
        amount,
        note: note || undefined,
      });

      await this.fetchDashboard();
    },
    async createPlayer(username: string, password: string, balance: number) {
      await api.post("/admin/players", { username, password, balance });
      await this.fetchDashboard();
    },
    async setUserActive(userId: string, isActive: boolean) {
      await api.post("/admin/users/set-active", { userId, isActive });
      await this.fetchDashboard();
    },
    async fetchRoundDetail(roundId: string) {
      const { data } = await api.get(`/admin/rounds/${roundId}/bets`);
      this.roundDetail = data;
    },
  },
});
