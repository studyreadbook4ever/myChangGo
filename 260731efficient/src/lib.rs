//! `idlepilot` is a Linux-only, fail-closed library for supervising a process
//! while a configurable set of local conditions remains true.
//!
//! The crate intentionally has no third-party Cargo dependencies. It does not
//! invoke a shell, interpolate configuration values, or accept an executable
//! over its control/status interface.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[cfg(not(target_os = "linux"))]
compile_error!("idlepilot currently supports Linux only");

/// Content-addressed storage for reviewed action artifacts.
pub mod artifact;
/// Local civil and monotonic clock adapters.
pub mod clock;
/// Fail-closed Linux Wi-Fi, power, idle, and time-window probes.
pub mod conditions;
/// Strict, shell-free configuration parsing and validation.
pub mod config;
/// Stable library error types.
pub mod error;
/// Minimal deterministic JSON encoding for the machine interface.
pub mod json;
/// Read-only launch readiness planning for agents and preflight tools.
pub mod planning;
/// Shell-free action launch and process-group supervision.
pub mod process;
/// Linux identity, signal, and filesystem security helpers.
pub mod security;
/// Dependency-free SHA-256 used to pin reviewed artifacts.
pub mod sha256;
/// Durable state and single-instance locking.
pub mod state;
/// Condition-gated supervisor state machine and audit events.
pub mod supervisor;

pub use conditions::{ConditionSnapshot, ConditionState, ConditionStatus, LinuxProbe, Probe};
pub use config::{Config, IdleMode, PowerPolicy, TimeWindow, WifiPolicy};
pub use error::{Error, ErrorKind, Result};
pub use planning::{ArtifactStatus, LaunchPlan, PlanDecision};
pub use process::{ActionExit, ActionProcess, StopExitTiming, StopOutcome};
pub use state::{PersistentState, Phase};
pub use supervisor::{
    Event, EventKind, EventSink, JsonLineSink, NullSink, RunMode, RunOutcome, Supervisor,
};

/// Stable machine-interface schema version.
pub const API_VERSION: u32 = 1;

/// Crate version embedded at build time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
