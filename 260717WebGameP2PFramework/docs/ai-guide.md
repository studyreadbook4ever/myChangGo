# AI implementation guide

RelayPlay is structured so a coding agent can change one policy without
inventing network semantics. The source of truth is the exported core types plus
runtime validators; examples demonstrate usage but do not define the protocol.

## Starting a new game

1. Classify it against `docs/game-design.md`. If it needs shared-frame rollback
   or common physics, stop: RelayPlay is the wrong base.
2. Select the nearest game preset and platform overlay.
3. Generate configuration with `npm run configure`; do not copy a normalized
   object from test output.
4. Define a small serializable progress shape and one discriminated payload per
   interaction.
5. Map every interaction to a future time/tick/beat/named boundary and specify
   late behavior.
6. Implement game-specific server policy and optional deterministic verifier.
7. Connect the browser SDK to the local game through callbacks/events. Keep
   framework networking out of the render loop.
8. Test mobile touch, desktop keyboard, background/foreground, offline/online,
   duplicate intent, reconnect, and sequence gaps.

## Prompt context to provide an agent

Supply:

- selected preset and platform target;
- progress payload fields with units and safe ranges;
- interaction variants, target rules, limits, and schedule boundaries;
- synchronized-start and clock requirements;
- casual versus ranked trust tier;
- desired Cloudflare bindings and application auth contract.

Do not ask an agent merely to “make it real-time.” State the observable freshness
and fairness rule instead.

## Safe extension patterns

- Add a progress field: update the game payload validator; do not make it a
  canonical room event unless ordering/replay matters.
- Add an interaction: add one discriminated variant, server policy, schedule,
  rate limit, recipient handler, malformed-input tests, and replay test.
- Add a provider: implement server ports; do not fork room policy.
- Add a platform: add capability/presentation policy; do not fork simulation or
  wire semantics.
- Add ranked mode: define evidence and verifier failure behavior; do not promote
  progress snapshots to authority.

## Required automated checks

```bash
npm run validate:config -- relayplay.config.json
npm run typecheck
npm test
npm run build
npm run test:cloudflare
npm run verify
```

When a wire or config shape changes, search docs and schema for its old name.
Keep fixtures small and prefer injected fake clocks/sockets/storage over real
timeouts or public infrastructure.
