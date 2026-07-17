# Structured logging

API, round worker, and retention maintenance processes use Pino. Production
output is newline-delimited JSON written to stdout/stderr and collected only by
systemd-journald. Development uses `pino-pretty`; tests are silent unless a test
provides an explicit destination. Set `LOG_LEVEL` to a Pino level such as
`debug`, `info`, `warn`, or `error` (`info` is the production default).

Every event contains `time`, `level`, `service`, and `instanceId`. Request-path
events also carry `requestId`; WebSocket lifecycle events may carry
`connectionId`, `userId`, `tableId`, or `roundId`. Settlement events contain
stake/payout totals and balance deltas so operators can correlate a failure,
but `financial_ledger_entries` remains the financial source of truth.

The logger redacts password, token, cookie, Authorization, and full request-body
fields at nested paths. Do not log raw request/response bodies or shoe secrets.
Client IP is limited to explicit security events such as login rejection,
rate-limiting, and rejected WebSocket authorization. Adding a new event requires
checking both its fields and all nested objects against this policy.

## Querying production logs

The systemd units set distinct service names. Use journald fields for service
boundaries and `jq` for application fields:

```bash
sudo journalctl -u baccarat-api.service -o cat --since '-30 minutes' | jq -c 'select(.requestId == "REQUEST_ID")'
sudo journalctl -u baccarat-worker.service -o cat --since today | jq -c 'select(.event == "round_settled")'
sudo journalctl -u baccarat-maintenance.service -o cat --since '-1 day' | jq -c 'select(.event | startswith("retention_"))'
```

Operational logs are intentionally not copied into PostgreSQL. Use journald
retention/forwarding controls at the host layer and ensure they match the
organization's incident-response policy.
