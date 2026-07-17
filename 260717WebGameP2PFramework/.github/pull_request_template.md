## Outcome

Describe the game/network behavior changed and the package boundary involved.

## Invariants

- [ ] No P2P path was introduced.
- [ ] The local game loop still never waits for the network.
- [ ] Wire/config changes have runtime validation and documentation.
- [ ] Canonical events remain persist-before-broadcast and sequence-resumable.
- [ ] Security/ranked claims remain accurate.

## Verification

- [ ] `npm run verify`
- [ ] Browser touch/keyboard acceptance when the example or client changed
