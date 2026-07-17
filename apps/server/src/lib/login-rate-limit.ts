import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const loginRateLimitScopes = ["ACCOUNT_IP", "ACCOUNT", "IP"] as const;
export type LoginRateLimitScope = (typeof loginRateLimitScopes)[number];

// Store keys are deliberately wider than the login scopes: the same table and
// store back other fixed-window limiters (see endpoint-rate-limit.ts).
export type LoginRateLimitKey = {
  scope: string;
  keyHash: string;
};

export type LoginRateLimitIncrement = LoginRateLimitKey & {
  windowMs: number;
};

export type LoginRateLimitState = LoginRateLimitKey & {
  failures: number;
  expiresAtMs: number;
};

export type LoginRateLimitStore = {
  get(keys: LoginRateLimitKey[], nowMs: number): Promise<LoginRateLimitState[]>;
  increment(
    increments: LoginRateLimitIncrement[],
    nowMs: number,
  ): Promise<LoginRateLimitState[]>;
  clear(keys: LoginRateLimitKey[]): Promise<void>;
  pruneExpired(nowMs: number, limit: number): Promise<number>;
};

export type LoginRateLimitPolicy = {
  scope: LoginRateLimitScope;
  maxFailures: number;
  windowMs: number;
  hardBlock: boolean;
};

export type LoginRateLimitAttempt = {
  normalizedUsername: string;
  normalizedIp: string;
  keys: LoginRateLimitKey[];
};

export type LoginRateLimitDecision = {
  limitedScopes: LoginRateLimitScope[];
  hardBlocked: boolean;
};

export type Clock = {
  now: () => number;
};

const systemClock: Clock = { now: () => Date.now() };
const PRUNE_BATCH_SIZE = 500;

export const defaultLoginRateLimitPolicies: LoginRateLimitPolicy[] = [
  {
    scope: "ACCOUNT_IP",
    maxFailures: 5,
    windowMs: 15 * 60 * 1000,
    hardBlock: true,
  },
  {
    scope: "ACCOUNT",
    maxFailures: 20,
    windowMs: 15 * 60 * 1000,
    hardBlock: true,
  },
  {
    // IP is deliberately a soft guard: failures are throttled, but a valid
    // user behind a shared NAT is still allowed to prove their credentials.
    scope: "IP",
    maxFailures: 60,
    windowMs: 5 * 60 * 1000,
    hardBlock: false,
  },
];

export function normalizeLoginUsername(username: string) {
  return username.normalize("NFKC").trim().toLowerCase();
}

export function normalizeLoginIp(ip: string | undefined) {
  const candidate = (ip ?? "unknown").trim().toLowerCase();
  const mappedIpv4 = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];

  if (mappedIpv4 && isIP(mappedIpv4) === 4) {
    return mappedIpv4;
  }

  if (isIP(candidate) === 4) {
    return candidate;
  }

  if (isIP(candidate) === 6) {
    const hostname = new URL(`http://[${candidate}]`).hostname;
    return hostname.slice(1, -1);
  }

  return "unknown";
}

function hashRateLimitKey(scope: LoginRateLimitScope, value: string) {
  return createHash("sha256").update(`${scope}\0${value}`).digest("hex");
}

export function createLoginRateLimitAttempt(
  username: string,
  ip: string | undefined,
): LoginRateLimitAttempt {
  const normalizedUsername = normalizeLoginUsername(username);
  const normalizedIp = normalizeLoginIp(ip);

  return {
    normalizedUsername,
    normalizedIp,
    keys: [
      {
        scope: "ACCOUNT_IP",
        keyHash: hashRateLimitKey("ACCOUNT_IP", `${normalizedUsername}\0${normalizedIp}`),
      },
      {
        scope: "ACCOUNT",
        keyHash: hashRateLimitKey("ACCOUNT", normalizedUsername),
      },
      {
        scope: "IP",
        keyHash: hashRateLimitKey("IP", normalizedIp),
      },
    ],
  };
}

function validatePolicies(policies: LoginRateLimitPolicy[]) {
  const configuredScopes = new Set<LoginRateLimitScope>();

  for (const policy of policies) {
    if (
      configuredScopes.has(policy.scope) ||
      !Number.isSafeInteger(policy.maxFailures) ||
      policy.maxFailures < 1 ||
      !Number.isSafeInteger(policy.windowMs) ||
      policy.windowMs < 1
    ) {
      throw new Error(`Invalid login rate limit policy for ${policy.scope}`);
    }

    configuredScopes.add(policy.scope);
  }

  if (configuredScopes.size !== loginRateLimitScopes.length) {
    throw new Error("Login rate limit policies must configure every scope exactly once");
  }
}

export class LoginRateLimiter {
  private readonly policiesByScope: Map<LoginRateLimitScope, LoginRateLimitPolicy>;

  constructor(
    private readonly store: LoginRateLimitStore,
    policies: LoginRateLimitPolicy[] = defaultLoginRateLimitPolicies,
    private readonly clock: Clock = systemClock,
  ) {
    validatePolicies(policies);
    this.policiesByScope = new Map(policies.map((policy) => [policy.scope, policy]));
  }

  private getDecision(states: LoginRateLimitState[]): LoginRateLimitDecision {
    const limitedScopes = states.flatMap((state) => {
      // States are read back for this limiter's own keys, so the scope is
      // always one of the login scopes despite the wider store type.
      const scope = state.scope as LoginRateLimitScope;
      const policy = this.policiesByScope.get(scope)!;
      return state.failures >= policy.maxFailures ? [scope] : [];
    });

    return {
      limitedScopes,
      hardBlocked: limitedScopes.some(
        (scope) => this.policiesByScope.get(scope)!.hardBlock,
      ),
    };
  }

  async inspect(attempt: LoginRateLimitAttempt): Promise<LoginRateLimitDecision> {
    const nowMs = this.clock.now();
    await this.store.pruneExpired(nowMs, PRUNE_BATCH_SIZE);
    return this.getDecision(await this.store.get(attempt.keys, nowMs));
  }

  async recordFailure(attempt: LoginRateLimitAttempt): Promise<LoginRateLimitDecision> {
    const increments = attempt.keys.map((key) => ({
      ...key,
      windowMs: this.policiesByScope.get(key.scope as LoginRateLimitScope)!.windowMs,
    }));
    const states = await this.store.increment(increments, this.clock.now());
    return this.getDecision(states);
  }

  async recordSuccess(attempt: LoginRateLimitAttempt) {
    // Clear only account-specific failures. Clearing the shared IP bucket on
    // any success would let one valid credential erase an attacker's history.
    await this.store.clear(attempt.keys.filter((key) => key.scope !== "IP"));
  }
}
