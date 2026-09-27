//! Small, audited Linux security helpers.

#![allow(
    unsafe_code,
    reason = "small audited Linux identity, signal, and process-group adapter"
)]

use crate::error::{Error, ErrorKind, Result};
use std::ffi::c_void;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::raw::{c_int, c_long};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};

type SignalHandler = extern "C" fn(c_int);

unsafe extern "C" {
    fn getuid() -> u32;
    fn geteuid() -> u32;
    fn getpgrp() -> i32;
    fn getpgid(pid: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn poll(descriptors: *mut PollDescriptor, count: usize, timeout_milliseconds: c_int) -> c_int;
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    fn syscall(number: c_long, ...) -> c_long;
    // The raw-word return type deliberately accommodates SIG_ERR, which is
    // `(sighandler_t)-1` and therefore cannot be represented by a Rust function
    // pointer. Function-pointer arguments have their actual C ABI type.
    fn signal(signal: c_int, handler: SignalHandler) -> usize;
}

/// SIGTERM on Linux/POSIX.
pub const SIGTERM: i32 = 15;
/// SIGKILL on Linux/POSIX.
pub const SIGKILL: i32 = 9;
/// SIGINT on Linux/POSIX.
pub const SIGINT: i32 = 2;
/// Signal number used only to test process existence.
pub const SIGNAL_NONE: i32 = 0;
const SIGNAL_ERROR: usize = usize::MAX;
const O_NOFOLLOW: i32 = 0o400_000;
const O_NONBLOCK: i32 = 0o4_000;
const ESRCH: i32 = 3;
const EINTR: i32 = 4;
const ENOSYS: i32 = 38;
const POLLIN: i16 = 0x001;
const POLLERR: i16 = 0x008;
const POLLHUP: i16 = 0x010;
const POLLNVAL: i16 = 0x020;
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const SYS_PIDFD_SEND_SIGNAL: c_long = 424;
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const SYS_PIDFD_OPEN: c_long = 434;
static REQUESTED_SIGNAL: AtomicI32 = AtomicI32::new(0);

#[repr(C)]
struct PollDescriptor {
    descriptor: c_int,
    events: i16,
    returned_events: i16,
}

extern "C" fn record_signal(signal: i32) {
    let _ = REQUESTED_SIGNAL.compare_exchange(0, signal, Ordering::SeqCst, Ordering::Relaxed);
}

/// Real user ID.
#[must_use]
pub fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and no side effects visible to Rust.
    unsafe { getuid() }
}

/// Effective user ID.
#[must_use]
pub fn current_euid() -> u32 {
    // SAFETY: geteuid has no preconditions and no side effects visible to Rust.
    unsafe { geteuid() }
}

/// Current process group ID.
#[must_use]
pub fn current_process_group() -> i32 {
    // SAFETY: getpgrp has no preconditions.
    unsafe { getpgrp() }
}

/// Refuse root and setuid execution.
pub fn require_unprivileged_user() -> Result<()> {
    let uid = current_uid();
    let euid = current_euid();
    if euid == 0 {
        return Err(Error::new(
            ErrorKind::Security,
            "idlepilot refuses to run as root; use a systemd user service",
        ));
    }
    if uid != euid {
        return Err(Error::new(
            ErrorKind::Security,
            "setuid/seteuid execution is not supported",
        ));
    }
    Ok(())
}

/// Install minimal SIGINT/SIGTERM handlers for the CLI process.
pub fn install_termination_handlers() -> Result<()> {
    REQUESTED_SIGNAL.store(0, Ordering::SeqCst);
    // SAFETY: `record_signal` has C ABI, does not allocate, and only stores to
    // a lock-free atomic on the supported 64-bit Linux targets.
    let old_int = unsafe { signal(SIGINT, record_signal) };
    // SAFETY: same reasoning as above.
    let old_term = unsafe { signal(SIGTERM, record_signal) };
    if old_int == SIGNAL_ERROR || old_term == SIGNAL_ERROR {
        return Err(Error::io(
            ErrorKind::Os,
            "cannot install termination signal handlers",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

/// First requested termination signal, if any.
#[must_use]
pub fn requested_termination_signal() -> Option<i32> {
    match REQUESTED_SIGNAL.load(Ordering::SeqCst) {
        0 => None,
        signal => Some(signal),
    }
}

/// Stable kernel reference to one process, immune to numeric PID reuse.
///
/// Opening or signalling fails closed when pidfds are unavailable. This
/// avoids falling back to a check-then-`kill(2)` sequence that could target a
/// different process after PID reuse.
pub struct ProcessHandle {
    descriptor: OwnedFd,
}

impl ProcessHandle {
    /// Open a pidfd for a positive, non-special process ID.
    ///
    /// `Ok(None)` means the numeric PID no longer existed at the atomic open.
    pub fn open(process_id: u32) -> Result<Option<Self>> {
        let linux_pid = i32::try_from(process_id)
            .map_err(|_| Error::new(ErrorKind::Security, "process PID does not fit i32"))?;
        if linux_pid <= 1 {
            return Err(Error::new(
                ErrorKind::Security,
                "refusing unsafe process PID for pidfd",
            ));
        }

        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        {
            // SAFETY: pidfd_open accepts a validated positive PID and flags=0.
            // On success the returned descriptor is uniquely owned here.
            let raw = unsafe { syscall(SYS_PIDFD_OPEN, linux_pid, 0u32) };
            if raw < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(ESRCH) {
                    return Ok(None);
                }
                let kind = if error.raw_os_error() == Some(ENOSYS) {
                    ErrorKind::Security
                } else {
                    ErrorKind::Process
                };
                return Err(Error::io(
                    kind,
                    "cannot open pidfd; refusing race-prone process control",
                    error,
                ));
            }
            let descriptor = i32::try_from(raw).map_err(|_| {
                Error::new(
                    ErrorKind::Internal,
                    "pidfd descriptor does not fit the platform descriptor type",
                )
            })?;
            // SAFETY: the successful syscall returned a new owned descriptor.
            Ok(Some(Self {
                descriptor: unsafe { OwnedFd::from_raw_fd(descriptor) },
            }))
        }

        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            let _ = linux_pid;
            Err(Error::new(
                ErrorKind::Security,
                "pidfd process control is unsupported on this architecture",
            ))
        }
    }

    /// Signal exactly the process referenced by this pidfd.
    ///
    /// Returns `false` on `ESRCH`, when the kernel no longer has that process.
    /// An exited but unreaped zombie may still return `true`; use
    /// [`Self::has_exited`] to classify exit. Signal zero only checks liveness
    /// and does not deliver a signal.
    pub fn signal(&self, signal: i32) -> Result<bool> {
        if !(0..=64).contains(&signal) {
            return Err(Error::new(
                ErrorKind::Security,
                "invalid signal for pidfd process control",
            ));
        }

        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        {
            // SAFETY: the descriptor is a live owned pidfd, the signal is in
            // the Linux range, siginfo is null, and flags are zero.
            let result = unsafe {
                syscall(
                    SYS_PIDFD_SEND_SIGNAL,
                    self.descriptor.as_raw_fd(),
                    signal,
                    std::ptr::null::<c_void>(),
                    0u32,
                )
            };
            if result == 0 {
                return Ok(true);
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ESRCH) {
                return Ok(false);
            }
            Err(Error::io(
                ErrorKind::Process,
                "cannot signal process through pidfd",
                error,
            ))
        }

        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            let _ = signal;
            Err(Error::new(
                ErrorKind::Security,
                "pidfd process control is unsupported on this architecture",
            ))
        }
    }

    /// Test whether the referenced process has exited, including an unreaped
    /// zombie owned by another process.
    pub fn has_exited(&self) -> Result<bool> {
        let mut descriptor = PollDescriptor {
            descriptor: self.descriptor.as_raw_fd(),
            events: POLLIN,
            returned_events: 0,
        };
        loop {
            // SAFETY: `descriptor` points to one initialized pollfd-compatible
            // value for the duration of this nonblocking poll call.
            let result = unsafe { poll(&raw mut descriptor, 1, 0) };
            if result == 0 {
                return Ok(false);
            }
            if result > 0 {
                if descriptor.returned_events & POLLNVAL != 0 {
                    return Err(Error::new(
                        ErrorKind::Internal,
                        "kernel rejected an owned pidfd during poll",
                    ));
                }
                return Ok(descriptor.returned_events & (POLLIN | POLLERR | POLLHUP) != 0);
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(EINTR) {
                continue;
            }
            return Err(Error::io(
                ErrorKind::Process,
                "cannot poll pidfd process state",
                error,
            ));
        }
    }
}

/// Verify pidfd support before a reviewed action can be launched.
pub(crate) fn require_process_handle_support() -> Result<()> {
    let handle = ProcessHandle::open(std::process::id())?.ok_or_else(|| {
        Error::new(
            ErrorKind::Security,
            "current process disappeared during pidfd capability preflight",
        )
    })?;
    if handle.has_exited()? {
        return Err(Error::new(
            ErrorKind::Internal,
            "current process pidfd unexpectedly reports an exited process",
        ));
    }
    Ok(())
}

/// Send a signal to one process. A negative PID targets a process group.
pub fn send_signal(target: i32, signal: i32) -> std::io::Result<()> {
    if target == i32::MIN || target.abs_diff(0) <= 1 || !(0..=64).contains(&signal) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing unsafe process target or invalid Linux signal",
        ));
    }
    // SAFETY: kill accepts any pid/signal integers. We inspect errno on failure.
    let result = unsafe { kill(target, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Whether a process group currently contains at least one process.
pub fn process_group_exists(pgid: i32) -> Result<bool> {
    validate_signal_group(pgid)?;
    match send_signal(-pgid, SIGNAL_NONE) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(ESRCH) => Ok(false),
        Err(error) if error.raw_os_error() == Some(1) => Ok(true), // EPERM
        Err(error) => Err(Error::io(
            ErrorKind::Process,
            "cannot inspect process group",
            error,
        )),
    }
}

/// Return a live process's group, or `None` if the process no longer exists.
pub fn process_group_id(process_id: u32) -> Result<Option<i32>> {
    let linux_pid = i32::try_from(process_id)
        .map_err(|_| Error::new(ErrorKind::Security, "process PID does not fit i32"))?;
    if linux_pid <= 1 {
        return Err(Error::new(
            ErrorKind::Security,
            format!("refusing unsafe process PID {linux_pid}"),
        ));
    }
    // SAFETY: `linux_pid` is a positive, representable process identifier.
    let observed_group = unsafe { getpgid(linux_pid) };
    if observed_group >= 0 {
        Ok(Some(observed_group))
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ESRCH) {
            Ok(None)
        } else {
            Err(Error::io(
                ErrorKind::Process,
                "cannot inspect process group identity",
                error,
            ))
        }
    }
}

/// Whether `/proc` contains a process in `pgid` other than `leader_pid`.
///
/// This is used while the waitable leader is deliberately left unreaped. The
/// zombie leader keeps the numeric process-group identity reserved, allowing
/// descendants to be inspected and signalled without a PID/PGID reuse race.
pub(crate) fn process_group_has_other_members(
    pgid: i32,
    leader_pid: u32,
    proc_root: &Path,
) -> Result<bool> {
    validate_signal_group(pgid)?;
    let entries = fs::read_dir(proc_root).map_err(|error| {
        Error::io(
            ErrorKind::Process,
            "cannot enumerate processes for group cleanup",
            error,
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            Error::io(
                ErrorKind::Process,
                "cannot enumerate a process for group cleanup",
                error,
            )
        })?;
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if process_id == leader_pid {
            continue;
        }
        let stat = match fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(Error::io(
                    ErrorKind::Process,
                    "cannot inspect a process during group cleanup",
                    error,
                ));
            }
        };
        if process_group_from_stat(&stat)? == pgid {
            return Ok(true);
        }
    }
    Ok(false)
}

fn process_group_from_stat(stat: &str) -> Result<i32> {
    let close = stat
        .rfind(')')
        .ok_or_else(|| Error::new(ErrorKind::Process, "malformed /proc process identity"))?;
    let remaining = stat
        .get(close + 1..)
        .ok_or_else(|| Error::new(ErrorKind::Process, "malformed /proc process identity"))?;
    // Fields after the command name begin with state (3), parent PID (4), and
    // process group (5). rfind handles command names containing `)` safely.
    remaining
        .split_whitespace()
        .nth(2)
        .ok_or_else(|| Error::new(ErrorKind::Process, "process group field is missing"))?
        .parse()
        .map_err(|_| Error::new(ErrorKind::Process, "process group field is invalid"))
}

/// Ensure a process group is not the caller's group or a special group.
pub fn validate_signal_group(pgid: i32) -> Result<()> {
    if pgid <= 1 || pgid == current_process_group() {
        return Err(Error::new(
            ErrorKind::Security,
            format!("refusing unsafe process group {pgid}"),
        ));
    }
    Ok(())
}

/// Validate a configuration/manifest input before reading it.
pub fn validate_secure_input_file(path: &Path, maximum_size: u64) -> Result<()> {
    open_secure_input_file(path, maximum_size).map(drop)
}

/// Securely open a configuration or import source without following its final
/// path component. Callers that consume bytes should use this descriptor rather
/// than reopen the pathname after validation.
pub fn open_secure_input_file(path: &Path, maximum_size: u64) -> Result<File> {
    validate_absolute_components(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_NONBLOCK)
        .open(path)
        .map_err(|error| Error::io(ErrorKind::Security, "cannot open input file", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| Error::io(ErrorKind::Security, "cannot inspect input file", error))?;
    if !metadata.file_type().is_file() {
        return Err(Error::new(
            ErrorKind::Security,
            "input must be a regular non-symlink file",
        ));
    }
    validate_owner_and_mode(&metadata, false)?;
    if metadata.len() > maximum_size {
        return Err(Error::new(
            ErrorKind::Security,
            "input file exceeds the configured size limit",
        ));
    }
    Ok(file)
}

/// Validate the executable selected by a reviewed configuration.
pub fn validate_executable(path: &Path) -> Result<()> {
    validate_absolute_components(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| Error::io(ErrorKind::Security, "cannot inspect executable", error))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(Error::new(
            ErrorKind::Security,
            "executable must be a regular non-symlink file",
        ));
    }
    validate_owner_and_mode(&metadata, true)?;
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(Error::new(
            ErrorKind::Security,
            "configured executable has no execute bit",
        ));
    }
    Ok(())
}

/// Validate the working directory and all existing path components.
pub fn validate_working_directory(path: &Path) -> Result<()> {
    validate_absolute_components(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        Error::io(
            ErrorKind::Security,
            "cannot inspect working directory",
            error,
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(Error::new(
            ErrorKind::Security,
            "working_directory must be a non-symlink directory",
        ));
    }
    if metadata.permissions().mode() & 0o002 != 0 {
        return Err(Error::new(
            ErrorKind::Security,
            "working_directory must not be world-writable",
        ));
    }
    Ok(())
}

/// Validate an existing private state parent directory without modifying it.
pub fn validate_state_parent(state_file: &Path) -> Result<()> {
    validate_absolute_components(state_file)?;
    let parent = state_file
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::Security, "state_file has no parent directory"))?;
    validate_absolute_components(parent)?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| Error::io(ErrorKind::Security, "cannot inspect state directory", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::new(
            ErrorKind::Security,
            "state parent must be a non-symlink directory",
        ));
    }
    if metadata.uid() != current_euid() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(Error::new(
            ErrorKind::Security,
            "state directory must be owned by the caller and mode 0700",
        ));
    }
    Ok(())
}

/// Create missing private parent directories and validate the final parent.
///
/// This mutation is kept separate from [`validate_state_parent`] so status,
/// planning, and validation calls never create filesystem state implicitly.
pub fn ensure_state_parent(state_file: &Path) -> Result<()> {
    validate_absolute_components(state_file)?;
    let parent = state_file
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::Security, "state_file has no parent directory"))?;
    create_private_directory_chain(parent)?;
    validate_state_parent(state_file)
}

/// Read `/proc/<pid>/stat` field 22 for a live, non-zombie process to guard
/// against PID reuse. A zombie has exited and is therefore reported as gone to
/// status/stop callers even while its parent has not yet called `wait`.
pub fn process_start_ticks(pid: u32, proc_root: &Path) -> Result<u64> {
    inspect_process_start_ticks(pid, proc_root)?
        .ok_or_else(|| Error::new(ErrorKind::Process, "process has exited"))
}

/// Inspect a process identity while distinguishing a proven exit from an
/// observation failure. Only a missing proc entry or Z/X state is `None`;
/// malformed, inaccessible, and other I/O failures remain errors.
pub fn inspect_process_start_ticks(pid: u32, proc_root: &Path) -> Result<Option<u64>> {
    process_start_ticks_impl(pid, proc_root, false)
}

/// Capture identity immediately after spawn, when a very short-lived child may
/// already be a waitable zombie owned by this process.
pub(crate) fn process_start_ticks_including_zombie(pid: u32, proc_root: &Path) -> Result<u64> {
    process_start_ticks_impl(pid, proc_root, true)?
        .ok_or_else(|| Error::new(ErrorKind::Process, "process has exited"))
}

fn process_start_ticks_impl(
    pid: u32,
    proc_root: &Path,
    include_zombie: bool,
) -> Result<Option<u64>> {
    let stat_path = proc_root.join(pid.to_string()).join("stat");
    let stat = match fs::read_to_string(&stat_path) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Error::io(
                ErrorKind::Process,
                "cannot read process identity",
                error,
            ));
        }
    };
    let close = stat
        .rfind(')')
        .ok_or_else(|| Error::new(ErrorKind::Process, "malformed /proc process identity"))?;
    let remaining = stat
        .get(close + 1..)
        .ok_or_else(|| Error::new(ErrorKind::Process, "malformed /proc process identity"))?;
    let mut fields = remaining.split_whitespace();
    let state = fields
        .next()
        .ok_or_else(|| Error::new(ErrorKind::Process, "process state is missing"))?;
    if matches!(state, "Z" | "X" | "x") && !include_zombie {
        return Ok(None);
    }
    // The first token after ')' is field 3. Having consumed it, field 22 is 18
    // tokens farther into the iterator.
    let value = fields
        .nth(18)
        .ok_or_else(|| Error::new(ErrorKind::Process, "process start time is missing"))?;
    value
        .parse()
        .map(Some)
        .map_err(|_| Error::new(ErrorKind::Process, "process start time is invalid"))
}

fn validate_owner_and_mode(metadata: &fs::Metadata, executable: bool) -> Result<()> {
    let uid = current_euid();
    if metadata.uid() != uid && metadata.uid() != 0 {
        return Err(Error::new(
            ErrorKind::Security,
            "file must be owned by the caller or root",
        ));
    }
    if metadata.permissions().mode() & 0o022 != 0 {
        return Err(Error::new(
            ErrorKind::Security,
            if executable {
                "executable must not be group- or world-writable"
            } else {
                "input file must not be group- or world-writable"
            },
        ));
    }
    Ok(())
}

fn validate_absolute_components(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::new(
            ErrorKind::Security,
            "security-sensitive path must be absolute",
        ));
    }
    // Validate the complete lexical path before stopping filesystem traversal
    // at a missing component. Otherwise `/safe/missing/../escape` could avoid
    // inspection of its trailing parent component.
    for component in path.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err(Error::new(
                ErrorKind::Security,
                "path must not contain '.', '..', or platform prefixes",
            ));
        }
    }

    let mut current = PathBuf::from("/");
    let mut component_missing = false;
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(part) => current.push(part),
            _ => unreachable!("path components were validated above"),
        }
        if component_missing {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(Error::new(
                    ErrorKind::Security,
                    format!(
                        "symlink path component is not allowed: {}",
                        current.display()
                    ),
                ));
            }
            Ok(metadata) => {
                if metadata.is_dir() && metadata.permissions().mode() & 0o022 != 0 {
                    return Err(Error::new(
                        ErrorKind::Security,
                        format!(
                            "group- or world-writable path component is not allowed: {}",
                            current.display()
                        ),
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                component_missing = true;
            }
            Err(error) => {
                return Err(Error::io(
                    ErrorKind::Security,
                    "cannot inspect path component",
                    error,
                ));
            }
        }
    }
    Ok(())
}

fn create_private_directory_chain(path: &Path) -> Result<()> {
    let mut missing = Vec::new();
    let mut current = path;
    while !current.exists() {
        missing.push(current.to_path_buf());
        current = current.parent().ok_or_else(|| {
            Error::new(ErrorKind::Security, "cannot locate existing state ancestor")
        })?;
    }
    validate_absolute_components(current)?;
    for directory in missing.into_iter().rev() {
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder.create(&directory).map_err(|error| {
            Error::io(
                ErrorKind::State,
                "cannot create private state directory",
                error,
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    fn proc_stat(state: &str, ticks: u64) -> String {
        let filler = ["0"; 18].join(" ");
        format!("42 (name with ) parenthesis) {state} {filler} {ticks}\n")
    }

    #[test]
    fn rejects_unsafe_group_ids() {
        assert!(validate_signal_group(0).is_err());
        assert!(validate_signal_group(1).is_err());
        assert!(validate_signal_group(current_process_group()).is_err());
    }

    #[test]
    fn signal_wrapper_rejects_broadcast_targets() {
        assert_eq!(
            send_signal(0, SIGNAL_NONE)
                .expect_err("target zero must be rejected")
                .kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert_eq!(
            send_signal(-1, SIGTERM)
                .expect_err("target minus one must be rejected")
                .kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn pidfd_signals_and_waits_for_the_exact_process() {
        assert!(
            ProcessHandle::open(i32::MAX as u32)
                .expect("missing PID")
                .is_none()
        );

        let mut child = Command::new("/usr/bin/sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn pidfd test child");
        let handle = ProcessHandle::open(child.id())
            .expect("open child pidfd")
            .expect("live child pidfd");
        assert!(!handle.has_exited().expect("query live pidfd"));
        assert!(handle.signal(SIGTERM).expect("signal exact child"));

        let deadline = Instant::now() + Duration::from_secs(2);
        while !handle.has_exited().expect("poll child pidfd") {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("pidfd-signalled child did not exit");
            }
            thread::sleep(Duration::from_millis(5));
        }
        loop {
            if child.try_wait().expect("reap child exit").is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("pidfd-signalled child did not exit");
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(handle.has_exited().expect("query exited pidfd"));
    }

    #[test]
    fn complete_lexical_path_is_validated_after_missing_component() {
        let path = Path::new("/idlepilot-definitely-missing/path/../escape");
        assert!(validate_absolute_components(path).is_err());
    }

    #[test]
    fn proc_identity_distinguishes_exit_from_observation_failure() {
        let root = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!("proc-identity-{}", std::process::id()));
        let process = root.join("42");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&process).expect("create mock proc process");

        assert_eq!(
            inspect_process_start_ticks(7, &root).expect("missing process"),
            None
        );
        for state in ["Z", "X", "x"] {
            fs::write(process.join("stat"), proc_stat(state, 123)).expect("write exited stat");
            assert_eq!(
                inspect_process_start_ticks(42, &root).expect("exited state"),
                None
            );
        }
        fs::write(process.join("stat"), proc_stat("R", 987)).expect("write running stat");
        assert_eq!(
            inspect_process_start_ticks(42, &root).expect("running state"),
            Some(987)
        );
        fs::write(process.join("stat"), "malformed\n").expect("write malformed stat");
        assert!(inspect_process_start_ticks(42, &root).is_err());
        fs::remove_dir_all(&root).expect("remove mock proc root");
    }

    #[test]
    fn proc_group_parser_handles_parentheses_in_the_command_name() {
        let stat = "42 (worker ) with spaces) S 7 12345 0 0 0\n";
        assert_eq!(
            process_group_from_stat(stat).expect("parse process group"),
            12_345
        );
        assert!(process_group_from_stat("malformed\n").is_err());
    }

    #[test]
    fn proc_group_scan_excludes_the_anchor_and_ignores_other_groups() {
        let root = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!("proc-group-scan-{}", std::process::id()));
        let group = i32::MAX - 10;
        let _ = fs::remove_dir_all(&root);
        for process_id in [42_u32, 43, 44] {
            fs::create_dir_all(root.join(process_id.to_string()))
                .expect("create mock proc process");
        }
        fs::write(
            root.join("42/stat"),
            format!("42 (leader ) name) Z 1 {group} 0 0 0\n"),
        )
        .expect("write leader stat");
        fs::write(root.join("43/stat"), "43 (unrelated) S 1 7000 0 0 0\n")
            .expect("write unrelated stat");

        assert!(!process_group_has_other_members(group, 42, &root).expect("scan anchor only"));

        fs::write(
            root.join("44/stat"),
            format!("44 (descendant) S 42 {group} 0 0 0\n"),
        )
        .expect("write descendant stat");
        assert!(process_group_has_other_members(group, 42, &root).expect("scan descendant"));

        fs::remove_dir_all(&root).expect("remove mock proc root");
    }
}
