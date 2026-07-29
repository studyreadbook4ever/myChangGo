# RelayPlay on-prem deployment

This directory runs the live-race browser bundle and one `@relayplay/node`
process behind Caddy. It is intentionally a single-replica SQLite deployment
for small rooms of at most four players.

```bash
cp deploy/on-prem/.env.example deploy/on-prem/.env
# Edit the hostname and exact HTTPS origin, point DNS at this host, then:
docker compose --env-file deploy/on-prem/.env \
  -f deploy/on-prem/compose.yaml up -d --build
```

Caddy terminates TLS, serves the static game, and proxies `/api/*`,
`/rooms/*`, `/livez`, and `/readyz` to the private Node container. Only Caddy
publishes host ports. Guest credentials are `Secure`, `HttpOnly`,
`SameSite=Strict` cookies scoped to one room WebSocket path.

Read [the complete operations guide](../../docs/deploy-on-prem.md) before
exposing the service publicly. In particular, back up the SQLite database,
keep the Node service at one replica, restrict the Docker host, and verify the
exact allowed origin after every hostname change.
