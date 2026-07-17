import assert from "node:assert/strict";
import test from "node:test";
import {
  EndpointRateLimiter,
  type EndpointRateLimitPolicy,
} from "./endpoint-rate-limit.js";
import type {
  LoginRateLimitIncrement,
  LoginRateLimitKey,
  LoginRateLimitState,
  LoginRateLimitStore,
} from "./login-rate-limit.js";

function stateId(key: LoginRateLimitKey) {
  return `${key.scope}:${key.keyHash}`;
}

class MemoryStore implements LoginRateLimitStore {
  readonly states = new Map<string, LoginRateLimitState>();

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
          ? { scope: increment.scope, keyHash: increment.keyHash, failures: 1, expiresAtMs: nowMs + increment.windowMs }
          : { ...current, failures: current.failures + 1 };
      this.states.set(id, state);
      return { ...state };
    });
  }

  async clear(keys: LoginRateLimitKey[]) {
    for (const key of keys) this.states.delete(stateId(key));
  }

  async pruneExpired() {
    return 0;
  }
}

const policy: EndpointRateLimitPolicy = { endpoint: "auth.refresh", maxRequests: 3, windowMs: 1_000 };

test("allows requests up to the limit and blocks once exceeded", async () => {
  const store = new MemoryStore();
  const limiter = new EndpointRateLimiter(store, policy);

  assert.equal(await limiter.consume("203.0.113.5"), true);
  assert.equal(await limiter.consume("203.0.113.5"), true);
  assert.equal(await limiter.consume("203.0.113.5"), true);
  assert.equal(await limiter.consume("203.0.113.5"), false);
});

test("counts each client IP independently", async () => {
  const store = new MemoryStore();
  const limiter = new EndpointRateLimiter(store, policy);

  for (let i = 0; i < 3; i += 1) await limiter.consume("203.0.113.5");
  assert.equal(await limiter.consume("203.0.113.5"), false);
  assert.equal(await limiter.consume("198.51.100.9"), true);
});

test("the window resets after it expires", async () => {
  let nowMs = 10_000;
  const store = new MemoryStore();
  const limiter = new EndpointRateLimiter(store, policy, { now: () => nowMs });

  for (let i = 0; i < 3; i += 1) await limiter.consume("203.0.113.5");
  assert.equal(await limiter.consume("203.0.113.5"), false);
  nowMs += 1_001;
  assert.equal(await limiter.consume("203.0.113.5"), true);
});

test("separate endpoints do not share a bucket", async () => {
  const store = new MemoryStore();
  const refresh = new EndpointRateLimiter(store, policy);
  const logout = new EndpointRateLimiter(store, { endpoint: "auth.logout", maxRequests: 3, windowMs: 1_000 });

  for (let i = 0; i < 3; i += 1) await refresh.consume("203.0.113.5");
  assert.equal(await refresh.consume("203.0.113.5"), false);
  assert.equal(await logout.consume("203.0.113.5"), true);
});

test("clients without a resolvable IP share the unknown bucket", async () => {
  const store = new MemoryStore();
  const limiter = new EndpointRateLimiter(store, policy);

  for (let i = 0; i < 3; i += 1) await limiter.consume(undefined);
  assert.equal(await limiter.consume(undefined), false);
});

test("rejects an invalid policy", () => {
  const store = new MemoryStore();
  assert.throws(() => new EndpointRateLimiter(store, { endpoint: "x", maxRequests: 0, windowMs: 1_000 }));
  assert.throws(() => new EndpointRateLimiter(store, { endpoint: "", maxRequests: 1, windowMs: 1_000 }));
});
