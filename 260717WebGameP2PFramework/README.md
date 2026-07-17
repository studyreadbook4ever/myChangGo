# RelayPlay

RelayPlay is a pure TypeScript framework for web games in which every player
runs their own local game while the network carries progress snapshots and
occasional, server-mediated interactions.

It is a good fit for falling-block races, rhythm score races, asynchronous
boss races, typing races, and “soft battle” games. It is intentionally **not**
a shared-world real-time engine.

```text
local game A ── progress / intent ──▶ room sequencer
local game B ◀── snapshot / event ───┘
```

There are no browser-to-browser sockets, WebRTC, STUN, or TURN. A small room
server authenticates messages, orders interactions, stores the canonical event
log, and relays them to recipients. The local frame loop never waits for it.

## Why this model

- Local input remains responsive even on a poor connection.
- Progress traffic defaults to one replaceable snapshot per second.
- Important interactions are ordered, deduplicated, replayable, and scheduled
  at a future game boundary rather than applied on packet arrival.
- One simulation and scoring core can serve desktop and mobile while controls,
  layout, effects, and ranked pools remain platform-aware.
- A Cloudflare Durable Object can own each room without running a 60 Hz server
  simulation.

## Repository status

The repository contains the framework source, tests, an in-memory adapter, a
Cloudflare Durable Object adapter, and a framework-free browser example. It is
currently intended to be installed from source while the package APIs settle.

Requirements: Node.js 22.12 or newer.

```bash
npm install
npm run verify
```

Run `npm run configure -- --help` to generate a validated configuration without
editing nested flags by hand. The machine-readable contract is
[`relayplay.config.schema.json`](./relayplay.config.schema.json), with a complete
soft-battle sample in
[`relayplay.config.example.json`](./relayplay.config.example.json).

## Packages

| Package | Responsibility |
| --- | --- |
| `@relayplay/core` | configuration, presets, protocol, runtime validation, clocks |
| `@relayplay/client` | browser SDK, progress cadence, time sync, reconnect and resume |
| `@relayplay/server` | provider-neutral room engine, policy ports and in-memory adapter |
| `@relayplay/cloudflare` | Worker and hibernatable Durable Object WebSocket adapter |
| `examples/live-race` | touch + keyboard progress race and targeted freeze interaction |

## The game/network boundary

Your game owns rendering, input, simulation, audio, scoring, and deterministic
replay data. RelayPlay owns room membership, synchronized match start, remote
progress, interaction intent delivery, canonical event ordering, reconnect, and
time estimates.

```ts
const client = new RelayPlayClient({
  url: "wss://example.workers.dev/rooms/{roomId}/ws",
  roomId: "demo-room",
  playerId: "opaque-player-id",
  token: await getShortLivedRoomToken(),
  config,
});

client.on("start", (event) => {
  if (event.effectiveAt?.kind === "server-time") {
    scheduleLocalGameStart(client.clock.toLocalTime(event.effectiveAt.serverTimeMs));
  }
});

client.on("interaction", (event) => {
  scheduleAtGameBoundary(event, () => applyLocalEffect(event.payload));
});

client.startProgress(() => ({
  score,
  normalizedProgress,
  phase: gamePhase,
}));

await client.connect();
client.setReady(true);
```

The exact event is not trusted merely because the client reported it. For
ranked play, attach a replay/verifier implementation on the server and keep
matchmaking policy separate from transport policy.

## Choose a starting preset

- `live-race`: progress comparison, no offensive interaction.
- `soft-battle`: occasional targeted effects with conservative rate limits.
- `falling-block-battle`: future-boundary garbage/events and deterministic replay
  hooks.
- `rhythm-race`: synchronized starts, frequent clock resync, score/progress
  comparison, and no claim that browser timestamps prove physical input.
- platform overlays: `universal`, `mobile-first`, or `desktop-first`.

Presets are ordinary typed configuration inputs. Override only what the game
needs; runtime validation rejects inconsistent or unsafe combinations.

## Design guidance

For this game class, start universal and adapt presentation rather than physics:

- Share rules, simulation ticks, scoring, seeds, protocol, and replay format.
- Adapt control density, touch targets, safe areas, effects, audio unlock, and
  layout by capability.
- Allow casual cross-play by default. For competitive queues, measure input
  advantage and split by actual input class only when evidence justifies it.
- Apply remote attacks on a named logical boundary, future tick, beat, or
  measure. Never make packet arrival itself a gameplay rule.

See [Game design guide](./docs/game-design.md),
[Configuration](./docs/configuration.md), [Protocol](./docs/protocol.md), and
[Security](./docs/security.md). A Korean architecture and decision guide is
available at [`docs/ko/overview.md`](./docs/ko/overview.md).

## Documentation map

- Humans starting a game: [`docs/game-design.md`](./docs/game-design.md)
- Configuration flags and recipes: [`docs/configuration.md`](./docs/configuration.md)
- Transport and ordering rules: [`docs/protocol.md`](./docs/protocol.md)
- Deployment: [`docs/deploy-cloudflare.md`](./docs/deploy-cloudflare.md)
- Threat model and ranked limits: [`docs/security.md`](./docs/security.md)
- Requirement-to-test evidence: [`docs/verification.md`](./docs/verification.md)
- Coding agents: [`AGENTS.md`](./AGENTS.md), [`llms.txt`](./llms.txt), and
  [`docs/ai-guide.md`](./docs/ai-guide.md)

## License

MIT
