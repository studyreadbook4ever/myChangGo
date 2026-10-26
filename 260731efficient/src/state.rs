#![allow(unsafe_code, reason = "small audited Linux flock adapter")]

use crate::error::{Error, ErrorKind, Result};
use crate::security;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_STATE_BYTES: u64 = 64 * 1024;
const LOCK_EX: i32 = 2;
const LOCK_NB: i32 = 4;
const LOCK_UN: i32 = 8;
const O_NOFOLLOW: i32 = 0o400_000;
const O_NONBLOCK: i32 = 0o4_000;
const STATE_KEYS: [&str; 16] = [
    "schema_version",
    "config_fingerprint",
    "daemon_pid",
    "daemon_start_ticks",
    "phase",
    "window_key",
    "completed_window",
    "attempt_window",
    "attempts",
    "action_pid",
    "action_pgid",
    "action_start_ticks",
    "last_reason",
    "last_exit_code",
    "last_exit_signal",
    "updated_unix_seconds",
];
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

unsafe extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

/// Persisted supervisor phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// No daemon owns the state.
    Stopped,
    /// Waiting for conditions.
    Waiting,
    /// Conditions are being stabilized/rechecked.
    Qualifying,
    /// The action is live.
    Running,
    /// The action is being terminated.
    Stopping,
    /// A successful or terminal attempt completed this window.
    Completed,
    /// A fail-closed invariant prevented progress.
    Fault,
}

impl Phase {
    /// Stable machine representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Waiting => "waiting",
            Self::Qualifying => "qualifying",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Completed => "completed",
            Self::Fault => "fault",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "stopped" => Ok(Self::Stopped),
            "waiting" => Ok(Self::Waiting),
            "qualifying" => Ok(Self::Qualifying),
            "running" => Ok(Self::Running),
            "stopping" => Ok(Self::Stopping),
            "completed" => Ok(Self::Completed),
            "fault" => Ok(Self::Fault),
            _ => Err(Error::new(ErrorKind::State, "invalid persisted phase")),
        }
    }
}

/// Durable state and live status shared with read-only agent commands.
#[derive(Debug, Clone)]
pub struct PersistentState {
    /// State schema.
    pub schema_version: u32,
    /// SHA-256 binding to canonical non-comment configuration lines.
    pub config_fingerprint: Option<String>,
    /// Daemon PID.
    pub daemon_pid: Option<u32>,
    /// Daemon `/proc` start ticks.
    pub daemon_start_ticks: Option<u64>,
    /// Current state.
    pub phase: Phase,
    /// Current local window key.
    pub window_key: Option<String>,
    /// Window that has been terminally completed.
    pub completed_window: Option<String>,
    /// Window for which attempts are counted.
    pub attempt_window: Option<String>,
    /// Attempts in `attempt_window`.
    pub attempts: u32,
    /// Live action leader.
    pub action_pid: Option<u32>,
    /// Live action process group.
    pub action_pgid: Option<i32>,
    /// Live action leader `/proc` start ticks.
    pub action_start_ticks: Option<u64>,
    /// First/last stable reason code.
    pub last_reason: Option<String>,
    /// Last conventional action exit code.
    pub last_exit_code: Option<i32>,
    /// Last terminating action signal.
    pub last_exit_signal: Option<i32>,
    /// State write timestamp.
    pub updated_unix_seconds: u64,
}

impl Default for PersistentState {
    fn default() -> Self {
        Self {
            schema_version: 2,
            config_fingerprint: None,
            daemon_pid: None,
            daemon_start_ticks: None,
            phase: Phase::Stopped,
            window_key: None,
            completed_window: None,
            attempt_window: None,
            attempts: 0,
            action_pid: None,
            action_pgid: None,
            action_start_ticks: None,
            last_reason: None,
            last_exit_code: None,
            last_exit_signal: None,
            updated_unix_seconds: 0,
        }
    }
}

impl PersistentState {
    /// Verify that persisted state belongs to the supplied configuration.
    /// Missing binding is accepted only for a state file that has never been
    /// initialized by a supervisor.
    pub fn verify_config_fingerprint(&self, expected: &str) -> Result<()> {
        self.validate_semantics()?;
        validate_config_fingerprint(expected)?;
        match self.config_fingerprint.as_deref() {
            Some(actual) if actual == expected => Ok(()),
            Some(_) => Err(Error::new(
                ErrorKind::Security,
                "state file belongs to a different configuration",
            )),
            None if self.is_pristine() => Ok(()),
            None => Err(Error::new(
                ErrorKind::Security,
                "initialized state is missing its configuration binding",
            )),
        }
    }

    /// Bind a pristine state to one configuration, or verify an existing
    /// binding. The caller persists the state at its normal durable boundary.
    pub fn bind_config_fingerprint(&mut self, expected: &str) -> Result<()> {
        self.verify_config_fingerprint(expected)?;
        if self.config_fingerprint.is_none() {
            self.config_fingerprint = Some(expected.to_owned());
        }
        Ok(())
    }

    /// Whether a previous daemon stopped in the ambiguous interval after a
    /// durable launch intent but before a durable action identity or normal
    /// final state. A new supervisor must not guess that no exec occurred.
    #[must_use]
    pub fn has_unresolved_launch_intent(&self) -> bool {
        self.action_pid.is_none()
            && self.phase == Phase::Qualifying
            && self.last_reason.as_deref() == Some("launch_intent_persisted")
            && self.daemon_pid.is_some()
    }

    /// Load or return an empty state if the file does not exist.
    pub fn load(path: &Path) -> Result<Self> {
        Self::load_impl(path, true)
    }

    /// Load state for a status or stop operation without rejecting the brief
    /// interval in which the owning daemon has not yet reaped an exited action.
    ///
    /// Control callers must still verify the daemon PID and start ticks before
    /// signaling it. Supervisor startup should use [`Self::load`] so an
    /// orphaned action process group continues to fail closed.
    pub fn load_for_control(path: &Path) -> Result<Self> {
        Self::load_impl(path, false)
    }

    fn load_impl(path: &Path, reject_orphaned_action_group: bool) -> Result<Self> {
        security::validate_state_parent(path)?;
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(O_NOFOLLOW | O_NONBLOCK)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => {
                return Err(Error::io(
                    ErrorKind::State,
                    "cannot inspect state file",
                    error,
                ));
            }
        };
        let metadata = file
            .metadata()
            .map_err(|error| Error::io(ErrorKind::State, "cannot inspect state file", error))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != security::current_euid()
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
            || metadata.len() > MAX_STATE_BYTES
        {
            return Err(Error::new(
                ErrorKind::Security,
                "state file ownership, mode, link count, type, or size is unsafe",
            ));
        }
        let capacity = usize::try_from(metadata.len()).map_err(|_| {
            Error::new(
                ErrorKind::Security,
                "state file size cannot be represented on this target",
            )
        })?;
        let mut bytes = Vec::with_capacity(capacity);
        file.take(MAX_STATE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| Error::io(ErrorKind::State, "cannot read state file", error))?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(Error::new(
                ErrorKind::Security,
                "state file grew beyond its size limit while being read",
            ));
        }
        let input = std::str::from_utf8(&bytes)
            .map_err(|_| Error::new(ErrorKind::State, "state file must be UTF-8"))?;
        let state = Self::parse(input)?;
        if reject_orphaned_action_group {
            state.reject_orphaned_action_group()?;
        }
        Ok(state)
    }

    /// Atomically persist state with mode 0600.
    pub fn store(&mut self, path: &Path) -> Result<()> {
        security::ensure_state_parent(path)?;
        validate_existing_state_file(path)?;
        self.updated_unix_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.validate_semantics()?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::new(ErrorKind::State, "state path has no parent"))?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::new(ErrorKind::State, "state filename must be UTF-8"))?;
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(".{name}.tmp.{}.{}", std::process::id(), sequence));
        let contents = self.serialize();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(O_NOFOLLOW | O_NONBLOCK)
            .open(&temporary)
            .map_err(|error| Error::io(ErrorKind::State, "cannot create state temp file", error))?;
        let result = (|| {
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| Error::io(ErrorKind::State, "cannot secure state", error))?;
            file.write_all(contents.as_bytes())
                .map_err(|error| Error::io(ErrorKind::State, "cannot write state", error))?;
            file.sync_all()
                .map_err(|error| Error::io(ErrorKind::State, "cannot sync state", error))?;
            fs::rename(&temporary, path)
                .map_err(|error| Error::io(ErrorKind::State, "cannot commit state", error))?;
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| Error::io(ErrorKind::State, "cannot sync state directory", error))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn serialize(&self) -> String {
        let mut output = String::new();
        push(&mut output, "schema_version", self.schema_version);
        push_option_string(
            &mut output,
            "config_fingerprint",
            self.config_fingerprint.as_deref(),
        );
        push_option(&mut output, "daemon_pid", self.daemon_pid);
        push_option(&mut output, "daemon_start_ticks", self.daemon_start_ticks);
        push(&mut output, "phase", self.phase.as_str());
        push_option_string(&mut output, "window_key", self.window_key.as_deref());
        push_option_string(
            &mut output,
            "completed_window",
            self.completed_window.as_deref(),
        );
        push_option_string(
            &mut output,
            "attempt_window",
            self.attempt_window.as_deref(),
        );
        push(&mut output, "attempts", self.attempts);
        push_option(&mut output, "action_pid", self.action_pid);
        push_option(&mut output, "action_pgid", self.action_pgid);
        push_option(&mut output, "action_start_ticks", self.action_start_ticks);
        push_option_string(&mut output, "last_reason", self.last_reason.as_deref());
        push_option(&mut output, "last_exit_code", self.last_exit_code);
        push_option(&mut output, "last_exit_signal", self.last_exit_signal);
        push(
            &mut output,
            "updated_unix_seconds",
            self.updated_unix_seconds,
        );
        output
    }

    fn parse(input: &str) -> Result<Self> {
        let mut state = Self::default();
        let mut seen = std::collections::BTreeSet::new();
        for line in input.lines() {
            if line.is_empty() {
                return Err(Error::new(ErrorKind::State, "empty state line"));
            }
            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| Error::new(ErrorKind::State, "malformed state line"))?;
            if !seen.insert(key) {
                return Err(Error::new(ErrorKind::State, "duplicate state key"));
            }
            match key {
                "schema_version" => state.schema_version = parse(value)?,
                "config_fingerprint" => {
                    state.config_fingerprint = parse_option_string(value)?;
                }
                "daemon_pid" => state.daemon_pid = parse_option(value)?,
                "daemon_start_ticks" => state.daemon_start_ticks = parse_option(value)?,
                "phase" => state.phase = Phase::parse(value)?,
                "window_key" => state.window_key = parse_option_string(value)?,
                "completed_window" => state.completed_window = parse_option_string(value)?,
                "attempt_window" => state.attempt_window = parse_option_string(value)?,
                "attempts" => state.attempts = parse(value)?,
                "action_pid" => state.action_pid = parse_option(value)?,
                "action_pgid" => state.action_pgid = parse_option(value)?,
                "action_start_ticks" => state.action_start_ticks = parse_option(value)?,
                "last_reason" => state.last_reason = parse_option_string(value)?,
                "last_exit_code" => state.last_exit_code = parse_option(value)?,
                "last_exit_signal" => state.last_exit_signal = parse_option(value)?,
                "updated_unix_seconds" => state.updated_unix_seconds = parse(value)?,
                _ => return Err(Error::new(ErrorKind::State, "unknown state key")),
            }
        }
        if state.schema_version != 2 {
            return Err(Error::new(ErrorKind::State, "unsupported state schema"));
        }
        if seen.len() != STATE_KEYS.len() || STATE_KEYS.iter().any(|key| !seen.contains(key)) {
            return Err(Error::new(
                ErrorKind::State,
                "state file does not contain the complete schema",
            ));
        }
        state.validate_semantics()?;
        if state.serialize() != input {
            return Err(Error::new(
                ErrorKind::State,
                "state file is not in canonical form",
            ));
        }
        Ok(state)
    }

    fn validate_semantics(&self) -> Result<()> {
        if self.schema_version != 2 {
            return Err(Error::new(ErrorKind::State, "unsupported state schema"));
        }
        if let Some(fingerprint) = self.config_fingerprint.as_deref() {
            validate_config_fingerprint(fingerprint)?;
        }
        validate_pid_pair("daemon", self.daemon_pid, self.daemon_start_ticks)?;
        match (self.action_pid, self.action_pgid, self.action_start_ticks) {
            (None, None, None) => {}
            (Some(process_id), Some(action_group), Some(ticks)) => {
                let expected = i32::try_from(process_id)
                    .map_err(|_| Error::new(ErrorKind::Security, "action PID does not fit i32"))?;
                if expected <= 1 || action_group != expected || ticks == 0 {
                    return Err(Error::new(
                        ErrorKind::Security,
                        "persisted action PID, PGID, or start time is unsafe",
                    ));
                }
                security::validate_signal_group(action_group)?;
            }
            _ => {
                return Err(Error::new(
                    ErrorKind::Security,
                    "persisted action identity must be complete",
                ));
            }
        }
        if matches!(self.phase, Phase::Running | Phase::Stopping) && self.action_pid.is_none() {
            return Err(Error::new(
                ErrorKind::State,
                "running or stopping state requires an action identity",
            ));
        }
        if self.attempts > 0 && self.attempt_window.is_none() {
            return Err(Error::new(
                ErrorKind::State,
                "nonzero attempts require an attempt window",
            ));
        }
        for value in [
            self.window_key.as_deref(),
            self.completed_window.as_deref(),
            self.attempt_window.as_deref(),
            self.last_reason.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            validate_state_string(value)?;
        }
        if self
            .last_exit_code
            .is_some_and(|code| !(0..=255).contains(&code))
        {
            return Err(Error::new(ErrorKind::State, "invalid action exit code"));
        }
        if self
            .last_exit_signal
            .is_some_and(|signal| !(1..=64).contains(&signal))
        {
            return Err(Error::new(ErrorKind::State, "invalid action exit signal"));
        }
        if self.last_exit_code.is_some() && self.last_exit_signal.is_some() {
            return Err(Error::new(
                ErrorKind::State,
                "action exit code and signal are mutually exclusive",
            ));
        }
        Ok(())
    }

    fn is_pristine(&self) -> bool {
        self.daemon_pid.is_none()
            && self.daemon_start_ticks.is_none()
            && self.phase == Phase::Stopped
            && self.window_key.is_none()
            && self.completed_window.is_none()
            && self.attempt_window.is_none()
            && self.attempts == 0
            && self.action_pid.is_none()
            && self.action_pgid.is_none()
            && self.action_start_ticks.is_none()
            && self.last_reason.is_none()
            && self.last_exit_code.is_none()
            && self.last_exit_signal.is_none()
    }

    fn reject_orphaned_action_group(&self) -> Result<()> {
        let (Some(process_id), Some(action_group), Some(_)) =
            (self.action_pid, self.action_pgid, self.action_start_ticks)
        else {
            return Ok(());
        };
        if security::inspect_process_start_ticks(process_id, Path::new("/proc"))?.is_none()
            && security::process_group_exists(action_group)?
        {
            return Err(Error::new(
                ErrorKind::Security,
                "action leader is gone but its persisted process group still has descendants",
            ));
        }
        Ok(())
    }
}

/// Held for the lifetime of one daemon to reject duplicate instances.
pub struct StateLock {
    file: File,
    path: PathBuf,
}

impl StateLock {
    /// Acquire an exclusive, non-blocking lock adjacent to the state file.
    pub fn acquire(state_file: &Path) -> Result<Self> {
        security::ensure_state_parent(state_file)?;
        let mut lock_path = state_file.as_os_str().to_os_string();
        lock_path.push(".lock");
        let path = PathBuf::from(lock_path);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(O_NOFOLLOW | O_NONBLOCK)
            .open(&path)
            .map_err(|error| Error::io(ErrorKind::State, "cannot open daemon lock", error))?;
        let metadata = file
            .metadata()
            .map_err(|error| Error::io(ErrorKind::State, "cannot inspect daemon lock", error))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != security::current_euid()
            || metadata.permissions().mode() & 0o777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(Error::new(
                ErrorKind::Security,
                "daemon lock has unsafe owner or mode",
            ));
        }
        // SAFETY: flock operates on the valid open file descriptor.
        if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } != 0 {
            return Err(Error::io(
                ErrorKind::State,
                "another idlepilot daemon owns this state",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(Self { file, path })
    }

    /// Lock path for diagnostics.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_existing_state_file(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(Error::io(
                ErrorKind::State,
                "cannot inspect existing state destination",
                error,
            ));
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.uid() != security::current_euid()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.len() > MAX_STATE_BYTES
    {
        return Err(Error::new(
            ErrorKind::Security,
            "refusing to replace an unsafe state destination",
        ));
    }
    Ok(())
}

fn validate_pid_pair(label: &str, pid: Option<u32>, ticks: Option<u64>) -> Result<()> {
    match (pid, ticks) {
        (None, None) => Ok(()),
        (Some(pid), Some(ticks)) if pid > 1 && i32::try_from(pid).is_ok() && ticks > 0 => Ok(()),
        _ => Err(Error::new(
            ErrorKind::Security,
            format!("persisted {label} process identity is incomplete or unsafe"),
        )),
    }
}

fn validate_state_string(value: &str) -> Result<()> {
    if value == "-"
        || value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || character == '=')
    {
        return Err(Error::new(ErrorKind::State, "unsafe state string"));
    }
    Ok(())
}

fn validate_config_fingerprint(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(Error::new(
            ErrorKind::State,
            "invalid configuration fingerprint",
        ));
    }
    Ok(())
}

impl Drop for StateLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor remains valid until `file` is dropped.
        let _ = unsafe { flock(self.file.as_raw_fd(), LOCK_UN) };
    }
}

fn push(output: &mut String, key: &str, value: impl std::fmt::Display) {
    use std::fmt::Write;
    let _ = writeln!(output, "{key}={value}");
}

fn push_option(output: &mut String, key: &str, value: Option<impl std::fmt::Display>) {
    match value {
        Some(value) => push(output, key, value),
        None => push(output, key, "-"),
    }
}

fn push_option_string(output: &mut String, key: &str, value: Option<&str>) {
    match value {
        Some(value) => push(output, key, value),
        None => push(output, key, "-"),
    }
}

fn parse<T: std::str::FromStr>(value: &str) -> Result<T> {
    value
        .parse()
        .map_err(|_| Error::new(ErrorKind::State, "invalid state value"))
}

fn parse_option<T: std::str::FromStr>(value: &str) -> Result<Option<T>> {
    if value == "-" {
        Ok(None)
    } else {
        parse(value).map(Some)
    }
}

fn parse_option_string(value: &str) -> Result<Option<String>> {
    if value == "-" {
        return Ok(None);
    }
    validate_state_string(value)?;
    Ok(Some(value.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    fn test_state_path(label: &str) -> PathBuf {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::current_dir()
            .expect("current test directory")
            .join("target")
            .join(format!(
                "idlepilot-state-{label}-{}-{sequence}",
                std::process::id()
            ))
            .join("state")
    }

    #[test]
    fn parser_requires_complete_canonical_state() {
        let canonical = PersistentState::default().serialize();
        assert!(PersistentState::parse(&canonical).is_ok());

        let missing = canonical.replacen("attempts=0\n", "", 1);
        assert!(PersistentState::parse(&missing).is_err());

        let noncanonical = canonical.replacen("attempts=0\n", "attempts=00\n", 1);
        assert!(PersistentState::parse(&noncanonical).is_err());

        let missing_attempt_window = canonical.replacen("attempts=0\n", "attempts=1\n", 1);
        assert!(PersistentState::parse(&missing_attempt_window).is_err());
    }

    #[test]
    fn semantic_validation_rejects_impossible_attempt_and_exit_relations() {
        let attempts_without_window = PersistentState {
            attempts: 1,
            ..PersistentState::default()
        };
        assert!(attempts_without_window.validate_semantics().is_err());
        assert!(
            attempts_without_window
                .verify_config_fingerprint(&"0".repeat(64))
                .is_err()
        );

        let conflicting_exit = PersistentState {
            last_exit_code: Some(1),
            last_exit_signal: Some(9),
            ..PersistentState::default()
        };
        assert!(conflicting_exit.validate_semantics().is_err());
    }

    #[test]
    fn persisted_process_identities_must_be_complete() {
        let mut state = PersistentState {
            action_pid: Some(42),
            ..PersistentState::default()
        };
        assert!(state.validate_semantics().is_err());

        state.action_pgid = Some(43);
        state.action_start_ticks = Some(1);
        assert!(state.validate_semantics().is_err());

        let daemon = PersistentState {
            daemon_pid: Some(42),
            ..PersistentState::default()
        };
        assert!(daemon.validate_semantics().is_err());
    }

    #[test]
    fn state_store_is_mode_0600_and_round_trips() {
        let path = test_state_path("round-trip");
        let mut state = PersistentState::default();
        state.store(&path).expect("store state");
        let metadata = fs::symlink_metadata(&path).expect("state metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let loaded = PersistentState::load(&path).expect("load state");
        assert_eq!(loaded.phase, Phase::Stopped);
        fs::remove_dir_all(path.parent().expect("state parent")).expect("remove test state");
    }

    #[test]
    fn state_load_rejects_final_symlink() {
        let path = test_state_path("symlink");
        security::ensure_state_parent(&path).expect("create private parent");
        symlink("missing-target", &path).expect("create state symlink");
        assert!(PersistentState::load(&path).is_err());
        fs::remove_dir_all(path.parent().expect("state parent")).expect("remove test state");
    }

    #[test]
    fn control_load_allows_a_transient_unreaped_action_leader() {
        let path = test_state_path("control-zombie");
        let mut child = Command::new("/usr/bin/true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("spawn short-lived action");
        let pid = child.id();
        let ticks = security::process_start_ticks_including_zombie(pid, Path::new("/proc"))
            .expect("capture action identity");
        let action_group = i32::try_from(pid).expect("test PID fits i32");

        let deadline = Instant::now() + Duration::from_secs(2);
        while security::process_start_ticks(pid, Path::new("/proc")).is_ok() {
            assert!(Instant::now() < deadline, "action did not become a zombie");
            thread::sleep(Duration::from_millis(5));
        }

        let mut state = PersistentState {
            phase: Phase::Running,
            action_pid: Some(pid),
            action_pgid: Some(action_group),
            action_start_ticks: Some(ticks),
            ..PersistentState::default()
        };
        state.store(&path).expect("store transient running state");
        let strict_result = PersistentState::load(&path);
        let control_result = PersistentState::load_for_control(&path);

        child.wait().expect("reap short-lived action");
        assert!(
            strict_result.is_err(),
            "supervisor startup must reject a populated orphan group"
        );
        assert!(
            control_result.is_ok(),
            "status and stop must remain available during the reap race"
        );
        fs::remove_dir_all(path.parent().expect("state parent")).expect("remove test state");
    }
}
