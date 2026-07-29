# RelayPlay agent instructions

This repository is a pure TypeScript monorepo for low-frequency, server-relayed
multiplayer web games. Read `docs/requirements.md` and `docs/architecture.md`
before changing behavior.

## Non-negotiable invariants

1. **Do not turn the harness into a monolith.** A small deployment may run as
   one Node.js process, but protocol, browser SDK, room policy, provider
   adapters, and game code stay in separate modules with enforced inward-only
   dependencies.
2. Never add P2P, WebRTC, STUN, or TURN.
3. The local game loop must never wait for a network round trip.
4. Progress snapshots are replaceable; canonical events are append-only.
5. Persist a canonical interaction before broadcasting it.
6. Every canonical event carries room epoch, stable event ID, and monotonic
   server sequence. Resume from sequence, not client wall time.
7. Apply an interaction at a future wall time/tick/beat/logical boundary, never
   at raw packet arrival.
8. Validate every untrusted message at runtime. TypeScript types alone are not
   validation.
9. Do not advertise client progress or rhythm input timestamps as cheat-proof.
10. Keep simulation, scoring, and protocol consistent across platforms. Adapt
   presentation and input separately.
11. Default progress cadence is 1,000 ms unless a validated config overrides it.
12. The supported small-room profile has at most four players, no chat, no
    required account signup, and persistent ranking disabled by default.

## Module dependency rule

Deployment topology and code architecture are separate decisions. Running the
Node adapter, HTTP control plane, WebSocket gateway, room engine, and SQLite
ports in one operating-system process is a valid small-server optimization. It
does **not** permit their responsibilities to be merged.

Allowed package dependencies point inward:

```text
client ───────────────▶ core
server ───────────────▶ core
node ────────────────▶ server + core
cloudflare ──────────▶ server + core

browser example ──▶ client + core
provider composition roots ──▶ one provider adapter + game policy
```

- `core` imports no other RelayPlay package.
- `client` and `server` may import `core`, never each other.
- `node` and `cloudflare` are replaceable outer adapters; each may import
  `server` and `core`.
- Browser game code may import `client` and `core`, never a server or provider
  adapter.
- Composition roots wire ports and policies. They do not become a second room
  engine or a catch-all utility layer.

`test/package-boundaries.test.ts` enforces these rules for both source imports
and package manifests. Update architecture intentionally before changing that
test; do not weaken it merely to make a new import compile.

## Commands

```bash
npm install
npm run configure -- --help
npm run validate:config -- relayplay.config.json
npm run typecheck
npm test
npm run build
npm run check
npm run test:node
npm run verify
```

Run the narrowest package test while iterating, then `npm run verify` before
handoff. `verify` exercises both provider paths: a local Durable Object smoke
and the Node/SQLite transport tests with real WebSockets. Do not commit
generated `dist`, `.wrangler`, coverage, databases, or secrets.

## Change routing

- Shared configuration/protocol/time math: `packages/core`
- Browser connection/reconnect/cadence/capabilities: `packages/client`
- Provider-neutral room policy: `packages/server`
- Self-hosted HTTP/WebSocket/SQLite ports: `packages/node`
- Cloudflare-specific WebSocket/storage wiring: `packages/cloudflare`
- Game policy shared by providers: `examples/live-race/server`
- Browser behavior and UX: `examples/live-race/src`
- Provider composition only: `examples/live-race/node`,
  `examples/live-race/worker`
- Machine-readable configuration: `relayplay.config.schema.json`

Provider-specific APIs must not leak into `core`, `client`, or the room engine.
Protocol additions require runtime validation, tests for malformed input, and a
documentation update. Configuration additions require a default, validation,
JSON Schema coverage, and at least one test.

## AI-safe implementation workflow

1. State which invariant and package boundary the change touches.
2. Inspect exported types and existing tests; do not infer the wire format from
   the example UI.
3. Prefer a preset plus a small override over copying a large normalized config.
4. Use injected clocks, sockets, storage, auth, and broadcast ports in tests.
5. Test duplicate messages, reconnect/resume, out-of-order sequence handling,
   malformed payloads, and late scheduled events when relevant.
6. Keep sample identifiers and tokens obviously non-production.

## Definition of done

Compilation, tests, and package builds pass. Public API changes have docs and a
migration note. Security claims remain accurate. The example still works with
touch and keyboard and does not import server-only code into the browser. The
package-boundary test passes, and a convenient single-process deployment has
not been implemented as monolithic source code.
