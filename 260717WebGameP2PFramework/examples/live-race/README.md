# Signal Sprint example

This framework-free TypeScript browser game demonstrates the complete RelayPlay
path without putting its local game loop on the network.

- Touch/click or Space advances the local player immediately.
- A progress snapshot is sent at the configured cadence.
- Ready players receive one canonical, synchronized start.
- Two to four players share a room; the UI projects up to three opponents.
- A freeze is sent as an interaction intent, accepted/rate-limited by the room,
  persisted, sequenced, then applied at its future server time.
- A local finish is submitted exactly once, validated by the room, and returned
  as a canonical placement. The client-supplied elapsed time is not trusted.
- The client stores room epoch and canonical sequence and resumes after a forced
  disconnect.
- Remote progress is interpolated UI data, not ranked authority.
- There is intentionally no chat or arbitrary user-to-user message path.

### Non-monolithic maintenance invariant

Do not collapse this example or the harness into one module. `game.ts` owns the
local game, `race-session.ts` owns the bounded multiplayer projection, `view.ts`
owns DOM presentation, `guest-control-plane.ts` owns the accountless HTTP
boundary, `config.ts` is the browser/server contract,
`server/validators.ts` is shared by the Worker and Node entry, and `main.ts`
only orchestrates browser state. Browser code imports `@relayplay/client` and
`@relayplay/core`; provider-specific composition stays in `worker/` and
`node/`. This boundary is a maintenance requirement, not an optional style
preference.

## Run locally

From the repository root:

```bash
npm install
npm run build
npm run dev:example
```

Open `http://127.0.0.1:5173` in two to four tabs. Keep `demo-room` in every tab
and use different generated player IDs. Connect and mark every connected player
ready; at least two are required to start.

The local Worker uses an explicit development authenticator. Do not expose it
to the public Internet. The production checklist is in
[`docs/deploy-cloudflare.md`](../../docs/deploy-cloudflare.md).
The finish validator bounds the result shape and applies the demo rule; it does
not make an open browser client cheat-proof.

## Use the on-prem guest control plane

For local accountless testing, run the Node process and Vite in separate
terminals. The insecure flags are restricted by the adapter to loopback
origins:

```bash
RELAYPLAY_ALLOWED_ORIGINS=http://127.0.0.1:5173 \
RELAYPLAY_INSECURE_DEVELOPMENT=true \
RELAYPLAY_SECURE_COOKIES=false \
RELAYPLAY_DATABASE_PATH=./data/live-race.sqlite \
npm run dev:node --workspace @relayplay/example-live-race

npm run dev --workspace @relayplay/example-live-race
```

Enter the on-prem WebSocket endpoint (for example,
`ws://127.0.0.1:8080/rooms/{roomId}/ws`) and choose **Create room**. The page
calls `POST /api/rooms` with credentials enabled, connects using the returned
opaque room/player IDs, and shows a copyable invite. Other players paste that
invite and choose **Join invite**, which calls `POST /api/join` and connects with
the issued HttpOnly guest cookie. Invites are sent only in a bounded JSON body;
an `#invite=...` fragment may prefill the field, and is cleared on connection.

The direct **Connect** form remains available for the local Cloudflare Worker.
It sends the fixed demonstration token only to loopback port 8787 (or when an
explicit `VITE_RELAYPLAY_DEV_TOKEN` is configured); other endpoints receive no
query credential.

For Internet deployment, use the Caddy/Docker topology and operational
checklist in [`docs/deploy-on-prem.md`](../../docs/deploy-on-prem.md). The
accountless example remains capped at four players, has no chat or P2P path,
and keeps persistent ranking disabled.

## What to copy into a game

Copy the client lifecycle and boundary handling, not the demo's game rules or
development credential. A production game should provide:

1. an HTTPS endpoint issuing short-lived room-scoped tickets;
2. a ruleset-specific `InteractionValidator`;
3. an explicit mapping from `EffectiveAt` to its own simulation boundary;
4. a replay/result verifier before valuable ranked rewards;
5. its own bounded progress and interaction payload validators.
