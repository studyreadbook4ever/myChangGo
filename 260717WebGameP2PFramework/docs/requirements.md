# RelayPlay product requirements

RelayPlay is a pure TypeScript harness for web games where every player runs an
independent local game and only progress summaries plus occasional gameplay
interactions cross the network. It uses client → server → client delivery and
never opens peer-to-peer sockets.

The supported harness profile is intentionally bounded: one to four players,
invite-based guest access without required signup, no chat, and persistent
ranking disabled unless an integrating application explicitly opts in.

## Required product capabilities

1. A browser SDK that connects to a room, reports readiness, periodically sends
   progress, sends server-mediated interactions, finishes once, resumes after
   disconnects, and exposes typed events.
2. Progress reporting is interval-based with a 1,000 ms default and a typed,
   validated override. It is replaceable telemetry, not a server frame loop.
3. Interactions are authenticated, targeted, rate-limited, sequenced by the
   server, deduplicated, optionally scheduled into the future, persisted before
   broadcast, and replayable after reconnect.
4. A provider-neutral room engine plus two replaceable production adapters:
   self-hosted Node/WebSocket/SQLite and Cloudflare Durable Objects. The same
   room semantics and game validators apply to both.
5. A signup-free Node control plane that creates an opaque room/invite, joins a
   guest by invite, issues a room-scoped cookie capability, stores only secret
   hashes, and caps each room at four issued guests.
6. Time configuration for server clock synchronization, synchronized starts,
   resync intervals, fixed-tick and audio-clock games, interaction lead time,
   and late-event policy.
7. Platform configuration for universal, mobile-first, and desktop-first games;
   touch, keyboard, pointer, and gamepad capabilities; cross-play policy; and
   adaptive presentation hints.
8. Presets for a basic live race, soft battle, falling-block battle, rhythm
   race, and mobile/desktop/universal platform targets. Shipping presets use a
   maximum of four players.
9. Security defaults: no P2P, strict runtime message validation, explicit
   origins, payload caps, general and per-action rate limits, opaque IDs,
   idempotency keys, bounded resume/replay, backpressure, and production TLS
   expectations.
10. Replay and verification extension points so clients can upload bounded
    deterministic evidence and a server can validate interaction or result
    claims. Client progress alone never becomes ranked authority.
11. Server-derived canonical match elapsed time and placement. Persistent
    ranking remains an opt-in application feature and defaults to disabled.
12. No chat protocol, chat UI, or generic free-text room channel in the base
    harness. Game payloads remain bounded and game-specific.
13. An end-to-end example with guest room creation/join, up to three opponents,
    progress, a targeted debuff, synchronized start, keyboard/touch controls,
    finish placement, disconnect recovery, and both provider entry points.
14. AI-first documentation: concise README, AGENTS.md, llms.txt, JSON Schema,
    architecture/protocol/security/deployment docs, and deterministic commands.
15. Automated tests for configuration, protocol validation, package dependency
    boundaries, cadence, ordering/deduplication, finish, time sync, reconnect,
    storage restart, rate limits, WebSocket security, and example builds.

## Maintainability requirement

The harness **must not be implemented as a monolith**. A small deployment may
run one Node process for operational simplicity, but the code remains separated
into:

- protocol/config/time primitives (`core`);
- browser lifecycle and transport (`client`);
- provider-neutral authoritative room policy and ports (`server`);
- replaceable outer providers (`node`, `cloudflare`);
- game-specific validators and browser presentation (`examples/live-race`).

Dependencies point inward only: `client → core`, `server → core`, and provider
adapters → `server + core`. Browser source cannot import server/provider code.
Composition roots only wire modules. This rule is executable in
`test/package-boundaries.test.ts` and is part of the definition of done.

## Non-goals

- Shared-world or high-frequency authoritative simulation.
- Client-to-client sockets, WebRTC, STUN, or TURN.
- More than four players in the supported self-hosted small-room profile.
- Accounts, profiles, social graphs, chat, moderation tooling, or a global
  leaderboard in the base harness.
- Treating client-reported progress as trustworthy ranked evidence.
- A promise that an open web client can prevent input bots or forged rhythm
  timestamps.
- Transparent horizontal scaling of one SQLite file across Node replicas.
- Collapsing package boundaries merely because modules deploy in one process.

## Architectural invariants

- The local game loop never waits for a network round trip.
- Progress is replaceable telemetry; canonical events are append-only.
- Every canonical event has a room epoch, stable event ID, and monotonic server
  sequence, and is persisted before broadcast.
- Scheduled interactions target a logical boundary, tick, beat, or future wall
  time, never raw packet arrival time.
- Browser rendering rate never changes simulation or scoring rules.
- TypeScript compile-time types are backed by runtime validation at every trust
  boundary.
- Guest credentials are scoped capabilities, not account identity; raw secrets
  do not belong in query strings, logs, or durable storage.
- Ranking is false by default and cannot be inferred from the existence of
  per-match placement or a ranked-pool configuration hint.
