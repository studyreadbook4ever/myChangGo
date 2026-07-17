# Requirement traceability and verification

This document maps each product requirement to executable code and checks. It
is intended for maintainers and coding agents deciding whether a change remains
safe to deploy.

| Requirement | Implementation | Primary checks |
| --- | --- | --- |
| Browser connect/ready/progress/interaction/resume | `packages/client/src/client.ts` | `packages/client/test/client.test.ts` |
| 1,000 ms default, configurable cadence | core config + client progress scheduler | config, preset, scheduler, client tests |
| Authenticated targeted canonical interactions | server `RoomEngine` | interaction/auth/rate/idempotency engine tests |
| Persist before broadcast and total sequence | `RoomStorage.commitCanonical` contract, memory and SQLite implementations | engine ordering + failure/retry tests |
| Provider-neutral and Cloudflare adapters | `packages/server`, `packages/cloudflare` | server and Worker adapter tests |
| Clock sync, fixed tick, audio mapping | `packages/core/src/time.ts`, client `time-sync.ts` | core/client time tests |
| Future schedule and explicit late policy | core `EffectiveAt`, server normalization, game boundary mapping | protocol, engine, example game tests |
| Mobile/desktop/universal capability flags | core platform policy + browser capability/input helpers | platform, capability, input tests |
| Cross-play/ranked-pool policy | typed nested config and presets | config/schema/preset tests |
| Strict runtime trust-boundary validation | core protocol validators, Cloudflare decoder | malformed/oversize protocol tests |
| Opaque ID, rate, idempotency, resume epoch | config invariants + server/adapter policy | core/server/cloudflare tests |
| Replay/result verification extension points | `InteractionValidator`, `ReplayVerifier`, evidence messages | verifier/evidence engine tests |
| Full keyboard/touch example | `examples/live-race` | example game test, browser build, DO smoke |
| AI-readable configuration and deployment | `AGENTS.md`, `llms.txt`, schema, generator, docs | schema parity and CLI validation tests |

## Automated verification layers

`npm run verify` performs all required layers:

1. strict TypeScript project-reference compilation for all public packages;
2. tooling and repository test type-checking;
3. Vitest unit/integration suites;
4. ESM package builds and the framework-free Vite production bundle;
5. local Wrangler startup with SQLite Durable Object migration;
6. two-client WebSocket smoke covering auth/session, ready, canonical start,
   progress relay, validated freeze, event ordering, disconnect, replay, and
   resume-epoch increment.

The smoke uses an explicit local-only fixed credential. It verifies transport
and persistence mechanics, not production identity infrastructure.

## Manual browser acceptance

Run `npm run dev:example`, open two tabs, and verify:

- both generated IDs join the same room and can ready/unready;
- the countdown begins from the canonical future server time;
- Space, click, and touch change local progress without network delay;
- remote progress refreshes near the one-second configured cadence;
- freeze shows a warning before application and is server-rate-limited;
- “Simulate disconnect” returns with the same session and ordered sequence;
- responsive layout works at narrow and wide viewport sizes;
- reduced-motion preference removes nonessential transitions.

## Claims deliberately not made

Passing these checks does not prove that an untrusted browser's reported score
or physical input timestamp is honest. Applications must choose an explicit
verification tier from `docs/security.md`. RelayPlay also remains unsuitable for
shared-world rollback/action simulation even when all tests pass.
