import { createHash } from "node:crypto";
import {
  normalizeLoginIp,
  type Clock,
  type LoginRateLimitStore,
} from "./login-rate-limit.js";

const systemClock: Clock = { now: () => Date.now() };

// Single scope value keeps the shared login_rate_limits table tidy; the
// endpoint name is folded into the key hash instead.
export const ENDPOINT_RATE_LIMIT_SCOPE = "ENDPOINT_IP";

export type EndpointRateLimitPolicy = {
  endpoint: string;
  maxRequests: number;
  windowMs: number;
};

// Refresh is called by every tab on token expiry and by the WebSocket
// reconnect path, so the budget stays generous; both limits exist to stop
// unauthenticated database-load floods, not to police normal clients.
export const authRefreshRateLimitPolicy: EndpointRateLimitPolicy = {
  endpoint: "auth.refresh",
  maxRequests: 60,
  windowMs: 60_000,
};

export const authLogoutRateLimitPolicy: EndpointRateLimitPolicy = {
  endpoint: "auth.logout",
  maxRequests: 30,
  windowMs: 60_000,
};

export class EndpointRateLimiter {
  constructor(
    private readonly store: LoginRateLimitStore,
    private readonly policy: EndpointRateLimitPolicy,
    private readonly clock: Clock = systemClock,
  ) {
    if (
      !policy.endpoint ||
      !Number.isSafeInteger(policy.maxRequests) ||
      policy.maxRequests < 1 ||
      !Number.isSafeInteger(policy.windowMs) ||
      policy.windowMs < 1
    ) {
      throw new Error(`Invalid endpoint rate limit policy for ${policy.endpoint || "<unnamed>"}`);
    }
  }

  private keyFor(ip: string | undefined) {
    // Clients without a resolvable IP normalize to "unknown" and share one
    // bucket; behind the trusted proxy every real client has a concrete IP.
    const normalizedIp = normalizeLoginIp(ip);

    return {
      scope: ENDPOINT_RATE_LIMIT_SCOPE,
      keyHash: createHash("sha256")
        .update(`${ENDPOINT_RATE_LIMIT_SCOPE}\0${this.policy.endpoint}\0${normalizedIp}`)
        .digest("hex"),
    };
  }

  /** Counts this request against the client's window; false once over budget. */
  async consume(ip: string | undefined): Promise<boolean> {
    const [state] = await this.store.increment(
      [{ ...this.keyFor(ip), windowMs: this.policy.windowMs }],
      this.clock.now(),
    );

    return (state?.failures ?? 1) <= this.policy.maxRequests;
  }
}
