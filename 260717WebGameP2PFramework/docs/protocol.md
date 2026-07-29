# Wire protocol

The protocol is a discriminated JSON message envelope transported over a
client-to-server WebSocket. JSON is chosen for inspectability and safe initial
evolution; games may version a compact codec later without changing room
semantics.

## Connection lifecycle

```text
HTTP room/create or join (provider-specific)
       → authenticated WebSocket upgrade
       → session → authoritative snapshot → paginated replay
       → time samples → ready → canonical start
       → progress + occasional interaction → finish
       → ack sequence → disconnect → resume(sequence, epoch)
```

The server chooses or confirms player/session identity only after verifying the
provider credential. IDs supplied in a URL or message are routing/resume hints,
not proof of identity. The self-hosted adapter uses a room-scoped `HttpOnly`
guest cookie and explicitly rejects credentials in WebSocket query parameters;
other providers may use a short-lived ticket exchange.

### Accountless HTTPS bootstrap

The on-prem example adds a narrow HTTPS control plane before the WebSocket
protocol. It is not an arbitrary room-message API.

```text
POST /api/rooms  {}                 → 201 + room/player/invite + Set-Cookie
POST /api/join   { "invite": "…" } → 201 + room/player        + Set-Cookie
GET  /rooms/{opaqueRoomId}/ws       → WebSocket upgrade with cookie
```

Both POST requests require an exact allowed `Origin`, JSON content type,
bounded bodies, and `credentials: "include"`. The response exposes no guest
credential to JavaScript. The invite stays in a POST body (or a client-side URL
fragment used only to prefill the form), never a query string. WebSocket
upgrades reject query credentials.

After authentication, the server sends `session` and then a private `snapshot`
containing room status and bounded player presence/ready/progress-sequence
metadata. Existing room members receive a separate presence hint. A resumed
client requests canonical replay after its last contiguous sequence.

## Envelopes and versions

Every wire message has a protocol version and discriminant. Client mutation
messages carry a unique idempotency key. Canonical server events carry:

- room ID and room epoch;
- stable event ID;
- monotonically increasing server sequence;
- server creation time;
- actor and optional recipient;
- typed payload;
- optional future schedule (server time, tick, beat, or logical boundary).

Unknown versions, types, extra-large payloads, invalid identifiers, non-finite
numbers, and malformed nested values are rejected before room policy runs.

## Ephemeral messages

Ping/pong, heartbeat, presence hints, and progress are replaceable. Their
sequence is useful for freshness but gaps do not trigger canonical replay. The
server may coalesce or drop progress under pressure.

Progress must be bounded, serializable data—not a full game object graph. The
base protocol has no chat or generic text event. Game validators should reject
unexpected free-form text rather than accidentally creating an unmoderated
side channel.

## Canonical messages

Start, accepted interaction, finish/forfeit, and other ruleset-changing events
form an append-only per-room log. The room engine follows this order:

1. authenticate session and validate the wire message;
2. check epoch, idempotency key, target, rate, cooldown, and game policy;
3. create sequence/event ID and a safe future schedule;
4. persist the event;
5. broadcast it;
6. accept cumulative client acknowledgement.

Retries with the same idempotency key return or replay the same outcome and
must not apply twice.

A client that completes a round sends one `finish` intent with an idempotency
key and a bounded game-defined result claim. Game policy validates the claim;
the room engine derives canonical elapsed time and per-round placement,
persists a `finish` event, and then broadcasts it. Disconnect expiry can
produce the same event kind with a forfeit reason. Durable ranked rewards still
require a result/evidence verifier and stable identity. Placement is room-local
ordering, not proof of an honest score or a global ranking.

## Scheduling and late delivery

Network arrival time is nondeterministic. An accepted interaction therefore
describes when the recipient's game should apply it. Supported models include:

- absolute server time translated through the clock estimator;
- fixed simulation tick;
- beat/measure index;
- named boundary such as `next-piece-lock`.

The game maps named boundaries to its own local simulation. If an event is
already late, apply the configured explicit policy and record the decision for
replay/telemetry. Do not silently apply immediately.

## Resume and gaps

The client remembers the last contiguous canonical sequence and its last
accepted progress sequence. On reconnect it sends the canonical sequence and
room epoch. The server establishes session identity, sends an authoritative
room snapshot, and pages later canonical events; it rejects resume if the
epoch/grace/log window no longer permits it. The snapshot restores presence,
ready state, room status, and accepted progress-sequence continuity. Canonical
replay restores start/interaction/finish events; fresh replaceable progress
arrives in later progress messages rather than being promoted to the canonical
log.

Clients may buffer a small out-of-order window, but only expose canonical events
in sequence. A persistent gap triggers a replay request; it does not guess.

## Evolution

Additive optional fields can remain within a protocol version when defaults are
unambiguous. Renamed discriminants, changed units, changed ordering semantics,
or required fields need a new protocol version and compatibility tests.
