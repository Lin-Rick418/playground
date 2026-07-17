# Authentication rate limits

All `/auth` endpoints enforce fixed-window rate limits backed by the shared
`login_rate_limits` table (PostgreSQL), so limits hold across every API
instance and survive restarts. Real client IPs come from the loopback nginx
proxy (`trust proxy = loopback`); direct clients cannot spoof `X-Forwarded-For`.

| Endpoint | Limiter | Scope | Threshold | Window |
| --- | --- | --- | --- | --- |
| `POST /auth/login` | account + IP | `ACCOUNT_IP` (hard) | 5 failures | 15 min |
| | | `ACCOUNT` (hard) | 20 failures | 15 min |
| | | `IP` (soft) | 60 failures | 5 min |
| `POST /auth/change-password` | account + IP | same policies as login, namespaced | 5 / 20 failures | 15 min |
| `POST /auth/refresh` | per IP | `ENDPOINT_IP` | 60 requests | 1 min |
| `POST /auth/logout` | per IP | `ENDPOINT_IP` | 30 requests | 1 min |

## Change-password (closing the login bypass)

Before this control, a stolen access token could brute-force the current
password through `/auth/change-password` with no limit, sidestepping login's
protection. Change-password now counts each wrong current-password attempt at
the **same per-account + per-IP thresholds as login**. The account identity is
namespaced (`password-change <username>`) so ordinary password-change typos do
not lock a legitimate user out of `/auth/login`; only the coarse soft per-IP
guard is shared. A hard block returns `429 RATE_LIMITED` and is emitted as a
`password_change_rate_limited` security log event.

Successful attempts clear the account-scoped failures (never the shared IP
bucket), mirroring login.

## Refresh / logout

`/auth/refresh` and `/auth/logout` are unauthenticated database-touching
endpoints, so they carry a generous per-IP request cap purely to stop
resource-exhaustion floods — not to police normal clients. The refresh budget
(60/min) comfortably covers multi-tab token renewal and WebSocket reconnect
storms.

## Retention

Expired buckets are removed by the login limiter's opportunistic prune and by
the scheduled maintenance job (see `docs/data-retention.md`); endpoint buckets
live in the same table and are cleaned by the same paths.
