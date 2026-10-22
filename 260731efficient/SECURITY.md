# Security policy

Security fixes are provided for the newest published release. Before reporting
an issue, reproduce it with an unmodified release binary or a clean source
build and record the exact `idlepilot version`, host architecture, and relevant
reason codes. Never include credentials, private paths, or household data.

Use the repository's **Security → Report a vulnerability** private reporting
flow. If private reporting is unavailable, open a minimal public issue asking
the maintainer to establish a private channel; do not publish exploit details.

Useful reports identify the violated safety invariant, such as shell-free
execution, fail-closed condition handling, executable pinning, configuration
to state binding, PID/start-time identity, process-group cleanup, or secure
file ownership and permissions. Include a minimal synthetic reproducer when
possible.

The maintainer should acknowledge a private report, preserve evidence, prepare
a regression test and fix, and coordinate disclosure only after supported
users have an upgrade path. The project cannot offer a guaranteed response
time or security bounty.
