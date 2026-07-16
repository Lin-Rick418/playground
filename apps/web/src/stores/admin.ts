import { defineStore } from "pinia";
import { adminUsersResponseSchema, type AdminUsersResponse } from "@baccarat/contracts";
import { api } from "../lib/api";
import { parseRuntimeContract } from "../lib/contracts";
import type { Adjustment, AdminUser, RoundBetDetail, RoundWinner } from "../types/domain";

export const useAdminStore = defineStore("admin", {
  state: () => ({
    users: [] as AdminUser[],
    usersPagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } as AdminUsersResponse["pagination"],
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
        const requestedPage = page ?? this.usersPagination.page;
        const [usersRes, adjustmentsRes] = await Promise.all([
          api.get("/admin/users", {
            params: { page: requestedPage, pageSize: this.usersPagination.pageSize },
          }),
          api.get<Adjustment[]>("/admin/adjustments"),
        ]);

        const usersData = parseRuntimeContract(
          adminUsersResponseSchema,
          usersRes.data,
          "GET /admin/users",
        );
        this.users = usersData.items;
        this.usersPagination = usersData.pagination;
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
      const { data } = await api.get<NonNullable<typeof this.roundDetail>>(`/admin/rounds/${roundId}/bets`);
      this.roundDetail = data;
    },
  },
});
