# RelayPlay product requirements

RelayPlay is a pure TypeScript framework for web games where every player runs
an independent local game and only progress summaries and occasional gameplay
interactions cross the network. It deliberately uses client -> server -> client
delivery and never opens peer-to-peer sockets.

## Required product capabilities

1. A browser SDK that connects to a room, reports readiness, periodically sends
   progress, sends server-mediated interactions, resumes after disconnects, and
   exposes typed events.
2. Progress reporting is interval-based with a 1,000 ms default and a typed,
   validated override.
3. Interactions are authenticated, targeted, rate-limited, sequenced by the
   server, deduplicated, optionally scheduled into the future, persisted before
   broadcast, and replayable after reconnect.
4. A server-agnostic room engine plus a production-oriented Cloudflare Durable
   Object adapter and a locally testable in-memory adapter.
5. Time configuration for server clock synchronization, synchronized starts,
   resync intervals, fixed-tick and audio-clock games, interaction lead time,
   and late-event policy.
6. Platform configuration for universal, mobile-first, and desktop-first games;
   touch, keyboard, pointer, and gamepad capabilities; cross-play and ranked
   input-pool policies; and adaptive presentation hints.
7. Presets for a basic live race, soft battle, falling-block battle, rhythm
   race, and mobile/desktop/universal platform targets.
8. Security defaults: no P2P, strict runtime message validation, payload caps,
   per-action rate limits, opaque room/player identifiers, idempotency keys,
   resume epochs, and production authentication hooks.
9. Replay and verification extension points so clients can upload deterministic
   input chunks and a server can validate interaction claims or final results.
10. An end-to-end example with progress, a targeted debuff, synchronized start,
    keyboard and touch controls, disconnect recovery, and Cloudflare deployment.
11. AI-first documentation: concise README, AGENTS.md, llms.txt, JSON Schema,
    configuration recipes, architecture/protocol/security docs, and commands an
    agent can run without guessing.
12. Automated tests for config normalization, protocol validation, progress
    cadence, interaction ordering/deduplication, time sync, reconnect replay,
    rate limiting, and example build integrity.

## Non-goals

- Shared-world or high-frequency authoritative simulation.
- Client-to-client sockets, WebRTC, STUN, or TURN.
- Treating client-reported progress as trustworthy ranked evidence.
- A promise that an open web client can prevent input bots or forged rhythm
  timestamps.

## Architectural invariants

- The local game loop never waits for a network round trip.
- Progress is replaceable telemetry; canonical interactions are append-only.
- Every canonical event has a room epoch, stable event ID, and monotonic server
  sequence.
- Scheduled interactions target a logical boundary, tick, beat, or future wall
  time, never raw packet arrival time.
- Browser rendering rate never changes simulation or scoring rules.
- TypeScript compile-time types are backed by runtime validation at trust
  boundaries.
