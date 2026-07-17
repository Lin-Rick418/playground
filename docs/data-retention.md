# Data retention policy

This policy separates retry/session metadata that may be deleted from game,
financial, and fairness records that must remain available for audit.

| Data | Retention | Reason |
| --- | --- | --- |
| `idempotency_keys` | 7 days by default (`IDEMPOTENCY_RETENTION_DAYS`) | Supports client retries and short-term incident diagnosis. `bets` and `financial_ledger_entries` remain the source of truth. |
| `auth_sessions` | Delete 30 days after expiration or revocation by default (`AUTH_SESSION_RETENTION_DAYS`) | Allows bounded security investigation without retaining unusable refresh-token hashes forever. |
| `login_rate_limits` | Delete after `expires_at` | The rows have no value after their enforcement window. |
| `game_rounds`, `bets` | Permanent | Game and wagering history. |
| `financial_ledger_entries` | Permanent | Append-only financial source of truth. |
| `shoe_commitments`, `shoe_secrets`, `shoe_reveals`, `shoe_deal_audits` | Permanent | Fairness and shoe reconstruction evidence. |
| `service_heartbeats` | One current row per service | Updated in place rather than accumulated. |

If growth of a permanent table becomes operationally significant, add an
archive design and legal review in a separate issue. The retention maintenance
job must not delete or archive permanent records.

## Automated cleanup

`baccarat-maintenance.timer` starts the one-shot maintenance service hourly with
a randomized delay. Each table is pruned in batches of 500 rows using
`FOR UPDATE SKIP LOCKED`; active transactions are skipped and a run continues
until every batch is smaller than the limit. The schema migration adds indexes
for each retention cutoff so cleanup does not rely on repeated full-table scans.

The service logs one `retention_cleanup_completed` JSON event with per-table
counts. It exits non-zero and logs `retention_cleanup_failed` when schema
validation or cleanup fails.

```bash
sudo systemctl status baccarat-maintenance.timer
sudo systemctl start baccarat-maintenance.service
sudo journalctl -u baccarat-maintenance.service -o cat --since '-1 day' | jq .
```

To stop deletion without rolling back the application release, disable the
timer. Changing a retention period requires an env-file edit and affects the
next run; it does not require a code deployment.

```bash
sudo systemctl disable --now baccarat-maintenance.timer
```
