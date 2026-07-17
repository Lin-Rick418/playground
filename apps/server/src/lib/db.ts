export { pool, withTransaction } from "./repositories/client.js";
export { initializeDatabase } from "./repositories/initialize.js";
export {
  applyBalanceMutation,
  createPlayer,
  findTableById,
  findUserById,
  findUserByUsername,
  listTables,
  reconcileAllUserBalances,
  reconcileUserBalance,
  setUserActive,
  updateUserPasswordHash,
} from "./repositories/users.js";
export { claimIdempotencyKey, completeIdempotencyKey, type IdempotencyClaim } from "./repositories/idempotency-store.js";
export { getServiceHeartbeat, recordServiceHeartbeat, type ServiceHeartbeat } from "./repositories/heartbeat.js";
export {
  createAuthSession,
  isAuthSessionActive,
  revokeAuthSessionByRefreshTokenHash,
  revokeAuthSessionsByUserId,
  rotateAuthSession,
  type AuthSession,
} from "./repositories/auth-sessions.js";
export {
  createBet,
  createRound,
  findRoundById,
  getActiveRound,
  getUserDailyProfit,
  getUserUnsettledMaximumPayout,
  listRecentSettledRounds,
  listRecentSettledRoundsByShoe,
  listRoundBets,
  listRoundBetsDetailed,
  listUserHistory,
  listUserRoundBets,
  setTableRoundScheduleVersion,
  updateBetPayouts,
  updateRoundStatus,
} from "./repositories/rounds.js";
export { cancelRoundAndRefundBets, createBalanceAdjustment, purgeSettledRoundsBefore, settleRound } from "./repositories/round-lifecycle.js";
export {
  ensureTableShoe,
  getShoeAuditBundle,
  getShoeCommitment,
  getTableShoe,
  recordShoeDealAudit,
  replaceTableShoe,
  saveTableShoe,
  validateActiveShoeAudit,
} from "./repositories/shoes.js";
export { buildLobbyTables, buildTablePublicState, buildTableUserState, buildUserLiveState, listAdjustments } from "./repositories/view-models.js";
export { ensureSeedData } from "./repositories/seed.js";
