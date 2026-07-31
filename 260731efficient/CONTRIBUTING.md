# Contributing

Contributions are welcome when they preserve the core safety contract: unknown conditions fail closed, actions never pass through a shell, and loss of a running guard triggers immediate hard termination.

Before submitting a change, run:

```console
./scripts/check-release.sh
```

Changes to config/state behavior should preserve the canonical writer and
schema-v2 config fingerprint contract. Add direct workflow coverage when a
change affects launch, retry, publication, or process cleanup; the existing
household tests use real subprocesses for backup, flaky indexing, and a
three-level process tree.

Unsafe Rust is limited to small Linux/POSIX adapters. Any new or changed `unsafe` block must include a local safety argument and a regression test covering its boundary.

External code contributions are not accepted unless the maintainer and contributor
first agree in writing on ownership and permission terms. Issues and design
discussion are welcome, but opening a pull request does not grant either side an
implicit right to use the submitted material. Do not submit code owned by an
employer or another person without their explicit permission.

Do not copy third-party source, generated assets, test data, or binaries into
the repository unless their redistribution terms have been reviewed and
`THIRD_PARTY.md`, `NOTICE`, the SBOM generator, and package metadata have been
updated. Third-party Rust and operating-system components retain their own
copyright and license terms.
