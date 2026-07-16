import { defineStore } from "pinia";
import { api } from "../lib/api";
import type { Adjustment, AdminUser, PaginatedAdminUsers, RoundBetDetail, RoundWinner } from "../types/domain";

export const useAdminStore = defineStore("admin", {
  state: () => ({
    users: [] as AdminUser[],
    userPage: 1,
    userPageSize: 25,
    userTotal: 0,
    userTotalPages: 1,
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
    async fetchDashboard(page?: number) {
      this.loading = true;

      try {
        const requestedPage = page ?? this.userPage;
        const [usersRes, adjustmentsRes] = await Promise.all([
          api.get<PaginatedAdminUsers>("/admin/users", {
            params: { page: requestedPage, pageSize: this.userPageSize },
          }),
          api.get<Adjustment[]>("/admin/adjustments"),
        ]);

        this.users = usersRes.data.items;
        this.userPage = usersRes.data.pagination.page;
        this.userTotal = usersRes.data.pagination.total;
        this.userTotalPages = usersRes.data.pagination.totalPages;
        this.adjustments = adjustmentsRes.data;
      } finally {
        this.loading = false;
      }
    },
    async changeUserPage(page: number) {
      const boundedPage = Math.min(Math.max(1, page), this.userTotalPages);
      await this.fetchDashboard(boundedPage);
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
      const { data } = await api.get<NonNullable<typeof this.roundDetail>>(`/admin/rounds/${roundId}/bets`);
      this.roundDetail = data;
    },
  },
});
