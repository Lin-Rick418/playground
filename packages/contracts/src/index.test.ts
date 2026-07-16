import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  liveClientMessageSchema,
  liveServerMessageSchema,
  loginRequestSchema,
  loginResponseSchema,
  tableStateResponseSchema,
} from "./index.js";

const now = "2026-07-16T10:00:00.000Z";
const user = {
  id: "user-1",
  username: "player1",
  role: "PLAYER",
  isActive: true,
  balance: 1000,
} as const;
const table = {
  id: "table-1",
  code: "A01",
  name: "Table A01",
  displayOrder: 1,
  roundDurationMs: 15000,
  roundPhaseOffsetMs: 0,
  roundScheduleVersion: 1,
  minBet: 100,
  maxBet: 10000,
  createdAt: now,
};
const round = {
  id: "round-1",
  tableId: table.id,
  shoeId: "shoe-1",
  status: "OPEN",
  bettingOpensAt: now,
  bettingClosesAt: now,
  settledAt: null,
  playerCards: [],
  bankerCards: [],
  playerTotal: 0,
  bankerTotal: 0,
  winner: "TIE",
  playerPair: false,
  bankerPair: false,
  createdAt: now,
} as const;
const config = {
  revealWindowMs: 1000,
  dealAnimationBufferMs: 500,
  cutCardMinRemaining: 10,
  cutCardMaxRemaining: 20,
  reshuffleRule: "cut-card",
};
const tableState = {
  table,
  round,
  previousRound: null,
  presentation: null,
  shoeStatus: { isLastHand: false, cutCardReached: false },
  recentRounds: [],
  roadRounds: [],
  serverTime: now,
  myBets: [],
  balance: 1000,
  config,
};

describe("shared API contracts", () => {
  it("validates auth requests and responses strictly", () => {
    assert.equal(loginRequestSchema.parse({ username: "player1", password: "secret" }).username, "player1");
    assert.equal(loginResponseSchema.parse({ token: "jwt", accessTokenExpiresAt: now, user }).user.role, "PLAYER");
    assert.equal(loginRequestSchema.safeParse({ username: "player1", password: "secret", role: "ADMIN" }).success, false);
    assert.equal(
      loginResponseSchema.safeParse({ token: "jwt", accessTokenExpiresAt: now, user: { ...user, role: "ADMIN" } }).success,
      false,
    );
  });

  it("fails closed on nested table and live snapshot drift", () => {
    assert.equal(tableStateResponseSchema.safeParse(tableState).success, true);
    assert.equal(
      tableStateResponseSchema.safeParse({
        ...tableState,
        round: { ...round, status: "UNKNOWN" },
      }).success,
      false,
    );
    const { myBets: _myBets, balance: _balance, ...tableSnapshot } = tableState;
    assert.equal(
      liveServerMessageSchema.safeParse({
        type: "table_snapshot",
        data: tableSnapshot,
      }).success,
      true,
    );
    assert.equal(
      liveServerMessageSchema.safeParse({
        type: "table_snapshot",
        data: { ...tableSnapshot, round: { ...round, winner: "VOID" } },
      }).success,
      false,
    );
  });

  it("rejects unknown or incomplete live subscription messages", () => {
    assert.equal(liveClientMessageSchema.safeParse({ type: "subscribe_table", tableId: "table-1" }).success, true);
    assert.equal(liveClientMessageSchema.safeParse({ type: "subscribe_table" }).success, false);
    assert.equal(liveClientMessageSchema.safeParse({ type: "subscribe_lobby", admin: true }).success, false);
    assert.equal(
      liveServerMessageSchema.safeParse({ type: "auth_revoked", reason: "account_disabled" }).success,
      true,
    );
  });
});
