# Changelog

All notable changes are recorded here. This project follows Semantic Versioning.

## 0.1.0

- Added the Linux-only `idlepilot` library and headless JSON CLI.
- Added fail-closed Wi-Fi, external-power, logind-idle, and local-time gates.
- Added conservative DMI chassis classification so missing laptop battery
  inventory cannot be mistaken for a stationary system.
- Added ten-minute waiting polls and a 100–250 ms active guard, paired with a 250 ms logind query bound.
- Added shell-free literal-argv execution, environment clearing, digest pinning, and content-addressed artifact import.
- Added dedicated process-group shutdown, PID identity checks, durable once-per-window state, and systemd cgroup cleanup guidance.
- Added durable pre-spawn launch-intent accounting so a crash cannot erase an
  attempt at the fork/exec boundary.
- Added an unresolved launch-intent startup fence that prevents automatic
  duplicate execution after a daemon dies between durable intent and action
  identity; recovery requires verified cleanup and preserved/rotated state.
- Hardened stale-state recovery so a persisted action whose leader and process
  group are both gone is reported as `terminal_result_unknown` instead of being
  cleared: process absence cannot prove its terminal result or external side
  effects. Such state and persisted `fault` now produce plan
  `recovery_required`, status attention, and startup refusal until reviewed and
  preserved/rotated.
- Added a finite background running-state deadline and terminal process-exit
  path that retains the instance lock when state persistence or process-group
  cleanup cannot be confirmed.
- Added bounded failed-spawn cleanup that must prove leader reap and an owned
  process group's emptiness within two seconds after executable identity, PGID,
  or start-ticks verification fails, otherwise requiring terminal process exit.
- Made the public `ActionProcess` destructor use bounded cleanup and, on
  uncertainty, only final kill plus nonblocking `try_wait`, avoiding an
  unbounded host wait on a D-state leader.
- Exposed `Error::requires_process_exit()` for terminal uncertainty and made
  the CLI suppress JSON/human error output on that path so a full output pipe
  cannot delay process exit and systemd cgroup cleanup.
- Made `init` create missing configuration/state parent paths with mode 0700
  and reject an existing final parent unless it is caller-owned mode 0700.
- Expanded `init` so repeatable literal `--arg`/`--env` entries and every
  window, condition, timing, runtime, attempt, and retry policy can be written
  without manual config editing.
- Added deterministic config construction APIs: conservative `Config::new`
  defaults, policy parse/canonical helpers, `Config::to_canonical_text`,
  `Config::state_fingerprint`, and secure create-new storage.
- Added the read-only `plan` command and `LaunchPlan` library API, combining
  live conditions, artifact verification, process identity, attempts, and
  completion state into stable decisions and exit codes.
- Expanded `status` with action identity classification, attention and liveness
  flags, PGID, attempt window/limit, last exit code/signal, and state timestamp.
- Upgraded durable state to canonical schema v2 with a SHA-256 binding over
  complete canonical semantic lines after comment removal. Changed
  configurations and schema-v1 state require a safe stop plus preserved or
  rotated state instead of implicit reinterpretation.
- Separated path validation from creation so validation, planning, diagnostic,
  status, and digest reads do not create missing directories or state; only
  onboarding and an explicit supervisor run own the corresponding creation
  paths.
- Added direct subprocess household workflows covering atomic verified backup
  publication and once-per-window suppression, fail-once retry limits, and
  bounded cleanup of a three-level long-running process tree.
- Made single-result and diagnostic stdout writers tolerate `BrokenPipe`
  without a panic while retaining `run` JSONL sink failure as a supervision
  error that requires consumers to drain the stream.
- Persisted terminal/retry policy and cleared action identity before flushing
  deferred lifecycle events, so an output-sink failure after an action exits
  leaves a durable fault/restart fence instead of permitting a duplicate side
  effect.
- Kept operator SIGINT/SIGTERM shutdown distinct from guard loss, so disabling
  guard-loss retries cannot by itself mark the whole window complete; the
  already-reserved attempt still counts on the next evaluation.
- Re-polled action exit after post-spawn/periodic observations and before every
  signal, runtime, or guard-stop decision, so an already available successful
  exit is durably completed instead of being misclassified and retried.
- Skipped the background running-state write for actions already reaped by the
  post-spawn check and raised its finite minimum deadline from 2 to 15 seconds;
  durable launch intent still fences crashes while ordinary home-storage fsync
  stalls no longer cause spurious terminal faults.
- Made canonical config generation reject relative, oversized, non-UTF-8,
  control-bearing, overlong-line, and over-limit representations that the
  schema-v1 reader cannot accept.
- Tightened canonical parsing so embedded quotes must use `\"`, and rejected
  impossible state relations such as nonzero attempts without an attempt
  window or simultaneous exit code and signal.
- Replaced check-then-numeric-PID control with mandatory pidfds for both action
  supervision and CLI stop. Action support is preflighted before launch;
  exited leaders remain unreaped to reserve their PGID while `/proc` member
  scans and descendant cleanup finish, eliminating PID/PGID reuse targets.
- Preserved leader status reaped during a stop and made only exits observed
  before the first stop signal override guard, runtime, or shutdown policy.
- Made background state-writer thread creation fallible and hard-stop the
  action before returning its error; group emptiness now requires two fresh
  `/proc` member scans before the zombie leader releases its PGID reservation.
- Made non-UTF-8 Linux argv a structured usage error instead of a pre-handler
  panic, and specified the exact comment-free fingerprint preimage with a
  stable known vector.
- Removed the project-wide permission grant and package license declaration
  while preserving exact Rust standard-library notices, dynamic-system-library
  SBOM entries, and third-party license boundaries in binary releases.
- Documented the tested portability boundary: native x86_64 GNU/Linux release
  tests, aarch64 GNU compile-check only, build-host glibc compatibility for
  native archives, and no current musl validation.
