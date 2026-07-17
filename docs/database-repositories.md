# Database repository modules

`apps/server/src/lib/db.ts` is the stable public entry point for database
operations. It is intentionally a thin barrel so existing callers do not need
to change while the implementations remain grouped by responsibility under
`apps/server/src/lib/repositories/`.

| Module | Responsibility |
| --- | --- |
| `client.ts` | PostgreSQL connection pool plus shared query and transaction helpers. |
| `initialize.ts` | Disabled runtime initializer and legacy invariant backfills. |
| `legacy-schema.ts` | Legacy schema SQL retained behind the disabled initializer. New schema changes belong in migrations. |
| `users.ts` | Users, tables, balances, and financial ledger reconciliation. |
| `idempotency-store.ts` | Idempotency claim and completion records. |
| `heartbeat.ts` | Service heartbeat writes and reads. |
| `auth-sessions.ts` | Refresh-session lifecycle. |
| `rounds.ts` | Round and bet creation, lookup, history, and status updates. |
| `round-lifecycle.ts` | Transactional cancellation, settlement, purge, and balance adjustment flows. |
| `shoes.ts` | Shoe persistence, commitments, deal audit records, and startup migration. |
| `view-models.ts` | Read-side composition for lobby, table, and user responses. |
| `seed.ts` | Startup table configuration and optional demo users. |

## Dependency direction

Repository modules should depend inward on `client.ts` and domain helpers.
Higher-level orchestration follows this direction:

```text
users <- rounds <- round-lifecycle <- shoes
   ^        ^              ^           ^
   +--------+--------------+-----------+-- view-models / seed
```

Keep cross-module helpers private unless another repository needs them. Public
application imports should continue to use `lib/db.ts`; direct repository
imports are reserved for collaboration between repository modules. This keeps
the public API explicit and prevents accidental coupling to implementation
details.

Schema changes must be implemented through the migration system. Do not add new
runtime DDL to `legacy-schema.ts`.
