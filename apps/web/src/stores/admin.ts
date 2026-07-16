import { defineStore } from "pinia";
import { api } from "../lib/api";
import type { Adjustment, AdminUser, RoundBetDetail, RoundWinner } from "../types/domain";

export const useAdminStore = defineStore("admin", {
  state: () => ({
    users: [] as AdminUser[],
    adjustments: [] as Adjustment[],
    roundDetail: null as null | {
      round: {
        id: string;
        winner: RoundWinner;
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
          api.get<AdminUser[]>("/admin/users"),
          api.get<Adjustment[]>("/admin/adjustments"),
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
    async resetPlayerPassword(userId: string, newPassword: string) {
      await api.post("/admin/players/reset-password", { userId, newPassword });
    },
    async fetchRoundDetail(roundId: string) {
      const { data } = await api.get<NonNullable<typeof this.roundDetail>>(`/admin/rounds/${roundId}/bets`);
      this.roundDetail = data;
    },
  },
});
