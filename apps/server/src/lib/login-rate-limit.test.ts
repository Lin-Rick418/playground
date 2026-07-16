import assert from "node:assert/strict";
import test from "node:test";
import {
  createLoginRateLimitAttempt,
  LoginRateLimiter,
  type LoginRateLimitIncrement,
  type LoginRateLimitKey,
  type LoginRateLimitPolicy,
  type LoginRateLimitState,
  type LoginRateLimitStore,
  type LoginRateLimitScope,
} from "./login-rate-limit.js";
import { PostgresLoginRateLimitStore } from "./postgres-login-rate-limit-store.js";

function stateId(key: LoginRateLimitKey) {
  return `${key.scope}:${key.keyHash}`;
}

class MemoryLoginRateLimitStore implements LoginRateLimitStore {
  readonly states = new Map<string, LoginRateLimitState>();
  pruneCalls = 0;

  async get(keys: LoginRateLimitKey[], nowMs: number) {
    return keys.flatMap((key) => {
      const state = this.states.get(stateId(key));
      return state && state.expiresAtMs > nowMs ? [{ ...state }] : [];
    });
  }

  async increment(increments: LoginRateLimitIncrement[], nowMs: number) {
    return increments.map((increment) => {
      const id = stateId(increment);
      const current = this.states.get(id);
      const state =
        !current || current.expiresAtMs <= nowMs
          ? {
              scope: increment.scope,
              keyHash: increment.keyHash,
              failures: 1,
              expiresAtMs: nowMs + increment.windowMs,
            }
          : { ...current, failures: current.failures + 1 };

      this.states.set(id, state);
      return { ...state };
    });
  }

  async clear(keys: LoginRateLimitKey[]) {
    for (const key of keys) this.states.delete(stateId(key));
  }

  async pruneExpired(nowMs: number, limit: number) {
    this.pruneCalls += 1;
    let deleted = 0;

    for (const [id, state] of this.states) {
      if (deleted >= limit) break;
      if (state.expiresAtMs <= nowMs) {
        this.states.delete(id);
        deleted += 1;
      }
    }

    return deleted;
  }

  stateFor(attempt: ReturnType<typeof createLoginRateLimitAttempt>, scope: LoginRateLimitScope) {
    const key = attempt.keys.find((candidate) => candidate.scope === scope)!;
    return this.states.get(stateId(key));
  }
}

function policies(overrides: Partial<Record<LoginRateLimitScope, number>> = {}) {
  return [
    {
      scope: "ACCOUNT_IP",
      maxFailures: overrides.ACCOUNT_IP ?? 5,
      windowMs: 1_000,
      hardBlock: true,
    },
    {
      scope: "ACCOUNT",
      maxFailures: overrides.ACCOUNT ?? 10,
      windowMs: 1_000,
      hardBlock: true,
    },
    {
      scope: "IP",
      maxFailures: overrides.IP ?? 20,
      windowMs: 1_000,
      hardBlock: false,
    },
  ] satisfies LoginRateLimitPolicy[];
}

test("successful authentication clears account failures without consuming or clearing shared IP failures", async () => {
  const store = new MemoryLoginRateLimitStore();
  const limiter = new LoginRateLimiter(store, policies());
  const attempt = createLoginRateLimitAttempt("Player1", "203.0.113.8");

  await limiter.recordFailure(attempt);
  await limiter.recordSuccess(attempt);
  await limiter.recordSuccess(attempt);

  assert.equal(store.stateFor(attempt, "ACCOUNT_IP"), undefined);
  assert.equal(store.stateFor(attempt, "ACCOUNT"), undefined);
  assert.equal(store.stateFor(attempt, "IP")?.failures, 1);
  assert.equal((await limiter.inspect(attempt)).hardBlocked, false);
});

test("expired windows are ignored, pruned, and reset on the next failure", async () => {
  let nowMs = 10_000;
  const store = new MemoryLoginRateLimitStore();
  const limiter = new LoginRateLimiter(store, policies({ ACCOUNT_IP: 1 }), {
    now: () => nowMs,
  });
  const attempt = createLoginRateLimitAttempt("player1", "203.0.113.8");

  assert.equal((await limiter.recordFailure(attempt)).hardBlocked, true);
  nowMs += 1_001;

  assert.deepEqual(await limiter.inspect(attempt), { limitedScopes: [], hardBlocked: false });
  assert.ok(store.pruneCalls > 0);
  await limiter.recordFailure(attempt);
  assert.equal(store.stateFor(attempt, "ACCOUNT_IP")?.failures, 1);
  assert.equal(store.stateFor(attempt, "ACCOUNT_IP")?.expiresAtMs, nowMs + 1_000);
});

test("prunes expired entries even when the store is far below a size threshold", async () => {
  const nowMs = 50_000;
  const store = new MemoryLoginRateLimitStore();
  store.states.set("expired:one", {
    scope: "IP",
    keyHash: "expired",
    failures: 1,
    expiresAtMs: nowMs - 1,
  });
  const limiter = new LoginRateLimiter(store, policies(), { now: () => nowMs });

  await limiter.inspect(createLoginRateLimitAttempt("player1", "203.0.113.8"));

  assert.equal(store.states.has("expired:one"), false);
  assert.equal(store.pruneCalls, 1);
});

test("normalizes username and IP variants so casing and address notation cannot bypass buckets", () => {
  const first = createLoginRateLimitAttempt("  Ｐlayer1  ", "::ffff:203.0.113.8");
  const second = createLoginRateLimitAttempt("player1", "203.0.113.8");
  const expandedIpv6 = createLoginRateLimitAttempt("player1", "2001:0db8:0:0:0:0:0:1");
  const compressedIpv6 = createLoginRateLimitAttempt("PLAYER1", "2001:db8::1");

  assert.equal(first.normalizedUsername, "player1");
  assert.equal(first.normalizedIp, "203.0.113.8");
  assert.deepEqual(first.keys, second.keys);
  assert.deepEqual(expandedIpv6.keys, compressedIpv6.keys);
});

test("account policy blocks distributed IP attacks", async () => {
  const store = new MemoryLoginRateLimitStore();
  const limiter = new LoginRateLimiter(
    store,
    policies({ ACCOUNT_IP: 10, ACCOUNT: 2, IP: 10 }),
  );

  await limiter.recordFailure(createLoginRateLimitAttempt("victim", "203.0.113.1"));
  await limiter.recordFailure(createLoginRateLimitAttempt("VICTIM", "203.0.113.2"));
  const decision = await limiter.inspect(
    createLoginRateLimitAttempt(" victim ", "203.0.113.3"),
  );

  assert.deepEqual(decision, { limitedScopes: ["ACCOUNT"], hardBlocked: true });
});

test("IP policy catches username rotation without blocking valid users behind the same NAT", async () => {
  const store = new MemoryLoginRateLimitStore();
  const limiter = new LoginRateLimiter(
    store,
    policies({ ACCOUNT_IP: 10, ACCOUNT: 10, IP: 2 }),
  );
  const ip = "203.0.113.8";

  await limiter.recordFailure(createLoginRateLimitAttempt("unknown-1", ip));
  await limiter.recordFailure(createLoginRateLimitAttempt("unknown-2", ip));
  const validUserAttempt = createLoginRateLimitAttempt("player1", ip);
  const decision = await limiter.inspect(validUserAttempt);

  assert.deepEqual(decision, { limitedScopes: ["IP"], hardBlocked: false });
  await limiter.recordSuccess(validUserAttempt);
  assert.deepEqual(await limiter.inspect(validUserAttempt), decision);
});

test("shared store atomically preserves concurrent failures from multiple limiter instances", async () => {
  const store = new MemoryLoginRateLimitStore();
  const firstInstance = new LoginRateLimiter(store, policies({ ACCOUNT_IP: 10 }));
  const secondInstance = new LoginRateLimiter(store, policies({ ACCOUNT_IP: 10 }));
  const attempt = createLoginRateLimitAttempt("player1", "203.0.113.8");
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      (index % 2 === 0 ? firstInstance : secondInstance).recordFailure(attempt),
    ),
  );

  assert.equal(store.stateFor(attempt, "ACCOUNT_IP")?.failures, 50);
  assert.equal(results.filter((result) => result.hardBlocked).length, 41);
});

test("PostgreSQL store records every scope through one atomic upsert statement", async () => {
  const attempt = createLoginRateLimitAttempt("player1", "203.0.113.8");
  const queries: string[] = [];
  const queryValues: unknown[][] = [];
  const executor = {
    async query(text: string, values: unknown[]) {
      queries.push(text);
      queryValues.push(values);
      return {
        rows: attempt.keys.map((key) => ({
          scope: key.scope,
          key_hash: key.keyHash,
          failures: 1,
          expires_at: new Date(61_000),
        })),
        rowCount: attempt.keys.length,
      };
    },
  };
  const store = new PostgresLoginRateLimitStore(executor as never);

  const states = await store.increment(
    attempt.keys.map((key) => ({ ...key, windowMs: 60_000 })),
    1_000,
  );

  assert.equal(queries.length, 1);
  assert.match(queries[0], /ON CONFLICT \(scope, key_hash\) DO UPDATE/);
  assert.match(queries[0], /existing\.expires_at <= EXCLUDED\.window_started_at THEN 1/);
  assert.equal(queryValues[0].length, 12);
  assert.equal(states.length, 3);
});
