#![allow(
    unsafe_code,
    reason = "audited Linux pre-exec hardening calls with no Rust work after fork"
)]

use crate::config::Config;
use crate::error::{Error, ErrorKind, Result};
use crate::{security, sha256};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const FAILED_SPAWN_CLEANUP_DEADLINE: Duration = Duration::from_secs(2);
const GROUP_EMPTY_CONFIRMATION_DELAY: Duration = Duration::from_millis(5);
const PR_SET_NO_NEW_PRIVS: i32 = 38;
const RLIMIT_CORE: i32 = 4;

#[repr(C)]
struct RLimit {
    current: u64,
    maximum: u64,
}

unsafe extern "C" {
    fn prctl(option: i32, ...) -> i32;
    fn setrlimit(resource: i32, limits: *const RLimit) -> i32;
    fn umask(mask: u32) -> u32;
}

/// Normal or signaled action exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionExit {
    /// Conventional integer exit code when available.
    pub code: Option<i32>,
    /// Terminating signal when available.
    pub signal: Option<i32>,
    /// Whether the leader exited successfully and no descendants leaked.
    pub success: bool,
}

/// When the leader exit became observable relative to process-group stopping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopExitTiming {
    /// The leader had exited before any stop signal was sent.
    BeforeSignal,
    /// The leader exit was first observed after stop signalling began.
    AfterSignal,
}

/// Result of a TERM-to-KILL process-group shutdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopOutcome {
    /// Whether SIGTERM was sent.
    pub term_sent: bool,
    /// Whether SIGKILL was required.
    pub kill_sent: bool,
    /// Whether the process group was proven empty.
    pub group_empty: bool,
    /// Leader status reaped while stopping, when one was observable.
    ///
    /// A nominally successful leader is downgraded when descendants outlive
    /// it, matching [`ActionProcess::poll`].
    pub leader_exit: Option<ActionExit>,
    /// Whether leader exit was observed before the first stop signal.
    ///
    /// Only this case is an unambiguous natural exit. A code-zero status first
    /// observed after TERM may instead come from an interruption handler.
    pub exit_timing: StopExitTiming,
    /// Total shutdown latency.
    pub elapsed: Duration,
}

/// A child launched into a dedicated process group.
pub struct ActionProcess {
    child: Child,
    leader_handle: security::ProcessHandle,
    pid: u32,
    pgid: i32,
    start_ticks: Option<u64>,
    started: Instant,
    active: bool,
}

/// An executable whose potentially expensive digest verification has already
/// completed. The supervisor creates this before its final condition query.
pub(crate) struct PreparedAction {
    executable: PathBuf,
    digest: Option<String>,
    identity: ArtifactIdentity,
}

#[derive(Clone, Copy)]
struct ArtifactIdentity {
    device: u64,
    inode: u64,
    length: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

impl ArtifactIdentity {
    fn capture(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }

    fn matches(self, metadata: &fs::Metadata) -> bool {
        self.device == metadata.dev()
            && self.inode == metadata.ino()
            && self.length == metadata.len()
            && self.modified_seconds == metadata.mtime()
            && self.modified_nanoseconds == metadata.mtime_nsec()
            && self.changed_seconds == metadata.ctime()
            && self.changed_nanoseconds == metadata.ctime_nsec()
    }
}

impl PreparedAction {
    pub(crate) fn prepare(config: &Config) -> Result<Self> {
        security::require_unprivileged_user()?;
        config.validate_action()?;
        security::require_process_handle_support()?;
        let before = fs::metadata(&config.executable).map_err(|error| {
            Error::io(
                ErrorKind::Security,
                "cannot capture executable identity",
                error,
            )
        })?;
        verify_artifact(config)?;
        let after = fs::metadata(&config.executable).map_err(|error| {
            Error::io(
                ErrorKind::Security,
                "cannot re-check prepared executable",
                error,
            )
        })?;
        let identity = ArtifactIdentity::capture(&before);
        if !identity.matches(&after) {
            return Err(Error::new(
                ErrorKind::Security,
                "executable changed while it was prepared",
            ));
        }
        Ok(Self {
            executable: config.executable.clone(),
            digest: config.executable_sha256.clone(),
            identity,
        })
    }

    fn validate_for(&self, config: &Config) -> Result<()> {
        if self.executable != config.executable || self.digest != config.executable_sha256 {
            return Err(Error::new(
                ErrorKind::Security,
                "prepared action does not match the launch configuration",
            ));
        }
        let metadata = fs::metadata(&config.executable).map_err(|error| {
            Error::io(
                ErrorKind::Security,
                "cannot inspect prepared executable",
                error,
            )
        })?;
        if !self.identity.matches(&metadata) {
            return Err(Error::new(
                ErrorKind::Security,
                "prepared executable identity changed before launch",
            ));
        }
        Ok(())
    }
}

impl ActionProcess {
    /// Verify and launch the configured executable without a shell.
    pub fn spawn(config: &Config) -> Result<Self> {
        let prepared = PreparedAction::prepare(config)?;
        Self::spawn_prepared(config, &prepared)
    }

    #[allow(
        clippy::too_many_lines,
        reason = "spawn validation and every fail-closed cleanup path stay adjacent"
    )]
    pub(crate) fn spawn_prepared(config: &Config, prepared: &PreparedAction) -> Result<Self> {
        prepared.validate_for(config)?;
        let mut command = Command::new(&config.executable);
        command
            .args(&config.args)
            .current_dir(&config.working_directory)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .envs(&config.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);

        // SAFETY: only async-signal-safe libc calls are made between fork and exec.
        unsafe {
            command.pre_exec(|| {
                let limits = RLimit {
                    current: 0,
                    maximum: 0,
                };
                if prctl(PR_SET_NO_NEW_PRIVS, 1i32, 0i32, 0i32, 0i32) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if setrlimit(RLIMIT_CORE, &raw const limits) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                umask(0o077);
                Ok(())
            });
        }

        let mut child = command
            .spawn()
            .map_err(|error| Error::io(ErrorKind::Process, "cannot launch action", error))?;
        let process_id = child.id();
        let Ok(action_group) = i32::try_from(process_id) else {
            let error = Error::new(ErrorKind::Process, "child PID does not fit i32");
            return Err(cleanup_failed_spawn(&mut child, None, false, error));
        };
        if let Err(error) = security::validate_signal_group(action_group) {
            return Err(cleanup_failed_spawn(
                &mut child,
                Some(action_group),
                false,
                error,
            ));
        }
        // Open the stable kernel handle before any further post-spawn work.
        // Kernel/architecture support was preflighted before the durable
        // launch intent; per-process resource failures still clean up here.
        let leader_handle = match security::ProcessHandle::open(process_id) {
            Ok(Some(handle)) => handle,
            Ok(None) => {
                let error = Error::new(
                    ErrorKind::Security,
                    "child disappeared before a stable process handle could be opened",
                );
                return Err(cleanup_failed_spawn(
                    &mut child,
                    Some(action_group),
                    false,
                    error,
                ));
            }
            Err(error) => {
                return Err(cleanup_failed_spawn(
                    &mut child,
                    Some(action_group),
                    false,
                    error,
                ));
            }
        };

        // Catch the common validate/execute replacement race. Immutable imported
        // artifacts make the remaining same-UID race irrelevant to privilege.
        let after = match fs::metadata(&config.executable) {
            Ok(metadata) => metadata,
            Err(error) => {
                let error = Error::io(
                    ErrorKind::Security,
                    "cannot re-check executable identity",
                    error,
                );
                return Err(cleanup_failed_spawn(
                    &mut child,
                    Some(action_group),
                    false,
                    error,
                ));
            }
        };
        if !prepared.identity.matches(&after) {
            let error = Error::new(ErrorKind::Security, "executable changed during launch");
            return Err(cleanup_failed_spawn(
                &mut child,
                Some(action_group),
                false,
                error,
            ));
        }

        // CommandExt::process_group(0) requests child PID == PGID. Verify when
        // the leader is alive or a waitable zombie. Both the PGID and start
        // ticks are mandatory because they are persisted across daemon restarts.
        let observed_group = match security::process_group_id(process_id) {
            Ok(Some(group)) => group,
            Ok(None) => {
                let error = Error::new(
                    ErrorKind::Security,
                    "child disappeared before its process group could be verified",
                );
                return Err(cleanup_failed_spawn(
                    &mut child,
                    Some(action_group),
                    false,
                    error,
                ));
            }
            Err(error) => {
                return Err(cleanup_failed_spawn(
                    &mut child,
                    Some(action_group),
                    false,
                    error,
                ));
            }
        };
        if observed_group != action_group {
            let error = Error::new(
                ErrorKind::Security,
                "child did not enter its dedicated process group",
            );
            return Err(cleanup_failed_spawn(
                &mut child,
                Some(action_group),
                false,
                error,
            ));
        }
        let start_ticks = match security::process_start_ticks_including_zombie(
            process_id,
            std::path::Path::new("/proc"),
        ) {
            Ok(ticks) => ticks,
            Err(error) => {
                return Err(cleanup_failed_spawn(
                    &mut child,
                    Some(action_group),
                    true,
                    error,
                ));
            }
        };
        Ok(Self {
            child,
            leader_handle,
            pid: process_id,
            pgid: action_group,
            start_ticks: Some(start_ticks),
            started: Instant::now(),
            active: true,
        })
    }

    /// Leader PID.
    #[must_use]
    pub const fn pid(&self) -> u32 {
        self.pid
    }

    /// Dedicated process group.
    #[must_use]
    pub const fn process_group(&self) -> i32 {
        self.pgid
    }

    /// `/proc` start-time identity when captured.
    #[must_use]
    pub const fn start_ticks(&self) -> Option<u64> {
        self.start_ticks
    }

    /// Time since launch.
    #[must_use]
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Poll for leader completion. Any remaining descendants are terminated.
    pub fn poll(&mut self, descendant_grace: Duration) -> Result<Option<ActionExit>> {
        match self.poll_inner(descendant_grace) {
            Ok(exit) => Ok(exit),
            Err(error) => Err(self.cleanup_after_poll_error(error)),
        }
    }

    fn poll_inner(&mut self, descendant_grace: Duration) -> Result<Option<ActionExit>> {
        let _ = checked_deadline(descendant_grace)?;
        self.validate_owned_group()?;
        if !self.leader_handle.has_exited()? {
            self.validate_live_leader_group()?;
            return Ok(None);
        }
        let stop = self.stop(descendant_grace)?;
        if !stop.group_empty {
            return Err(Error::new(
                ErrorKind::Security,
                "action descendants remained after process-group SIGKILL",
            )
            .requiring_process_exit());
        }
        stop.leader_exit.map(Some).ok_or_else(|| {
            Error::new(
                ErrorKind::Internal,
                "stopped action did not preserve its leader exit status",
            )
        })
    }

    fn cleanup_after_poll_error(&mut self, original_error: Error) -> Error {
        match self.stop(Duration::ZERO) {
            Ok(stop) if stop.group_empty => original_error,
            Ok(_) => uncertain_poll_cleanup(&original_error, None),
            Err(cleanup_error) => uncertain_poll_cleanup(&original_error, Some(&cleanup_error)),
        }
    }

    /// Stop the entire process group with TERM followed by bounded KILL.
    pub fn stop(&mut self, grace: Duration) -> Result<StopOutcome> {
        match self.stop_inner(grace) {
            Ok(outcome) => Ok(outcome),
            Err(error) if self.active => {
                self.kill_direct_leader_bounded();
                Err(error.requiring_process_exit())
            }
            Err(error) => Err(error),
        }
    }

    fn stop_inner(&mut self, grace: Duration) -> Result<StopOutcome> {
        let started = Instant::now();
        if !self.active {
            let leader_exit = self
                .child
                .try_wait()
                .map_err(|error| {
                    Error::io(ErrorKind::Process, "cannot reap stopped action", error)
                })?
                .map(action_exit);
            return Ok(StopOutcome {
                term_sent: false,
                kill_sent: false,
                group_empty: true,
                leader_exit,
                exit_timing: StopExitTiming::BeforeSignal,
                elapsed: started.elapsed(),
            });
        }
        let deadline = started.checked_add(grace).ok_or_else(|| {
            Error::new(
                ErrorKind::Process,
                "process stop grace is too large for the monotonic clock",
            )
        })?;
        self.validate_owned_group()?;
        let mut descendants_outlived_leader = false;
        let mut exit_timing = if self.leader_handle.has_exited()? {
            StopExitTiming::BeforeSignal
        } else {
            StopExitTiming::AfterSignal
        };
        if exit_timing == StopExitTiming::BeforeSignal {
            if !self.stop_has_live_members(&mut descendants_outlived_leader)? {
                return self.finish_stop(
                    started,
                    false,
                    false,
                    descendants_outlived_leader,
                    exit_timing,
                );
            }
        } else {
            self.validate_live_leader_group()?;
            // Narrow the natural-exit/stop linearization point immediately
            // before the first signal. A later code-zero exit is deliberately
            // treated as ambiguous rather than proven natural completion.
            if self.leader_handle.has_exited()? {
                exit_timing = StopExitTiming::BeforeSignal;
            }
            if exit_timing == StopExitTiming::BeforeSignal
                && !self.stop_has_live_members(&mut descendants_outlived_leader)?
            {
                return self.finish_stop(
                    started,
                    false,
                    false,
                    descendants_outlived_leader,
                    exit_timing,
                );
            }
        }
        let term_sent = send_group(self.pgid, security::SIGTERM)?;
        while Instant::now() < deadline {
            if !self.stop_has_live_members(&mut descendants_outlived_leader)? {
                return self.finish_stop(
                    started,
                    term_sent,
                    false,
                    descendants_outlived_leader,
                    exit_timing,
                );
            }
            thread::sleep(Duration::from_millis(20));
        }
        // Close the natural-exit race immediately before escalation.
        if !self.stop_has_live_members(&mut descendants_outlived_leader)? {
            return self.finish_stop(
                started,
                term_sent,
                false,
                descendants_outlived_leader,
                exit_timing,
            );
        }
        let kill_sent = send_group(self.pgid, security::SIGKILL)?;
        let hard_deadline = checked_deadline(Duration::from_secs(2))?;
        while Instant::now() < hard_deadline {
            if !self.stop_has_live_members(&mut descendants_outlived_leader)? {
                return self.finish_stop(
                    started,
                    term_sent,
                    kill_sent,
                    descendants_outlived_leader,
                    exit_timing,
                );
            }
            thread::sleep(Duration::from_millis(20));
        }
        if !self.stop_has_live_members(&mut descendants_outlived_leader)? {
            return self.finish_stop(
                started,
                term_sent,
                kill_sent,
                descendants_outlived_leader,
                exit_timing,
            );
        }
        Ok(StopOutcome {
            term_sent,
            kill_sent,
            group_empty: false,
            leader_exit: None,
            exit_timing,
            elapsed: started.elapsed(),
        })
    }

    fn stop_has_live_members(&self, descendants_outlived_leader: &mut bool) -> Result<bool> {
        if !self.leader_handle.has_exited()? {
            self.validate_live_leader_group()?;
            return Ok(true);
        }
        let descendants = security::process_group_has_other_members(
            self.pgid,
            self.pid,
            std::path::Path::new("/proc"),
        )?;
        if descendants {
            *descendants_outlived_leader = true;
            return Ok(true);
        }
        // A member may fork and disappear while one /proc read_dir pass is in
        // progress. Require two empty observations from fresh enumerations
        // before releasing the zombie leader that reserves this PGID.
        thread::sleep(GROUP_EMPTY_CONFIRMATION_DELAY);
        let confirmed_descendants = security::process_group_has_other_members(
            self.pgid,
            self.pid,
            std::path::Path::new("/proc"),
        )?;
        if confirmed_descendants {
            *descendants_outlived_leader = true;
        }
        Ok(confirmed_descendants)
    }

    fn finish_stop(
        &mut self,
        started: Instant,
        term_sent: bool,
        kill_sent: bool,
        descendants_outlived_leader: bool,
        exit_timing: StopExitTiming,
    ) -> Result<StopOutcome> {
        let status = self
            .child
            .try_wait()
            .map_err(|error| Error::io(ErrorKind::Process, "cannot reap stopped action", error))?
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::Security,
                    "pidfd reported exit without a reapable action leader",
                )
            })?;
        let mut leader_exit = action_exit(status);
        leader_exit.success &= !descendants_outlived_leader;
        self.active = false;
        Ok(StopOutcome {
            term_sent,
            kill_sent,
            group_empty: true,
            leader_exit: Some(leader_exit),
            exit_timing,
            elapsed: started.elapsed(),
        })
    }

    fn kill_direct_leader_bounded(&mut self) {
        let _ = self.leader_handle.signal(security::SIGKILL);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match self.leader_handle.has_exited() {
                Ok(true) | Err(_) => return,
                Ok(false) => thread::sleep(Duration::from_millis(20)),
            }
        }
    }

    fn validate_owned_group(&self) -> Result<()> {
        let expected = i32::try_from(self.pid)
            .map_err(|_| Error::new(ErrorKind::Security, "action PID does not fit i32"))?;
        if self.pgid != expected {
            return Err(Error::new(
                ErrorKind::Security,
                "action process-group identity no longer matches its leader",
            ));
        }
        security::validate_signal_group(self.pgid)
    }

    fn validate_live_leader_group(&self) -> Result<()> {
        match security::process_group_id(self.pid)? {
            Some(observed) if observed == self.pgid => Ok(()),
            Some(_) => Err(Error::new(
                ErrorKind::Security,
                "action leader escaped its dedicated process group",
            )),
            None => Err(Error::new(
                ErrorKind::Security,
                "action leader disappeared before its process group could be verified",
            )),
        }
    }
}

fn checked_deadline(duration: Duration) -> Result<Instant> {
    Instant::now().checked_add(duration).ok_or_else(|| {
        Error::new(
            ErrorKind::Process,
            "duration is too large for the monotonic clock",
        )
    })
}

fn action_exit(status: ExitStatus) -> ActionExit {
    ActionExit {
        code: status.code(),
        signal: status.signal(),
        success: status.success(),
    }
}

impl Drop for ActionProcess {
    fn drop(&mut self) {
        if self.active {
            let _ = self.stop(Duration::ZERO);
        }
        if self.active {
            // A failed bounded stop may already have reaped the leader. Never
            // signal the numeric PGID afterward: it could have been reused.
            let _ = self.child.kill();
        }
        // Drop must never wait indefinitely on a D-state or otherwise
        // unkillable leader. stop() already performed bounded reaping when it
        // could prove the group empty; this final poll is deliberately
        // non-blocking on uncertain cleanup.
        let _ = self.child.try_wait();
    }
}

fn cleanup_failed_spawn(
    child: &mut Child,
    pgid: Option<i32>,
    group_was_verified: bool,
    original_error: Error,
) -> Error {
    let safe_group = pgid.filter(|group| security::validate_signal_group(*group).is_ok());
    let group_is_owned = group_was_verified
        || safe_group.is_some_and(|group| {
            matches!(
                security::process_group_id(child.id()),
                Ok(Some(observed)) if observed == group
            )
        });
    if let Some(group) = safe_group {
        let _ = security::send_signal(-group, security::SIGKILL);
    }
    let _ = child.kill();
    let deadline = Instant::now() + FAILED_SPAWN_CLEANUP_DEADLINE;
    loop {
        let leader_reaped = match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(_) => return uncertain_spawn_cleanup(&original_error),
        };
        let group_empty = match safe_group {
            Some(group) => match security::process_group_exists(group) {
                Ok(exists) => !exists,
                Err(_) => return uncertain_spawn_cleanup(&original_error),
            },
            None => false,
        };
        if leader_reaped {
            if safe_group.is_none() || (group_empty && !group_is_owned) {
                return uncertain_spawn_cleanup(&original_error);
            }
            if group_empty && group_is_owned {
                return original_error;
            }
        }
        if Instant::now() >= deadline {
            return uncertain_spawn_cleanup(&original_error);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn uncertain_spawn_cleanup(original_error: &Error) -> Error {
    Error::new(
        ErrorKind::Security,
        format!(
            "{}; spawned action cleanup could not be proven complete",
            original_error.message()
        ),
    )
    .requiring_process_exit()
}

fn uncertain_poll_cleanup(original_error: &Error, cleanup_error: Option<&Error>) -> Error {
    let cleanup_detail = cleanup_error
        .map(|error| format!("; cleanup error: {}", error.message()))
        .unwrap_or_default();
    Error::new(
        ErrorKind::Security,
        format!(
            "{}; action cleanup after a poll error could not be proven complete{}",
            original_error.message(),
            cleanup_detail
        ),
    )
    .requiring_process_exit()
}

fn verify_artifact(config: &Config) -> Result<()> {
    if let Some(expected) = &config.executable_sha256 {
        let actual = sha256::digest_file(&config.executable, MAX_ARTIFACT_BYTES)?;
        if !constant_time_equal(actual.as_bytes(), expected.as_bytes()) {
            return Err(Error::new(
                ErrorKind::Security,
                "configured executable SHA-256 does not match",
            ));
        }
    }
    Ok(())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (&a, &b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

fn send_group(pgid: i32, signal: i32) -> Result<bool> {
    security::validate_signal_group(pgid)?;
    match security::send_signal(-pgid, signal) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(3) => Ok(false), // ESRCH
        Err(error) => Err(Error::io(
            ErrorKind::Process,
            "cannot signal action process group",
            error,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison_handles_mismatch() {
        assert!(constant_time_equal(b"abc", b"abc"));
        assert!(!constant_time_equal(b"abc", b"abd"));
        assert!(!constant_time_equal(b"abc", b"ab"));
    }

    #[test]
    fn oversized_public_grace_is_an_error_instead_of_a_clock_panic() {
        let error = checked_deadline(Duration::MAX).expect_err("duration must be rejected");
        assert_eq!(error.kind(), ErrorKind::Process);
    }

    #[test]
    fn failed_spawn_cleanup_proves_a_dedicated_group_before_returning() {
        let mut child = Command::new("/usr/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn dedicated cleanup fixture");
        let group = i32::try_from(child.id()).expect("fixture PID fits i32");
        let error = cleanup_failed_spawn(
            &mut child,
            Some(group),
            false,
            Error::new(ErrorKind::Process, "simulated validation failure"),
        );

        assert!(!error.requires_process_exit());
        assert_eq!(error.kind(), ErrorKind::Process);
        assert!(!security::process_group_exists(group).expect("inspect cleaned group"));
    }

    #[test]
    fn failed_spawn_cleanup_is_terminal_without_group_ownership_proof() {
        let mut child = Command::new("/usr/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn non-dedicated cleanup fixture");
        let unowned_group = i32::try_from(child.id()).expect("fixture PID fits i32");
        let error = cleanup_failed_spawn(
            &mut child,
            Some(unowned_group),
            false,
            Error::new(ErrorKind::Security, "simulated group mismatch"),
        );

        assert!(error.requires_process_exit());
        assert_eq!(error.kind(), ErrorKind::Security);
        assert!(child.try_wait().expect("inspect fixture").is_some());
    }

    #[test]
    fn poll_error_returns_only_after_proving_the_action_group_empty() {
        let child = Command::new("/usr/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn poll cleanup fixture");
        let pid = child.id();
        let group = i32::try_from(pid).expect("fixture PID fits i32");
        let leader_handle = security::ProcessHandle::open(pid)
            .expect("open fixture pidfd")
            .expect("live fixture pidfd");
        let mut action = ActionProcess {
            child,
            leader_handle,
            pid,
            pgid: group,
            start_ticks: None,
            started: Instant::now(),
            active: true,
        };

        let error = action
            .poll(Duration::MAX)
            .expect_err("oversized deadline must make polling fail");

        assert_eq!(error.kind(), ErrorKind::Process);
        assert!(!error.requires_process_exit());
        assert!(!action.active);
        assert!(!security::process_group_exists(group).expect("inspect cleaned action group"));
    }

    #[test]
    fn stop_preserves_a_success_observed_before_any_signal() {
        let child = Command::new("/usr/bin/true")
            .process_group(0)
            .spawn()
            .expect("spawn natural-exit fixture");
        let pid = child.id();
        let group = i32::try_from(pid).expect("fixture PID fits i32");
        let leader_handle = security::ProcessHandle::open(pid)
            .expect("open fixture pidfd")
            .expect("waitable fixture pidfd");
        let mut action = ActionProcess {
            child,
            leader_handle,
            pid,
            pgid: group,
            start_ticks: None,
            started: Instant::now(),
            active: true,
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while !action
            .leader_handle
            .has_exited()
            .expect("observe natural exit")
        {
            assert!(
                Instant::now() < deadline,
                "natural-exit fixture stayed live"
            );
            thread::sleep(Duration::from_millis(5));
        }

        let stop = action
            .stop(Duration::ZERO)
            .expect("collect natural exit without signalling");

        assert!(!stop.term_sent);
        assert!(!stop.kill_sent);
        assert!(stop.group_empty);
        assert_eq!(stop.exit_timing, StopExitTiming::BeforeSignal);
        assert_eq!(
            stop.leader_exit,
            Some(ActionExit {
                code: Some(0),
                signal: None,
                success: true,
            })
        );
    }

    #[test]
    fn poll_error_requires_process_exit_when_cleanup_identity_is_uncertain() {
        let child = Command::new("/usr/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn uncertain poll cleanup fixture");
        let pid = child.id();
        let owned_group = i32::try_from(pid).expect("fixture PID fits i32");
        let leader_handle = security::ProcessHandle::open(pid)
            .expect("open fixture pidfd")
            .expect("live fixture pidfd");
        let mut action = ActionProcess {
            child,
            leader_handle,
            pid,
            pgid: owned_group.saturating_add(1),
            start_ticks: None,
            started: Instant::now(),
            active: true,
        };

        let error = action
            .poll(Duration::MAX)
            .expect_err("uncertain cleanup must fail closed");

        assert_eq!(error.kind(), ErrorKind::Security);
        assert!(error.requires_process_exit());
        assert!(error.to_string().contains("could not be proven complete"));

        // The test process cannot honor the production exit requirement, so
        // restore the known identity and prove cleanup before returning.
        action.pgid = owned_group;
        let stop = action
            .stop(Duration::from_secs(1))
            .expect("clean up terminal poll fixture");
        assert!(stop.group_empty);
    }
}
