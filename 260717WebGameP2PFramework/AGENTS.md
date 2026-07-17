# RelayPlay agent instructions

This repository is a pure TypeScript monorepo for low-frequency, server-relayed
multiplayer web games. Read `docs/requirements.md` and `docs/architecture.md`
before changing behavior.

## Non-negotiable invariants

1. Never add P2P, WebRTC, STUN, or TURN.
2. The local game loop must never wait for a network round trip.
3. Progress snapshots are replaceable; canonical events are append-only.
4. Persist a canonical interaction before broadcasting it.
5. Every canonical event carries room epoch, stable event ID, and monotonic
   server sequence. Resume from sequence, not client wall time.
6. Apply an interaction at a future wall time/tick/beat/logical boundary, never
   at raw packet arrival.
7. Validate every untrusted message at runtime. TypeScript types alone are not
   validation.
8. Do not advertise client progress or rhythm input timestamps as cheat-proof.
9. Keep simulation, scoring, and protocol consistent across platforms. Adapt
   presentation and input separately.
10. Default progress cadence is 1,000 ms unless a validated config overrides it.

## Commands

```bash
npm install
npm run configure -- --help
npm run validate:config -- relayplay.config.json
npm run typecheck
npm test
npm run build
npm run check
npm run verify
```

Run the narrowest package test while iterating, then `npm run verify` before
handoff. `verify` also starts a local Durable Object and exercises two real
WebSockets, canonical ordering, and resume. Do not commit generated `dist`,
`.wrangler`, coverage, or secrets.

## Change routing

- Shared configuration/protocol/time math: `packages/core`
- Browser connection/reconnect/cadence/capabilities: `packages/client`
- Provider-neutral room policy: `packages/server`
- Cloudflare-specific WebSocket/storage wiring: `packages/cloudflare`
- End-to-end behavior and UX: `examples/live-race`
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
touch and keyboard and does not import server-only code into the browser.
