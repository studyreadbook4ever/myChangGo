//! Read-only launch readiness assessment for agents and preflight tooling.

use crate::conditions::ConditionSnapshot;
use crate::config::Config;
use crate::error::Result;
use crate::security;
use crate::sha256;
use crate::state::{PersistentState, Phase};
use std::io;
use std::path::Path;

const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// Result of checking the configured executable content pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactStatus {
    /// The executable matches its configured SHA-256.
    Verified,
    /// No SHA-256 was configured. Launch remains possible but is less robust.
    Unpinned,
    /// The executable does not match its configured SHA-256.
    Mismatch,
}

impl ArtifactStatus {
    /// Stable machine representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Unpinned => "unpinned",
            Self::Mismatch => "mismatch",
        }
    }

    /// Inspect the configured executable without launching it.
    pub fn inspect(config: &Config) -> Result<Self> {
        let Some(expected) = config.executable_sha256.as_deref() else {
            return Ok(Self::Unpinned);
        };
        let input = security::open_secure_input_file(&config.executable, MAX_ARTIFACT_BYTES)?;
        let (_, actual) = sha256::copy_and_digest(input, io::sink(), MAX_ARTIFACT_BYTES)?;
        Ok(if actual == expected {
            Self::Verified
        } else {
            Self::Mismatch
        })
    }
}

/// Read-only decision produced by [`LaunchPlan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanDecision {
    /// Every observed prerequisite currently permits a launch attempt.
    Ready,
    /// At least one live condition is false or unknown.
    ConditionsBlocked,
    /// The configured executable failed its SHA-256 check.
    ArtifactMismatch,
    /// Another daemon with the recorded identity is still running.
    DaemonRunning,
    /// Persisted crash/action evidence requires operator review.
    RecoveryRequired,
    /// This local window was already terminally completed.
    AlreadyCompleted,
    /// This local window consumed its launch-attempt allowance.
    AttemptsExhausted,
    /// A custom probe claimed eligibility without a matching window key.
    InvalidSnapshot,
}

impl PlanDecision {
    /// Stable machine representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::ConditionsBlocked => "conditions_blocked",
            Self::ArtifactMismatch => "artifact_mismatch",
            Self::DaemonRunning => "daemon_running",
            Self::RecoveryRequired => "recovery_required",
            Self::AlreadyCompleted => "already_completed",
            Self::AttemptsExhausted => "attempts_exhausted",
            Self::InvalidSnapshot => "invalid_snapshot",
        }
    }

    /// Whether this decision represents a current launch candidate.
    #[must_use]
    pub const fn would_launch(self) -> bool {
        matches!(self, Self::Ready)
    }

    /// Whether operator attention is required before a future launch.
    #[must_use]
    pub const fn requires_attention(self) -> bool {
        matches!(
            self,
            Self::ArtifactMismatch | Self::RecoveryRequired | Self::InvalidSnapshot
        )
    }
}

/// Combined, read-only view of configuration, conditions, artifact, and state.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    /// Overall decision.
    pub decision: PlanDecision,
    /// Stable reason code for the decision.
    pub reason: &'static str,
    /// Full condition snapshot used for the decision.
    pub conditions: ConditionSnapshot,
    /// Executable digest status.
    pub artifact: ArtifactStatus,
    /// Current local window key, when inside the configured window.
    pub window_key: Option<String>,
    /// Attempts that apply to `window_key` after window rollover semantics.
    pub effective_attempts: u32,
    /// Configured attempt limit.
    pub max_attempts: u32,
    /// Persisted phase observed without modifying state.
    pub state_phase: Phase,
    /// Whether the recorded daemon identity is currently alive.
    pub daemon_alive: bool,
}

impl LaunchPlan {
    /// Inspect all read-only prerequisites without taking the instance lock or
    /// changing durable state. A `ready` result is a candidate, not a launch
    /// reservation: the supervisor still repeats every guard and lock check.
    pub fn inspect(
        config: &Config,
        conditions: ConditionSnapshot,
        state: &PersistentState,
    ) -> Result<Self> {
        config.validate()?;
        security::require_process_handle_support()?;
        state.verify_config_fingerprint(&config.state_fingerprint()?)?;
        let artifact = ArtifactStatus::inspect(config)?;
        let daemon_alive = daemon_identity_matches(state)?;
        let action_requires_attention = persisted_action_requires_attention(state);
        Ok(Self::evaluate(
            config,
            conditions,
            state,
            artifact,
            daemon_alive,
            action_requires_attention,
        ))
    }

    fn evaluate(
        config: &Config,
        conditions: ConditionSnapshot,
        state: &PersistentState,
        artifact: ArtifactStatus,
        daemon_alive: bool,
        action_requires_attention: bool,
    ) -> Self {
        let window_key = conditions
            .local_time
            .and_then(|local| local.window_key(config.window));
        let effective_attempts = window_key
            .as_deref()
            .filter(|key| state.attempt_window.as_deref() == Some(*key))
            .map_or(0, |_| state.attempts);

        let (decision, reason) = if daemon_alive {
            (PlanDecision::DaemonRunning, "daemon_already_running")
        } else if state.phase == Phase::Fault
            || state.has_unresolved_launch_intent()
            || action_requires_attention
        {
            (
                PlanDecision::RecoveryRequired,
                "persisted_action_requires_review",
            )
        } else if artifact == ArtifactStatus::Mismatch {
            (PlanDecision::ArtifactMismatch, "executable_digest_mismatch")
        } else if window_key.as_deref().is_some_and(|key| {
            state
                .completed_window
                .as_deref()
                .is_some_and(|completed| key <= completed)
        }) {
            (PlanDecision::AlreadyCompleted, "window_already_completed")
        } else if window_key.is_some() && effective_attempts >= config.max_attempts_per_window {
            (PlanDecision::AttemptsExhausted, "attempts_exhausted")
        } else if !conditions.all_met() {
            (
                PlanDecision::ConditionsBlocked,
                conditions.first_blocker().unwrap_or("conditions_not_met"),
            )
        } else if window_key.is_none() {
            (
                PlanDecision::InvalidSnapshot,
                "eligible_snapshot_missing_window_key",
            )
        } else {
            (PlanDecision::Ready, "ready")
        };

        Self {
            decision,
            reason,
            conditions,
            artifact,
            window_key,
            effective_attempts,
            max_attempts: config.max_attempts_per_window,
            state_phase: state.phase,
            daemon_alive,
        }
    }
}

fn daemon_identity_matches(state: &PersistentState) -> Result<bool> {
    let (Some(pid), Some(expected)) = (state.daemon_pid, state.daemon_start_ticks) else {
        return Ok(false);
    };
    Ok(
        security::inspect_process_start_ticks(pid, Path::new("/proc"))?
            .is_some_and(|actual| actual == expected),
    )
}

fn persisted_action_requires_attention(state: &PersistentState) -> bool {
    state.action_pid.is_some() || state.action_pgid.is_some() || state.action_start_ticks.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::LocalDateTime;
    use crate::conditions::{ConditionState, ConditionStatus};
    use crate::config::{IdleMode, PowerPolicy, TimeWindow, WifiPolicy};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::time::Duration;

    fn config() -> Config {
        Config {
            schema_version: 1,
            name: "planner-test".to_owned(),
            executable: PathBuf::from("/usr/bin/true"),
            args: Vec::new(),
            working_directory: PathBuf::from("/usr/bin"),
            environment: BTreeMap::new(),
            executable_sha256: None,
            window: TimeWindow::parse("01:00-03:00").expect("window"),
            poll_interval: Duration::from_secs(10),
            guard_interval: Duration::from_millis(100),
            start_stability: Duration::ZERO,
            idle_minimum: Duration::ZERO,
            wifi: WifiPolicy::Disabled,
            power: PowerPolicy::Ignore,
            idle: IdleMode::Disabled,
            stop_grace: Duration::from_secs(1),
            max_runtime: Some(Duration::from_secs(60)),
            max_attempts_per_window: 2,
            retry_on_failure: true,
            retry_after_guard_loss: true,
            state_file: PathBuf::from("/unused/planner.state"),
        }
    }

    fn snapshot(state: ConditionState) -> ConditionSnapshot {
        let status = |reason| ConditionStatus { state, reason };
        ConditionSnapshot {
            wifi: status("test_wifi"),
            power: status("test_power"),
            idle: status("test_idle"),
            window: status("test_window"),
            local_time: Some(LocalDateTime {
                year: 2026,
                year_day: 211,
                hour: 2,
                minute: 0,
                second: 0,
            }),
            observed_monotonic: Duration::ZERO,
        }
    }

    #[test]
    fn pure_decision_tracks_ready_completed_and_attempt_rollover() {
        let config = config();
        let ready = LaunchPlan::evaluate(
            &config,
            snapshot(ConditionState::Met),
            &PersistentState::default(),
            ArtifactStatus::Unpinned,
            false,
            false,
        );
        assert_eq!(ready.decision, PlanDecision::Ready);
        assert!(ready.decision.would_launch());

        let key = ready.window_key.clone().expect("window key");
        let completed = PersistentState {
            completed_window: Some(key.clone()),
            ..PersistentState::default()
        };
        let plan = LaunchPlan::evaluate(
            &config,
            snapshot(ConditionState::Met),
            &completed,
            ArtifactStatus::Verified,
            false,
            false,
        );
        assert_eq!(plan.decision, PlanDecision::AlreadyCompleted);

        let older_attempts = PersistentState {
            attempt_window: Some("2026-001@01:00-03:00".to_owned()),
            attempts: 99,
            ..PersistentState::default()
        };
        let plan = LaunchPlan::evaluate(
            &config,
            snapshot(ConditionState::Met),
            &older_attempts,
            ArtifactStatus::Verified,
            false,
            false,
        );
        assert_eq!(plan.decision, PlanDecision::Ready);
        assert_eq!(plan.effective_attempts, 0);
    }

    #[test]
    fn pure_decision_surfaces_attention_before_ordinary_blockers() {
        let config = config();
        let state = PersistentState {
            phase: Phase::Qualifying,
            daemon_pid: Some(42),
            daemon_start_ticks: Some(1),
            last_reason: Some("launch_intent_persisted".to_owned()),
            ..PersistentState::default()
        };
        let plan = LaunchPlan::evaluate(
            &config,
            snapshot(ConditionState::NotMet),
            &state,
            ArtifactStatus::Mismatch,
            false,
            false,
        );
        assert_eq!(plan.decision, PlanDecision::RecoveryRequired);
        assert!(plan.decision.requires_attention());

        let fault = PersistentState {
            phase: Phase::Fault,
            ..PersistentState::default()
        };
        let plan = LaunchPlan::evaluate(
            &config,
            snapshot(ConditionState::Met),
            &fault,
            ArtifactStatus::Verified,
            false,
            false,
        );
        assert_eq!(plan.decision, PlanDecision::RecoveryRequired);
        assert!(plan.decision.requires_attention());
    }
}
