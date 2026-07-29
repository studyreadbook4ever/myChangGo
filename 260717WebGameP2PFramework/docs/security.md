# Security and trust model

RelayPlay provides strict transport and room-policy boundaries for a small
server-relayed game. It does not make an untrusted browser authoritative and it
does not turn an anonymous invite into a durable real-world identity.

## Security properties at a glance

| Property | Base harness behavior | Limit |
| --- | --- | --- |
| Network topology | browser → trusted room server → browser; no P2P/WebRTC | the TLS endpoint and host still need normal hardening |
| Room size | Node accountless adapter enforces at most four issued guests | custom providers must enforce the same product profile themselves |
| Signup | no account required; opaque invite/cookie capabilities | losing or sharing a capability transfers its authority until expiry/revocation |
| Chat | no protocol or UI channel | game-specific payloads still require validators that reject unexpected text |
| Progress | bounded, rate-limited, replaceable, monotonic per player | a client can lie about its own progress |
| Canonical events | server-ordered, idempotent, persisted before broadcast | ordering does not prove an interaction/result claim is honest |
| Finish | server assigns match time/order after game validator accepts intent | high-value results still need deterministic evidence verification |
| Ranking | disabled by default | enabling it requires identity, verification, retention, and abuse policy |
| Resume | room/session bound, epoch and contiguous-sequence based, bounded replay | events older than retention cannot be reconstructed |

## Trust boundaries

- The network, browser process, storage input, client clocks, progress, input
  timestamps, result claims, invite strings, headers, and proxy headers are
  untrusted.
- The room engine, selected authentication adapter, persistence adapter,
  ruleset validators, verifier, TLS reverse proxy, and deployment configuration
  are trusted application components.
- SQLite or a Cloudflare Durable Object provides serialization/durability for a
  provider. Neither validates game-specific claims by itself.
- TypeScript types disappear at runtime. Every HTTP, WebSocket, database, and
  game-payload boundary needs explicit shape/range/size validation.

## Signup-free guest capabilities

The self-hosted Node adapter has a deliberately small accountless control
plane:

1. `POST /api/rooms` with `{}` creates opaque room/player/session IDs and a
   high-entropy invite.
2. `POST /api/join` with `{ "invite": "…" }` issues another guest, up to the
   room's four-player limit and only while the room is joinable.
3. The raw guest credential is returned as a room-path-scoped `HttpOnly`,
   `SameSite=Strict` cookie (`Secure` in production). It is not exposed to
   browser JavaScript.
4. Only SHA-256 digests of invite and guest secrets are persisted. Each guest
   is bound to one opaque room, player, session, role, and expiry.
5. The WebSocket upgrade authenticates that cookie and rejects query-string
   credentials, an origin outside the explicit allowlist, malformed resume
   values, and mismatched room/session hints.

An invite is a bearer capability: keep it out of logs and public analytics, use
short room/credential lifetimes, and revoke it when the product adds a kick or
close-room operation. Hashing protects a copied database from immediately
revealing live raw capabilities; it does not rescue a leaked invite in transit
or in a browser history. Serve production traffic only over HTTPS/WSS.

Applications that need accounts may replace the auth port with short-lived,
room-scoped credentials bound to an authenticated user. Keep account/profile
data and global authorization outside the provider-neutral room engine.

The Cloudflare example's fixed local token is development-only. It is not a
production authentication design.

## HTTP, WebSocket, and proxy controls

Production deployments must:

- terminate modern TLS and redirect cleartext HTTP;
- set an exact `RELAYPLAY_ALLOWED_ORIGINS` list; wildcard origins are rejected;
- keep secure cookies enabled;
- set `RELAYPLAY_TRUST_PROXY=true` only when the Node process is unreachable
  except through a trusted reverse proxy that overwrites forwarding headers;
- keep `/metrics` private when enabled and avoid room/player/invite labels;
- persist the SQLite file on a private volume with backup/restore procedures;
- run one SQLite-backed application replica, not multiple independent writers
  sharing a filesystem over the network.

The Node boundary applies request/body/frame caps, UTF-8 JSON validation,
control-plane and upgrade rate limits, per-IP/total connection caps, transport
heartbeats, and slow-consumer backpressure. Progress is the first message class
that may be coalesced or dropped. A canonical event is never advertised unless
its storage transaction succeeds.

## Room-policy abuse controls

Enforce all of the following server-side:

- strict runtime envelopes, identifiers, finite numeric ranges, and no unknown
  game payload fields;
- bounded total frames, decoded payloads, evidence, replay pages, event logs,
  idempotency retention, room lifetimes, and room counts;
- per-session general message limits plus per-action token buckets/cooldowns;
- authenticated actor, target membership, role, room status, and room epoch;
- monotonic progress sequences and idempotency keys for mutations;
- one accepted finish per participant and server-derived canonical order;
- future application time/boundary for interactions, with an explicit late
  policy;
- disconnect/reconnect grace and timeout/forfeit policy;
- fail-closed storage, validator, verifier, and broadcaster error handling.

Do not add a generic free-text event as a shortcut for chat, names, or emotes.
That creates moderation, privacy, storage, rendering/XSS, and rate-limit
requirements that the base harness intentionally excludes.

## Cheat resistance tiers

1. **Casual trust:** validate shapes/ranges and accept client progress/results.
2. **Replay check:** upload deterministic inputs/seeds and verify after match.
3. **Shadow verifier:** incrementally reproduce event-driven game state while
   the match runs.
4. **Authoritative simulation:** required when each physical input or shared
   state must be trusted; this is outside RelayPlay's intended architecture.

Falling-block games are good replay-verification candidates. Rhythm scoring can
verify chart logic and internal consistency, but ordinary browsers cannot prove
that a reported timestamp came from a human physical input.

`features.ranking.enabled` therefore defaults to false. Before enabling durable
ratings or rewards, require a stable identity and an appropriate verifier tier,
define dispute/ban/reset behavior, and document evidence and ranking retention.
Canonical per-match placement alone is not a ranked-security guarantee.

## Privacy and retention

Use opaque identifiers on the wire and low-cardinality operational metrics.
Store only data needed for room recovery, fairness, or verification and define
automatic expiry. Avoid account profiles, IP addresses, device fingerprints,
raw invite/guest credentials, free-form text, and detailed input telemetry
unless the integrating product has a documented purpose and deletion policy.

The base harness has no chat and no required accounts, which reduces the data
surface; it does not remove legal/security responsibilities for IP logs,
analytics, backups, or game-specific evidence.

## Reporting vulnerabilities

Do not open a public issue for an exploitable vulnerability. Follow
[`SECURITY.md`](../SECURITY.md).
