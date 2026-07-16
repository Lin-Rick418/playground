# Shared API Contracts

`@baccarat/contracts` is the runtime and TypeScript source of truth for the API surfaces shared by the server and web app. Schemas are strict: unknown fields, missing fields, invalid enums, and invalid nested snapshots are contract failures rather than silently accepted drift.

Covered contracts include player auth login/current user, lobby/table state, and WebSocket subscription/snapshot messages.

```bash
npm run build --workspace @baccarat/contracts
npm test --workspace @baccarat/contracts
```

Server response validation fails closed with HTTP 500 or a safe WebSocket error. The web client rejects invalid responses and closes a WebSocket that sends an invalid server message. Diagnostics contain only the contract name plus schema issue code/path; payload values are never logged.

Admin contracts intentionally do not live in this player application package; a future standalone backoffice must define its own boundary. Server and web must be deployed from the same release. Future breaking schema changes should use an explicit compatibility window or API version instead of changing an existing contract in place.
