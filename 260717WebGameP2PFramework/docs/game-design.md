# Designing a loosely coupled multiplayer game

## Classify the game before choosing netcode

RelayPlay targets games where participants are simultaneous but their moment to
moment simulations are independent. A player may see another player's score,
height, combo, health, ghost, or coarse progress, and may occasionally send an
effect, but does not need every remote input to advance their own next frame.

That distinction is more important than whether the game “feels real-time.” A
rhythm race can feel immediate while using one progress update per second. A
falling-block attack can feel fair while arriving over a slower network when it
is scheduled for the recipient's next piece-lock boundary.

Do not use this architecture for fighting games, shared physics, action combat,
or anything that requires rollback of a common world.

## Split state into three layers

| Layer | Owner | Examples | Network rule |
| --- | --- | --- | --- |
| Local simulation | client game | board, notes, animation, input, audio | never waits for network |
| Observable progress | reporting client | score, rank, board height, phase | latest snapshot wins |
| Canonical match events | room server | start, accepted attack, finish, forfeit | ordered, persisted, replayed |

This keeps the hot path small. Sending board or score snapshots more frequently
does not make them authoritative; it only changes spectator freshness.

## Falling-block and Tetris-like games

Use a deterministic seed, fixed simulation tick, explicit input/event log, and
a stable ruleset identifier. Report coarse board height, lines, score, and phase
as progress. Send an attack as an intent, let the server validate rate/cooldown
and target, then assign a sequence and delivery schedule.

Good application boundaries include:

- after the current piece locks;
- before the next piece spawns;
- at a future fixed tick with enough lead time;
- after a short cancellable warning phase.

The recipient should acknowledge the canonical event sequence, not the visual
effect. A deterministic replay verifier can later recompute line clears and
attack eligibility. Client screenshots or raw score claims are not proof.

## Rhythm-like games

Synchronize a start several seconds into the future. Estimate server clock
offset using multiple ping samples and a monotonic clock; do not set gameplay
time from `Date.now()` on every frame. Once audio is unlocked by a user gesture,
anchor chart time to `AudioContext.currentTime`. Rendering may use
`requestAnimationFrame`, but scoring must not depend on display refresh rate.

Progress can contain song position, score, combo, and accuracy. A remote effect
should target a future beat or measure. If it arrives too late, apply the
configured late policy—usually the next boundary or discard—rather than silently
changing its effect time.

An open browser can forge input timestamps. Ranked rhythm play can add anomaly
checks and signed sessions, but should not claim cryptographic proof of physical
input without a trusted execution environment.

## Mobile and desktop

Start with one simulation and protocol, then choose one presentation target:

### Universal default

Best when reach matters. Use capability detection, responsive layout, safe-area
insets, large touch targets, keyboard shortcuts, reduced effects on constrained
devices, and an explicit audio-unlock flow. Avoid browser user-agent branching
when an actual capability can be tested.

### Mobile-first

Best for portrait, one- or two-thumb interaction. Reserve screen space for the
browser's dynamic viewport, prevent accidental scrolling only inside the game
surface, tolerate touch cancellation, and pause or mark disconnected on page
backgrounding according to game rules. Desktop controls may exist but should
not dictate layout.

### Desktop-first

Best for dense charts, precise keyboards, pointer lock, or large spectator
panels. Keep the simulation compatible with mobile if possible, but be honest
when the interaction model cannot be made fair on touch.

### Cross-play policy

Allow casual cross-play by default. Record actual input class—not merely device
type—and observe win/score distributions. Competitive pools can then be
`combined`, `input-class`, or `platform` based on evidence. Do not fork physics
or scoring to compensate for controls; use matchmaking/ruleset policy instead.

## A practical launch sequence

1. Ship progress-only rooms and synchronized starts.
2. Add one named interaction with a visible warning and future boundary.
3. Add reconnect/resume and explicit disconnected state.
4. Record canonical replays and result hashes.
5. Add a verifier before ranked rewards have value.
6. Tune update frequency and matchmaking from measurements, not intuition.
