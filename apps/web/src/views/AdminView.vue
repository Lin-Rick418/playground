<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { useAdminStore } from "../stores/admin";
import { useGameStore } from "../stores/game";
import { useAuthStore } from "../stores/auth";

const authStore = useAuthStore();
const adminStore = useAdminStore();
const gameStore = useGameStore();
const router = useRouter();

const form = reactive({
  userId: "",
  amount: 0,
  note: "",
});

const createForm = reactive({
  username: "",
  password: "",
  balance: 1000,
});
const resetForm = reactive({ userId: "", newPassword: "" });
const resetStatus = ref("");

const playerUsers = computed(() => adminStore.users.filter((user) => user.role === "PLAYER"));
const recentRoundItems = computed(() =>
  gameStore.tables.flatMap((item) =>
    item.recentRounds.map((round) => ({
      ...round,
      tableName: item.table.name,
    })),
  ),
);

async function submitAdjustment() {
  if (!form.userId || form.amount === 0) {
    return;
  }

  await adminStore.adjustBalance(form.userId, form.amount, form.note);
  form.amount = 0;
  form.note = "";
}

async function submitCreatePlayer() {
  if (!createForm.username || !createForm.password) {
    return;
  }

  await adminStore.createPlayer(createForm.username, createForm.password, createForm.balance);
  createForm.username = "";
  createForm.password = "";
  createForm.balance = 1000;
}

async function submitPasswordReset() {
  if (!resetForm.userId || !resetForm.newPassword) return;
  resetStatus.value = "";
  await adminStore.resetPlayerPassword(resetForm.userId, resetForm.newPassword);
  resetForm.newPassword = "";
  resetStatus.value = "玩家密碼已重設，既有登入階段已失效。";
}

async function togglePlayer(userId: string, isActive: boolean) {
  await adminStore.setUserActive(userId, !isActive);
}

async function openRoundDetail(roundId: string) {
  await adminStore.fetchRoundDetail(roundId);
}

function logout() {
  authStore.logout();
  router.push("/login");
}

onMounted(async () => {
  await Promise.all([adminStore.fetchDashboard(), gameStore.fetchLobby()]);
  if (playerUsers.value[0]) {
    form.userId = playerUsers.value[0].id;
    resetForm.userId = playerUsers.value[0].id;
  }
});
</script>

<template>
  <main class="page-shell admin-page">
    <header class="topbar panel">
      <div>
        <p class="topbar-label">Admin Console</p>
        <h1>{{ authStore.user?.username }}</h1>
      </div>
      <div class="topbar-actions">
        <button class="button-secondary" type="button" @click="router.push('/account')">帳號安全</button>
        <button class="button-secondary" @click="logout">登出</button>
      </div>
    </header>

    <section class="admin-grid">
      <section class="panel adjust-panel">
        <div class="section-head">
          <div>
            <p class="topbar-label">Balance</p>
            <h2>手動調整餘額</h2>
          </div>
        </div>

        <div class="adjust-form">
          <div class="sub-block">
            <p class="topbar-label">Create Player</p>
            <label class="field">
              <span>帳號</span>
              <input v-model="createForm.username" placeholder="例如 player2" minlength="3" maxlength="24" pattern="[a-z][a-z0-9_]*" required />
            </label>
            <label class="field">
              <span>密碼</span>
              <input v-model="createForm.password" type="password" minlength="12" maxlength="72" autocomplete="new-password" required />
            </label>
            <label class="field">
              <span>初始金額</span>
              <input v-model.number="createForm.balance" type="number" min="0" max="100000000" step="100" required />
            </label>
            <p class="policy-hint">帳號限小寫英文開頭；密碼需 12–72 字元，包含大小寫、數字與符號；金額以 100 為單位。</p>
            <button class="button-primary" @click="submitCreatePlayer">建立玩家</button>
          </div>

          <div class="sub-block">
            <p class="topbar-label">Reset Player Password</p>
            <label class="field">
              <span>玩家</span>
              <select v-model="resetForm.userId">
                <option v-for="user in playerUsers" :key="user.id" :value="user.id">{{ user.username }}</option>
              </select>
            </label>
            <label class="field">
              <span>新密碼</span>
              <input v-model="resetForm.newPassword" type="password" minlength="12" maxlength="72" autocomplete="new-password" />
            </label>
            <p v-if="resetStatus" class="success-text">{{ resetStatus }}</p>
            <button class="button-primary" type="button" @click="submitPasswordReset">重設密碼</button>
          </div>

          <label class="field">
            <span>玩家</span>
            <select v-model="form.userId">
              <option v-for="user in playerUsers" :key="user.id" :value="user.id">
                {{ user.username }} / {{ user.balance.toLocaleString() }}
              </option>
            </select>
          </label>

          <label class="field">
            <span>調整金額</span>
            <input v-model.number="form.amount" type="number" min="-100000000" max="100000000" step="100" />
          </label>

          <label class="field">
            <span>備註</span>
            <textarea v-model="form.note" rows="3" placeholder="例如：人工補分、活動贈送"></textarea>
          </label>

          <button class="button-primary" @click="submitAdjustment">送出調整</button>
        </div>
      </section>

      <section class="panel users-panel">
        <div class="section-head">
          <div>
            <p class="topbar-label">Players</p>
            <h2>帳號列表</h2>
          </div>
        </div>

        <div class="table-list">
          <article v-for="user in playerUsers" :key="user.id" class="list-row">
            <div>
              <strong>{{ user.username }}</strong>
              <p>{{ user.isActive ? "啟用中" : "已停用" }}</p>
            </div>
            <div class="user-actions">
              <span>{{ user.balance.toLocaleString() }}</span>
              <button class="button-secondary compact-button" @click="togglePlayer(user.id, user.isActive)">
                {{ user.isActive ? "停用" : "啟用" }}
              </button>
            </div>
          </article>
        </div>
      </section>

      <section class="panel logs-panel">
        <div class="section-head">
          <div>
            <p class="topbar-label">Adjustments</p>
            <h2>最近異動</h2>
          </div>
        </div>

        <div class="table-list">
          <article v-for="item in adminStore.adjustments" :key="item.id" class="list-row stacked">
            <div>
              <strong>{{ item.user.username }}</strong>
              <p>{{ item.note || "無備註" }}</p>
            </div>
            <div class="adjustment-side">
              <span>{{ item.amount > 0 ? "+" : "" }}{{ item.amount.toLocaleString() }}</span>
              <small>{{ item.admin.username }}</small>
            </div>
          </article>
        </div>
      </section>

      <section class="panel rounds-panel">
        <div class="section-head">
          <div>
            <p class="topbar-label">Rounds</p>
            <h2>最近局結果</h2>
          </div>
        </div>

        <div class="table-list">
          <article
            v-for="round in recentRoundItems"
            :key="round.id"
            class="list-row stacked clickable"
            @click="openRoundDetail(round.id)"
          >
            <div>
              <strong>{{ round.id.slice(0, 8) }}</strong>
              <p>{{ round.tableName }} / {{ round.winner }} / 閒 {{ round.playerTotal }} / 莊 {{ round.bankerTotal }}</p>
            </div>
          </article>
        </div>
      </section>

      <section class="panel detail-panel">
        <div class="section-head">
          <div>
            <p class="topbar-label">Round Detail</p>
            <h2>單局下注明細</h2>
          </div>
        </div>

        <div v-if="adminStore.roundDetail" class="table-list">
          <article v-for="bet in adminStore.roundDetail.bets" :key="bet.id" class="list-row">
            <div>
              <strong>{{ bet.username }}</strong>
              <p>{{ bet.betType }}</p>
            </div>
            <div class="adjustment-side">
              <span>{{ bet.amount.toLocaleString() }}</span>
              <small>派彩 {{ bet.payout.toLocaleString() }}</small>
            </div>
          </article>
        </div>
        <p v-else class="empty-text">點選左側最近局，查看該局所有下注。</p>
      </section>
    </section>
  </main>
</template>

<style scoped lang="scss">
.admin-page {
  display: flex;
  flex-direction: column;
  gap: $space-6;
}

.topbar,
.adjust-panel,
.users-panel,
.logs-panel {
  padding: $space-5;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: $space-3;
}

.topbar-actions { display: flex; flex-wrap: wrap; gap: $space-3; }
.policy-hint { margin: 0; color: rgba(247, 244, 233, 0.65); font-size: 13px; line-height: 1.5; }
.success-text { margin: 0; color: #8ce6a8; }

.topbar-label {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(247, 244, 233, 0.6);
}

.topbar h1,
.section-head h2 {
  margin: 4px 0 0;
}

.admin-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: $space-4;
}

.adjust-form,
.table-list {
  display: flex;
  flex-direction: column;
  gap: $space-4;
  margin-top: $space-5;
}

.sub-block {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin-bottom: $space-5;
  padding-bottom: $space-5;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.field select {
  width: 100%;
  border: 1px solid rgba(247, 244, 233, 0.18);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  color: #f7f4e9;
  padding: $space-3 $space-4;
}

.list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
  padding: $space-4;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
}

.user-actions {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  gap: $space-3;
}

.compact-button {
  padding: $space-2 $space-3;
}

.clickable {
  cursor: pointer;
}

.list-row.stacked {
  align-items: flex-start;
}

.list-row p,
.adjustment-side small {
  margin: $space-2 0 0;
  color: rgba(247, 244, 233, 0.65);
}

.adjustment-side {
  text-align: right;
}

.empty-text {
  color: rgba(247, 244, 233, 0.65);
  margin-top: $space-5;
}

</style>
