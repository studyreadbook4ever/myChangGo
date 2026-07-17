# Security and trust model

RelayPlay prevents accidental protocol misuse and gives applications strong
server-side policy hooks. It does not make an untrusted browser authoritative.

## Trust boundaries

- The network, browser process, storage, clocks, progress, inputs, and result
  claims are untrusted.
- The room engine, authentication adapter, persistence adapter, ruleset policy,
  and verifier are trusted application components.
- A Cloudflare Durable Object provides single-room serialization but does not
  validate game-specific claims by itself.

## Production authentication

Issue a short-lived, room-scoped credential from an HTTPS application backend.
Bind it to an opaque player ID, room ID, permissions, and expiry. Validate it
before accepting the WebSocket or first join message, then derive session
identity from the verified claims.

Do not place long-lived secrets in query strings, browser bundles, repository
configuration, or WebSocket message bodies. Prefer a one-use ticket exchange or
an authorization header/cookie where the deployment supports it. Restrict
origins and use `wss://` outside local development.

## Abuse controls

Enforce all of the following server-side:

- total frame and decoded payload byte caps;
- strict runtime schema validation and finite numeric ranges;
- per-session message rate and concurrent connection limits;
- per-action token buckets/cooldowns;
- target and room membership checks;
- idempotency-key deduplication with bounded retention;
- maximum replay/resume window and event-log size;
- explicit room capacity and lifetime;
- backpressure or disconnect for consistently slow consumers.

Progress can be coalesced first under load. Canonical events must not be emitted
unless persisted; fail closed if durability is unavailable.

## Cheat resistance tiers

1. **Casual trust:** validate shapes/ranges and accept client progress/results.
2. **Replay check:** upload deterministic inputs/seeds and verify after match.
3. **Shadow verifier:** incrementally reproduce event-driven game state while
   the match runs.
4. **Authoritative simulation:** required when each physical input or shared
   state must be trusted; this is outside RelayPlay's intended architecture.

Falling-block games are good replay-verification candidates. Rhythm scoring can
verify chart logic and consistency, but ordinary browsers cannot prove that a
reported timestamp came from a human physical input.

## Privacy

Use opaque identifiers on the wire. Store only telemetry needed for operations,
fairness, or replay, with a documented retention period. Avoid sending account
profiles to every room member. Treat IP addresses, device fingerprints, input
telemetry, and chat as personal or sensitive data according to the deployment's
jurisdiction.

## Reporting vulnerabilities

Do not open a public issue for an exploitable vulnerability. Follow
[`SECURITY.md`](../SECURITY.md).
