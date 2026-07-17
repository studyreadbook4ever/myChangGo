# Wire protocol

The protocol is a discriminated JSON message envelope transported over a
client-to-server WebSocket. JSON is chosen for inspectability and safe initial
evolution; games may version a compact codec later without changing room
semantics.

## Connection lifecycle

```text
connect → authenticate/join → time samples → ready
       → canonical start → progress + interaction intents
       → ack canonical sequences → disconnect → resume(sequence, epoch)
```

The server chooses the player/session identity after verifying the join
credential. IDs supplied in message bodies are routing hints, not proof of
identity.

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

Progress must be bounded, serializable data—not a full game object graph. Avoid
user-provided text unless the application separately moderates it.

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

The client remembers the last contiguous canonical sequence. On reconnect it
sends that sequence and room epoch. The server either replays later events,
sends an authoritative room snapshot plus later events, or rejects resume if
the epoch/grace/log window no longer permits it.

Clients may buffer a small out-of-order window, but only expose canonical events
in sequence. A persistent gap triggers a replay request; it does not guess.

## Evolution

Additive optional fields can remain within a protocol version when defaults are
unambiguous. Renamed discriminants, changed units, changed ordering semantics,
or required fields need a new protocol version and compatibility tests.
