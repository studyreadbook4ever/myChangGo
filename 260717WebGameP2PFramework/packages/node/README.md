# `@relayplay/node`

Hardened, single-process Node.js deployment adapter for RelayPlay. It composes
the provider-neutral `RoomEngine` with an HTTP control plane, a WebSocket
gateway, anonymous room-bound guest credentials, sparse room alarms, and
durable SQLite storage.

## Requirements

- Node.js 24.15 or newer (the adapter uses `node:sqlite`).
- HTTPS at the public edge in production.
- One process writing the configured SQLite database. This adapter is not a
  multi-replica coordination layer.

## Programmatic API

```ts
import { createRelayPlayNodeServer } from "@relayplay/node";

const server = createRelayPlayNodeServer({
  host: "127.0.0.1",
  port: 8080,
  databasePath: "./data/relayplay.sqlite",
  allowedOrigins: ["https://game.example"],
});

await server.start();
// On shutdown:
await server.stop();
```

The accountless control plane exposes `POST /api/rooms`, `POST /api/join`,
`GET /livez`, and `GET /readyz`. `GET /metrics` is available only when
`exposeMetrics` is enabled. Room sockets use `/rooms/:roomId/ws`.

If interactions are enabled, pass a game-specific `validateInteraction`.
Ranking or verified final results also require `validateFinish`; verified final
results require `verifyReplay`. Configuration fails at startup when a required
validator is absent.

## CLI

The `relayplay-node` binary uses a strict `RELAYPLAY_*` environment loader.
`RELAYPLAY_ALLOWED_ORIGINS` is required (comma-separated). Common settings are
`RELAYPLAY_HOST`, `RELAYPLAY_PORT`, `RELAYPLAY_DATABASE_PATH`,
`RELAYPLAY_CONFIG_PATH`, `RELAYPLAY_MAX_ROOMS`, `RELAYPLAY_MAX_CONNECTIONS`,
and `RELAYPLAY_EXPOSE_METRICS`. Unknown `RELAYPLAY_*` names, malformed numbers
or booleans, and invalid config files abort startup instead of being ignored.

For local HTTP development only, set
`RELAYPLAY_INSECURE_DEVELOPMENT=true`; this mode is restricted to a loopback
host and loopback origins. Its default host is `127.0.0.1`. The production CLI
defaults to `0.0.0.0`, secure cookies, and HTTPS origins.

## Security model

- The browser receives an opaque, room-scoped, `HttpOnly`, `SameSite=Strict`
  guest cookie. Only SHA-256 credential and invite digests are stored.
- WebSocket credentials are accepted only from that cookie, never from the
  query string. WebSocket query keys are allowlisted and identity hints remain
  bound to the authenticated cookie session.
- Origins are exact allowlists; wildcard origins are rejected. Forwarded IP
  headers are ignored unless `trustProxy` is explicitly enabled.
- Protocol messages are strictly decoded, payloads and buffers are bounded,
  per-message compression is disabled, and slow consumers are disconnected.
- Canonical events and room roster/completion state are committed atomically in
  SQLite before broadcast. Unknown schema versions fail closed.
