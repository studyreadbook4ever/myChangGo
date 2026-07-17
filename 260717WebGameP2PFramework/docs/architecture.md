# Architecture

```text
Browser A (local game) -- WebSocket -- Room sequencer -- WebSocket -- Browser B
          |                               |
          + progress snapshots            + canonical event log
          + interaction intents            + validation/rate limits
          + replay chunks                  + scheduled interactions
```

The room sequencer does not run a frame loop. It wakes for messages, assigns a
total order to canonical events, persists them, and broadcasts them. Clients use
a shared match configuration and local monotonic/audio clocks to run their own
gameplay without waiting for the network.

The configurable “polling interval” is implemented as periodic progress frames
over the already-open WebSocket, not repeated HTTP polling. At the default one
second cadence this keeps the product behavior the user expects while avoiding
new HTTP/TLS work and allowing a canonical interaction to be delivered
immediately when one actually occurs.

## Packages

- `@relayplay/core`: configuration, presets, protocol, validation, clocks, and
  shared types.
- `@relayplay/client`: browser WebSocket SDK, progress scheduler, reconnect,
  time sync, capability/input adapters, and typed events.
- `@relayplay/server`: provider-neutral room engine, auth/storage/broadcast
  ports, interaction policies, event log, rate limiting, and replay hooks.
- `@relayplay/cloudflare`: Worker and Durable Object adapter for an immediately
  deployable serverless backend.
- `examples/live-race`: runnable cross-platform live race with a targeted
  debuff and synchronized start.

## Message classes

- Ephemeral: ping/pong, heartbeat, progress. Latest value wins and gaps do not
  require replay.
- Canonical: start, interaction, disconnect deadline, finish. Persist before
  broadcast and replay by sequence after reconnect.
- Evidence: replay chunks and state hashes. Stored for verifier extensions; they
  are not automatically proof of physical user input.
