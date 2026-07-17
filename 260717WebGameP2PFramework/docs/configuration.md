# Configuration

RelayPlay uses a small preset plus nested overrides. The normalized result is
deeply typed and runtime-validated. Prefer the generator or TypeScript helper to
hand-writing a complete object.

```bash
npm run configure -- \
  --preset soft-battle \
  --platform universal \
  --progress-ms 1000 \
  --output relayplay.config.json

npm run validate:config -- relayplay.config.json
```

The JSON form follows `relayplay.config.schema.json`. Secrets, signing keys, and
provider bindings do not belong in this file.

## Flag reference

All fields are optional in configuration input and become required after
normalization. Numeric values outside these limits are rejected.

| Path | Default | Allowed / meaning |
| --- | --- | --- |
| `protocolVersion` | `1` | fixed at `1` |
| `room.maxPlayers` | `8` | integer `1..256` |
| `room.disconnectGraceMs` | `15000` | integer `0..300000` |
| `room.eventLogCapacity` | `4096` | integer `1..1000000` |
| `features.progress.enabled` | `true` | progress snapshots |
| `features.interactions.enabled` | `true` | server-mediated intents |
| `features.interactions.targeted` | `true` | explicit recipients |
| `features.interactions.scheduled` | `true` | future effective time/boundary |
| `features.reconnect.enabled` | `true` | automatic resume support |
| `features.reconnect.replayCanonicalEvents` | `true` | replay after last sequence |
| `features.evidence.replayChunks` | `false` | replay evidence messages |
| `features.evidence.stateHashes` | `false` | state-hash evidence messages |
| `features.verification.interactionClaims` | `false` | validator hook required by policy |
| `features.verification.finalResults` | `false` | result verifier hook required by policy |
| `progress.intervalMs` | `1000` | integer `100..60000` ms |
| `progress.broadcast` | `true` | relay accepted snapshots |
| `time.clockMode` | `monotonic` | `monotonic`, `fixed-tick`, `audio` |
| `time.sync.enabled` | `true` | ping/pong clock estimator |
| `time.sync.sampleCount` | `5` | integer `1..64` |
| `time.sync.resyncIntervalMs` | `30000` | integer `1000..3600000` ms |
| `time.sync.maxRttMs` | `2000` | number `1..60000` ms |
| `time.startLeadMs` | `3000` | integer `0..120000` ms |
| `time.interactionLeadMs` | `150` | integer `0..30000` ms |
| `time.lateEventPolicy` | `next-boundary` | `apply-immediately`, `drop`, `next-boundary` |
| `time.tickRateHz` | `60` | integer `1..1000` |
| `time.audioLookAheadMs` | `100` | number `0..2000` ms |
| `platform.target` | `universal` | `universal`, `mobile-first`, `desktop-first` |
| `platform.inputs.*` | all `true` | touch, keyboard, pointer, gamepad; at least one |
| `platform.crossPlay.enabled` | `true` | cross-platform rooms |
| `platform.crossPlay.rankedPool` | `same-input-preferred` | `unified`, `same-input-preferred`, `separate` |
| `platform.crossPlay.allowInputSwitch` | `false` | mid-match input-class changes |
| `platform.presentation.adaptiveQuality` | `true` | capability-derived quality hints |
| `platform.presentation.maxDevicePixelRatio` | `2` | number `1..4` |
| `platform.presentation.preferReducedMotion` | `true` | honor OS preference |
| `security.peerToPeer` | `false` | invariant, cannot be enabled |
| `security.strictMessageValidation` | `true` | invariant, cannot be disabled |
| `security.maxMessageBytes` | `65536` | integer `1024..4194304` |
| `security.maxPayloadBytes` | `8192` | integer `0..1048576`, no larger than message |
| `security.opaqueIdentifiers` | `true` | invariant |
| `security.requireIdempotencyKeys` | `true` | invariant |
| `security.requireResumeEpoch` | `true` | invariant |
| `security.auth.requiredInProduction` | `true` | invariant |
| `security.rateLimits.default` | `20 / 10s⁻¹` | token-bucket capacity/refill |
| `security.rateLimits.actions.*` | action-specific | key regex plus capacity/refill |

Game presets may intentionally override a default—for example an audio race can
report every 500 ms. A final explicit override always wins.

## Configuration groups

### Progress

- Enable/disable reporting.
- Reporting interval; default `1000` ms.
- Maximum payload size and whether spectators receive snapshots.
- Latest-value behavior. Missing snapshots must not stall gameplay.

A 250–2,000 ms cadence covers most score races. Lower values increase visual
smoothness but do not improve authority. Interpolate UI between snapshots.

### Interactions

- Allowed action names and maximum payload bytes.
- Target mode (`none`, `single`, or room-policy selected).
- Per-action burst/refill/cooldown limits.
- Required future lead and scheduling boundary.
- Late policy (`discard`, `apply-next-boundary`, or explicit fallback).

The server treats a client message as an intent. It creates the canonical event
only after authentication, validation, policy, and deduplication pass.

### Time

- Synchronized start lead time.
- Ping sample count and periodic resync interval.
- Fixed-tick rate for deterministic games.
- Monotonic or audio-clock presentation hints.
- Maximum accepted uncertainty and late-event policy.

Clock sync estimates an offset; it does not change the operating-system clock.
Games should expose “syncing” when uncertainty is too high for a fair start.

### Reconnect

- Exponential backoff bounds and jitter.
- Server grace period for temporary disconnects.
- Resume sequence and epoch behavior.
- Snapshot/replay limits.

A reconnect from an older room epoch is a fresh join, never a continuation.

### Platform

- Target: `universal`, `mobile-first`, or `desktop-first`.
- Allowed input capabilities: touch, keyboard, pointer, and gamepad.
- Cross-play and ranked-pool policy.
- Adaptive presentation hints such as reduced effects and orientation.

Capability hints help the UI; the server must make competitive decisions from
authenticated session policy and observed input class.

### Security and verification

- Authentication mode/hook identifier.
- Message and per-action rate limits.
- Opaque ID requirements and token lifetime policy.
- Replay chunks, state hashes, result claims, and verifier hook identifiers.

Development may use an explicit insecure auth adapter. Production deployment
must replace it rather than hide it behind a generic boolean.

## Preset recipes

### Progress-only live race

Use `live-race`, keep the 1,000 ms cadence, disable gameplay interactions, and
interpolate remote progress in the UI.

### Soft battle

Use `soft-battle`, define a tiny payload for each action, require at least one
network round-trip worth of future lead plus a fairness margin, and display a
warning before application.

### Falling-block battle

Use `falling-block-battle`, fixed ticks, deterministic seed/ruleset, piece-lock
boundary scheduling, and replay verification. Progress remains noncanonical.

### Rhythm score race

Use `rhythm-race`, a long synchronized-start lead, regular resync, audio-clock
anchoring, measure-boundary effects, and conservative handling of clock
uncertainty.

## Invalid combinations

Validation rejects conditions such as an interaction-enabled game with no
allowed actions, a scheduled action with no lead/boundary policy, negative time
values, unsafe payload limits, incompatible platform/input policies, or
production auth without an auth hook.
