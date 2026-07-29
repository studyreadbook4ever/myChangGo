# Self-hosted Node/SQLite deployment

This deployment is for a small, accountless RelayPlay installation: one to four
players per room, low-frequency semantic WebSocket traffic, no chat, and
persistent ranking disabled by default.

The operational shape is intentionally compact, but the code is not
monolithic. One Node process composes separate HTTP control-plane, WebSocket,
guest-auth, room-engine, SQLite, broadcast, timer, metrics, and shutdown
modules. The browser, provider-neutral server policy, and game validators stay
outside that composition root.

## Topology

```text
browser ── HTTPS/WSS ── Caddy (TLS + static example)
                              │
                              ├─ /api/* ───────────┐
                              └─ /rooms/*/ws ──────┤
                                                   ▼
                                            RelayPlay Node
                                                   │
                                                   ▼
                                             SQLite volume
```

Use one RelayPlay application replica and a local persistent volume. Caddy is
the only public listener; the Node port stays on the private container network.
SQLite is a good fit for this bounded single-writer topology. Multiple Node
replicas sharing a SQLite file are not supported.

## Local source check

Requires Node.js 24.15 or newer.

Start the accountless Node example:

```bash
RELAYPLAY_ALLOWED_ORIGINS=http://127.0.0.1:5173 \
RELAYPLAY_INSECURE_DEVELOPMENT=true \
RELAYPLAY_SECURE_COOKIES=false \
RELAYPLAY_DATABASE_PATH=./data/relayplay-dev.sqlite \
npm run dev:node --workspace @relayplay/example-live-race
```

In another terminal, start the browser:

```bash
npm run dev --workspace @relayplay/example-live-race
```

Open `http://127.0.0.1:5173`, set the server endpoint to
`ws://127.0.0.1:8080/rooms/{roomId}/ws`, and choose **Create room**. A second
browser can use **Join invite**. The insecure flags are accepted only for
loopback origins; never carry them into production.

## Compose deployment

The checked-in deployment under `deploy/on-prem` builds the framework and
example from source, serves the browser through Caddy, keeps Node private, and
mounts a named volume for SQLite. Start from the example environment file:

```bash
cp deploy/on-prem/.env.example deploy/on-prem/.env
docker compose --env-file deploy/on-prem/.env \
  -f deploy/on-prem/compose.yaml up -d --build
```

Before starting, replace every example host/origin value with the exact public
HTTPS origin. Do not add a trailing slash to an origin. Review the generated
configuration with `docker compose ... config` and keep `.env`, database files,
backups, certificates, and raw invites out of Git.

## Compose environment contract

| Variable | Production guidance |
| --- | --- |
| `RELAYPLAY_SITE_ADDRESS` | DNS name Caddy serves, without scheme or path |
| `RELAYPLAY_PUBLIC_ORIGIN` | required exact `https://host[:port]` browser origin; no path, trailing slash, or `*` |
| `RELAYPLAY_HTTP_PORT` / `RELAYPLAY_HTTPS_PORT` | optional published host ports; normally `80` / `443` |
| `RELAYPLAY_DATA_VOLUME` | stable private SQLite volume name used by backup/restore procedures |
| `RELAYPLAY_CADDY_DATA_VOLUME` | stable volume for Caddy certificates and state |
| `RELAYPLAY_CADDY_CONFIG_VOLUME` | stable Caddy runtime configuration volume |
| `RELAYPLAY_MAX_CONNECTIONS` | global process cap sized below host limits |
| `RELAYPLAY_MAX_CONNECTIONS_PER_IP` | abuse guard; account for legitimate shared NATs |
| `RELAYPLAY_EXPOSE_METRICS` | leave `false`, or expose only to a private collector |

The Compose file fixes the internal Node host/port, database path, secure
cookie, production mode, trusted-proxy boundary, and two-player start quorum.
When running `@relayplay/node` directly, the corresponding runtime variables
are `RELAYPLAY_ALLOWED_ORIGINS`, `RELAYPLAY_HOST`, `RELAYPLAY_PORT`,
`RELAYPLAY_DATABASE_PATH`, `RELAYPLAY_SECURE_COOKIES`,
`RELAYPLAY_INSECURE_DEVELOPMENT`, `RELAYPLAY_TRUST_PROXY`,
`RELAYPLAY_MINIMUM_PLAYERS`, and optional `RELAYPLAY_CONFIG_PATH`. Keep proxy
trust false unless the process is private behind a proxy that overwrites
forwarding headers.

The live-race Node entry point composes its own shared config and progress,
interaction, and finish validators. A different game should create another
small entry point that injects its policy; it should not edit `packages/node`
or copy `RoomEngine`.

## Production checklist

- Point DNS at the host and let Caddy obtain/renew TLS certificates.
- Permit public ingress only to ports 80/443; restrict SSH and container-daemon
  access separately.
- Run containers as unprivileged users with no-new-privileges/capability drops
  where the deployment supports them.
- Keep exact allowed origins and secure cookies. Verify HTTP redirects to HTTPS
  and the browser connects with `wss://`.
- Ensure Caddy overwrites forwarding headers before enabling proxy trust.
- Set CPU, memory, process/file-descriptor, disk, and log-retention limits.
- Keep room/player IDs out of metrics labels and raw invites/cookies out of
  access/application logs.
- Test create, join, the fifth-player rejection, ready/start, progress cadence,
  one finish per player, reconnect, and restart on the actual hostname.
- Verify `/livez` for process liveness and `/readyz` for storage/application
  readiness. Do not route new upgrades to an unready process.
- Keep ranking disabled until a separate identity, verifier, leaderboard store,
  retention, and abuse policy exists.

## Backups, restore, and upgrades

SQLite uses WAL for normal operation. A copied main database file while the
process is writing is not a backup procedure.

For the simple single-replica profile:

1. stop/drain the RelayPlay application cleanly so connections close and SQLite
   checkpoints;
2. snapshot or copy the persistent database volume with restricted ownership;
3. restart and confirm `/readyz`;
4. restore the backup into a separate staging volume and run create/join,
   reconnect, and canonical-order checks;
5. retain enough older application images to perform a tested rollback, while
   treating database migrations as forward-only unless explicitly documented.

The following cold-backup example uses the default volume name. Substitute the
value of `RELAYPLAY_DATA_VOLUME` when it has been overridden:

```bash
RELAYPLAY_VOLUME=relayplay_data
RELAYPLAY_BACKUP_DIR="$(pwd)/backups"
mkdir -p "$RELAYPLAY_BACKUP_DIR"

docker compose --env-file deploy/on-prem/.env \
  -f deploy/on-prem/compose.yaml stop relayplay
docker run --rm \
  --mount "type=volume,src=$RELAYPLAY_VOLUME,dst=/source,readonly" \
  --mount "type=bind,src=$RELAYPLAY_BACKUP_DIR,dst=/backup" \
  alpine:3.22 \
  tar -C /source -czf /backup/relayplay.sqlite-volume.tgz .
tar -tzf "$RELAYPLAY_BACKUP_DIR/relayplay.sqlite-volume.tgz"
docker compose --env-file deploy/on-prem/.env \
  -f deploy/on-prem/compose.yaml up -d relayplay
```

Never extract over the active volume. For recovery, create a new volume, unpack
the archive into it, then change `RELAYPLAY_DATA_VOLUME` in `.env` and recreate
the stopped application container:

```bash
RELAYPLAY_RESTORE_VOLUME=relayplay_restore_20260718
RELAYPLAY_BACKUP_DIR="$(pwd)/backups"

docker volume create "$RELAYPLAY_RESTORE_VOLUME"
docker run --rm \
  --mount "type=volume,src=$RELAYPLAY_RESTORE_VOLUME,dst=/target" \
  --mount "type=bind,src=$RELAYPLAY_BACKUP_DIR,dst=/backup,readonly" \
  alpine:3.22 \
  tar -C /target -xzf /backup/relayplay.sqlite-volume.tgz
```

Test that restored volume on a non-public host first. During an actual recovery,
stop `relayplay`, point `RELAYPLAY_DATA_VOLUME` at the restored volume, run
`docker compose ... up -d --force-recreate relayplay`, and check `/readyz` plus
the create/join, reconnect, and finish-order flows before admitting players.
Keep the original volume unchanged until recovery is accepted.

Take a verified backup before each upgrade. Pin deployed image versions, read
release/migration notes, deploy during a small-room drain window, and monitor
rejected upgrades, storage failures, backpressure disconnects, and disk use.

## Scaling boundary

The local frame loop never moves to the server, so a modest host can support
many small rooms without 60 Hz simulation work. Capacity must still be measured
with the actual payload validators, event retention, reconnect rate, and
slow-client behavior.

When one replica is no longer enough, do not hide distributed coordination in
the Node composition root. Add a provider design with explicit room ownership,
transactional persistence, cross-replica broadcast/pub-sub, connection routing,
and failure recovery—or use the Durable Object adapter. Preserve the same
inward package dependency rules.
