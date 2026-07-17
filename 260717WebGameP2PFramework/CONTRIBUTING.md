# Contributing

Open an issue or draft pull request describing the game class and network
invariant affected. Keep changes scoped to the package boundaries documented in
`AGENTS.md`.

```bash
npm install
npm run verify
```

Protocol changes need runtime validation and malformed-message tests. Config
changes need defaults, validation, JSON Schema coverage, and docs. Public API
changes should include a migration note.

By participating, you agree to follow `CODE_OF_CONDUCT.md`. Do not report
security vulnerabilities in a public issue; use `SECURITY.md`.
