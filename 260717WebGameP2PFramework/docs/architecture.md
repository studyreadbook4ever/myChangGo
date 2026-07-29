# Architecture

RelayPlay is a low-frequency, server-relayed multiplayer harness for games in
which each player can run an independent local simulation. Its default product
profile is intentionally small: at most four players, guest invites instead of
required signup, no chat, and no persistent ranking unless an application
explicitly supplies identity and verification policy.

```text
Browser A (local game) ── WebSocket ── Room sequencer ── WebSocket ── Browser B
          │                                  │
          ├─ replaceable progress            ├─ auth + bounded validation
          ├─ occasional intent               ├─ canonical event ordering
          └─ local 60/120 Hz loop             └─ persistence + sparse timers
```

The room sequencer does not run a frame loop. It wakes for connections,
messages, and occasional deadlines; assigns a total order to canonical events;
persists those events; and broadcasts them. Each client keeps input, rendering,
audio, and simulation local, so gameplay never waits for a network round trip.

The configurable “polling interval” is a progress frame over an already-open
WebSocket, not repeated HTTP polling. At the default 1,000 ms cadence, the
latest snapshot replaces the previous one. A rare canonical interaction can
still be delivered immediately and scheduled for a fair future game boundary.

## Non-monolithic by design

**A one-process deployment must not become a source-code monolith.** A small
self-hosted installation benefits from one Node.js process and one SQLite file,
but maintainability comes from keeping policy behind ports and composition at
the edge. Deployment units may be combined; responsibilities and dependency
direction may not.

```text
                              ┌──────────────────────┐
                              │ examples/live-race   │  composition + game policy
                              └──────┬────────┬──────┘
                                     │        │
                         browser     │        │ provider entry point
                                     ▼        ▼
                              ┌──────────┐  ┌────────────┐
                              │ client   │  │ node       │
                              └────┬─────┘  │ cloudflare │
                                   │        └─────┬──────┘
                                   │              ▼
                                   │        ┌──────────┐
                                   │        │ server   │  provider-neutral policy
                                   │        └────┬─────┘
                                   └─────────────▼
                                          ┌──────────┐
                                          │ core     │  protocol + config + time
                                          └──────────┘
```

Arrows mean “may depend on.” The allowed rules are:

- `core` imports no other RelayPlay package.
- `client` and `server` each import only `core`; neither imports the other.
- `node` and `cloudflare` are replaceable provider adapters. They may import
  `server` and `core`, never browser or example code.
- Browser example source imports `client` and `core`, never server/provider
  code.
- Provider entry points may compose an adapter with game validators. They do
  not duplicate protocol validation, sequencing, replay, or room policy.

`test/package-boundaries.test.ts` scans source imports and package manifests so
an accidental outward or sideways dependency fails the normal test suite. This
is an architectural test, not a style preference.

## Package ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| `@relayplay/core` | configuration, presets, protocol envelopes and runtime validators, shared time math/types | sockets, databases, provider APIs, DOM |
| `@relayplay/client` | browser WebSocket lifecycle, progress cadence, clock estimates, sequence buffering, reconnect/resume, input capabilities | room authority, persistence, provider bindings |
| `@relayplay/server` | provider-neutral room state machine, auth/storage/broadcast ports, ordering, idempotency, rate and validation policy | Node, SQLite, Cloudflare, DOM |
| `@relayplay/node` | accountless HTTP control plane, cookie auth, WebSocket gateway, SQLite ports, backpressure, process lifecycle | game-specific rules or a second room engine |
| `@relayplay/cloudflare` | Worker routing, Durable Object storage/alarm/WebSocket ports | game-specific rules or a forked protocol |
| `examples/live-race/server` | bounded progress, interaction, and finish validators shared by providers | transport or persistence |
| `examples/live-race/src` | local game, responsive UI, guest control-plane client, presentation of remote state | server-only imports or authority claims |
| provider entry points | construct one adapter with configuration and game policy | reusable business logic |

New providers implement the server ports. New games provide configuration,
payload validators, and optional verifiers. Neither requires editing the room
engine for provider-specific concerns.

## Control plane and data plane

The self-hosted provider separates infrequent room provisioning from gameplay
traffic:

```text
POST /api/rooms {} ──▶ room + host guest capability ──▶ HttpOnly room cookie
POST /api/join {invite} ──▶ player guest capability ──▶ HttpOnly room cookie

GET /rooms/{opaqueRoomId}/ws + cookie ──▶ authenticated WebSocket upgrade
                                      └─▶ session / snapshot / replay
```

Raw invite and guest secrets are capabilities. The Node adapter persists only
their hashes, binds each guest to one room/player/session, restricts cookie
scope to the room path, and rejects credentials in query parameters. Room and
join requests are origin-checked, bounded, and rate-limited. No account
database is needed for the default profile.

After upgrade, the WebSocket is the data plane. It carries semantic messages,
not frames from the local game loop:

- ready/unready and one canonical synchronized start;
- progress, normally one replaceable update per second;
- rare, rate-limited interaction intents and canonical accepted events;
- one finish intent and server-derived match elapsed time/placement;
- ping/pong, acknowledgement, bounded replay evidence, and reconnect resume.

There is deliberately no chat message type or generic user-text channel. A game
payload still crosses an untrusted boundary and needs a strict, bounded,
game-specific validator.

## Message and durability classes

| Class | Examples | Storage and delivery rule |
| --- | --- | --- |
| Ephemeral | ping/pong, heartbeat, progress | latest value wins; may be coalesced or dropped under backpressure |
| Canonical | start, accepted interaction, finish/forfeit | append-only; assign sequence and persist atomically before broadcast |
| Evidence | replay chunks, state hashes | bounded extension input; never automatically proof of human input |

Canonical events carry room epoch, stable event ID, and monotonic server
sequence. Idempotency records and events are committed together. A retry either
returns the same accepted result or fails; it must not apply an interaction or
finish twice.

## Room lifecycle and reconnect

```text
waiting ── ready quorum ──▶ canonical future start ──▶ running ──▶ finished
   ▲                             │                         │
   └──── reconnect snapshot ◀────┴── replay(afterSequence)┘
```

On connect or resume, the server sends session identity, an authoritative room
snapshot, and canonical events after the client's last contiguous sequence.
Replay is paginated and bounded. An epoch mismatch, expired grace period, or
pruned replay window becomes a fresh/rejected session rather than an invented
continuation. Progress is reconstructed from the snapshot and then continues
with monotonic per-player progress sequences; it is never part of canonical
replay.

Only the server decides accepted room membership, start order, interaction
order, finish order, and transport time. Client-reported scores/results remain
untrusted unless a game verifier checks deterministic evidence.

## Provider topologies

### Self-hosted Node/SQLite

```text
Internet ── TLS reverse proxy/static files ── Node HTTP + WebSocket process
                                                  │
                                                  └─ SQLite (WAL)
```

The process composes separate control-plane, gateway, auth, room-engine,
storage, broadcaster, timer, metrics, and lifecycle modules. SQLite supplies a
single durable writer for a small installation. Run one application replica
against a local persistent volume.

Do not horizontally scale this topology by pointing unrelated Node replicas at
one SQLite file. Horizontal scaling needs an explicit room-affinity/router or a
shared transactional store plus cross-replica pub/sub and connection routing.
That is a new provider adapter, not a reason to leak distributed-systems logic
into `server` or `core`.

### Cloudflare Durable Objects

```text
Browser ── Worker route ── one Durable Object per room
                              ├─ serialized storage
                              └─ hibernatable WebSockets
```

One object serializes each room naturally. It wakes for messages and sparse
alarms rather than simulating at 60 Hz. The same provider-neutral room engine
and example validators are composed at this outer boundary.

## Ranking is an optional application layer

`features.ranking.enabled` defaults to `false`. Canonical per-match placement
does not require a profile or leaderboard. Enabling durable ranking requires a
stable identity model, result/evidence verification, retention rules,
matchmaking policy, abuse operations, and a separate ranking store. Those
concerns must remain outside the transport and room sequencer.
