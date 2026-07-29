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
| Provider-neutral, Cloudflare, and Node adapters | `packages/server`, `packages/cloudflare`, `packages/node` | server, Worker, Node HTTP/WebSocket/SQLite tests |
| Non-monolithic inward dependencies | package ownership in `docs/architecture.md` | `test/package-boundaries.test.ts` checks imports and manifests |
| Signup-free maximum-four guest rooms | Node control plane + anonymous room service | create/join, cookie binding, room-full and restart tests |
| No chat and ranking off by default | protocol/config/example surfaces | protocol unknown-type, config/schema/preset tests |
| Clock sync, fixed tick, audio mapping | `packages/core/src/time.ts`, client `time-sync.ts` | core/client time tests |
| Future schedule and explicit late policy | core `EffectiveAt`, server normalization, game boundary mapping | protocol, engine, example game tests |
| Mobile/desktop/universal capability flags | core platform policy + browser capability/input helpers | platform, capability, input tests |
| Cross-play/ranked-pool policy | typed nested config and presets | config/schema/preset tests |
| Strict runtime trust-boundary validation | core protocol validators + provider decoders | malformed/oversize core, Cloudflare, and Node tests |
| Opaque ID, rate, idempotency, resume epoch | config invariants + server/adapter policy | core/server/cloudflare tests |
| Snapshot and canonical finish/placement | core protocol + client + `RoomEngine` | protocol/client/server ordering, idempotency, completion tests |
| Replay/result verification extension points | `ProgressValidator`, `FinishValidator`, `InteractionValidator`, `ReplayVerifier`, evidence messages | validator/verifier/evidence engine tests |
| Full keyboard/touch/accountless example | `examples/live-race` | game/session/control-plane/shared-validator tests, browser build, adapter smoke |
| AI-readable configuration and deployment | `AGENTS.md`, `llms.txt`, schema, generator, docs | schema parity and CLI validation tests |

## Automated verification layers

`npm run verify` performs all required layers:

1. strict TypeScript project-reference compilation for all public packages;
2. tooling and repository test type-checking;
3. Vitest unit/integration suites, including the import/manifest architecture
   boundary test;
4. ESM package builds and the framework-free Vite production bundle;
5. local Wrangler startup with SQLite Durable Object migration;
6. two-client WebSocket smoke covering auth/session, ready, canonical start,
   progress relay, validated freeze, event ordering, disconnect, replay, and
   resume-epoch increment.
7. Node adapter tests covering accountless room/join POSTs, HttpOnly cookie
   authentication, strict Origin handling, SQLite recovery, limits, health,
   and WebSocket behavior.

The Cloudflare smoke uses an explicit local-only fixed credential. It verifies
transport and persistence mechanics, not production identity infrastructure.
The Node tests create temporary SQLite databases and use the accountless guest
cookie flow; they do not contact a public service.

## Manual browser acceptance

Run `npm run dev:example`, open two tabs, and verify:

- at most four generated IDs join the same room and can ready/unready;
- the countdown begins from the canonical future server time;
- Space, click, and touch change local progress without network delay;
- remote progress refreshes near the one-second configured cadence;
- freeze shows a warning before application and is server-rate-limited;
- “Simulate disconnect” returns with the same session and ordered sequence;
- responsive layout works at narrow and wide viewport sizes;
- reduced-motion preference removes nonessential transitions.

For the on-prem path, run the Compose deployment, choose **Create room** in one
browser and **Join invite** in another, then additionally verify:

- POST responses set an HttpOnly cookie and JavaScript never receives its raw
  value;
- the invite is absent from HTTP/WebSocket URLs and access logs;
- a wrong Origin, wrong room path, or missing cookie cannot upgrade;
- one to three opponents reconcile from the room snapshot;
- one local completion produces one canonical finish and the same placement is
  shown to every client;
- a process restart resumes within the configured grace/log window;
- `/readyz`, backup, restore, and rollback procedures work on the target host.

## Claims deliberately not made

Passing these checks does not prove that an untrusted browser's reported score
or physical input timestamp is honest. Applications must choose an explicit
verification tier from `docs/security.md`. RelayPlay also remains unsuitable for
shared-world rollback/action simulation even when all tests pass.

Likewise, `features.ranking.enabled: false` is intentional in the example.
Canonical per-room placement plus a bounded `FinishValidator` does not establish
a verified ladder, account identity, or cheat-resistant reward decision.
