# Signal Sprint example

This framework-free TypeScript browser game demonstrates the complete RelayPlay
path without putting its local game loop on the network.

- Touch/click or Space advances the local player immediately.
- A progress snapshot is sent at the configured cadence.
- Ready players receive one canonical, synchronized start.
- A freeze is sent as an interaction intent, accepted/rate-limited by the room,
  persisted, sequenced, then applied at its future server time.
- The client stores room epoch and canonical sequence and resumes after a forced
  disconnect.
- Remote progress is interpolated UI data, not ranked authority.

## Run locally

From the repository root:

```bash
npm install
npm run build
npm run dev:example
```

Open `http://127.0.0.1:5173` in two tabs. Keep `demo-room` in both and use the
different generated player IDs. Connect and mark both players ready.

The local Worker uses an explicit development authenticator. Do not expose it
to the public Internet. The production checklist is in
[`docs/deploy-cloudflare.md`](../../docs/deploy-cloudflare.md).

## What to copy into a game

Copy the client lifecycle and boundary handling, not the demo's game rules or
development credential. A production game should provide:

1. an HTTPS endpoint issuing short-lived room-scoped tickets;
2. a ruleset-specific `InteractionValidator`;
3. an explicit mapping from `EffectiveAt` to its own simulation boundary;
4. a replay/result verifier before valuable ranked rewards;
5. its own bounded progress and interaction payload validators.
