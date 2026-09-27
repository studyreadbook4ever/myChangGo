use crate::conditions::{ConditionSnapshot, Probe};
use crate::config::Config;
use crate::error::{Error, ErrorKind, Result};
use crate::json;
use crate::process::{ActionExit, ActionProcess, PreparedAction, StopExitTiming, StopOutcome};
use crate::security;
use crate::state::{PersistentState, Phase, StateLock};
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

// The launch intent is already durable before spawn, so a slow running-state
// fsync cannot erase attempt accounting. Give ordinary home storage room for
// transient writeback stalls while retaining a finite failure bound.
const MIN_STATE_WRITE_DEADLINE: Duration = Duration::from_secs(15);

/// Supervisor execution mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    /// Keep polling until a termination signal.
    Daemon,
    /// Perform one eligibility decision and at most one launch.
    Once,
}

/// Stable event category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// Daemon initialization.
    Initialized,
    /// Complete condition observation.
    Conditions,
    /// State transition.
    Phase,
    /// Action process launched.
    ActionStarted,
    /// Action exited by itself.
    ActionExited,
    /// Guard/runtime/shutdown requested action stop.
    ActionStopping,
    /// Action process group was stopped.
    ActionStopped,
    /// Supervisor is exiting normally.
    Shutdown,
    /// Fail-closed fault.
    Fault,
}

impl EventKind {
    /// Stable machine representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Initialized => "initialized",
            Self::Conditions => "conditions",
            Self::Phase => "phase",
            Self::ActionStarted => "action_started",
            Self::ActionExited => "action_exited",
            Self::ActionStopping => "action_stopping",
            Self::ActionStopped => "action_stopped",
            Self::Shutdown => "shutdown",
            Self::Fault => "fault",
        }
    }
}

/// Structured audit event. It intentionally excludes argv, environment, SSID,
/// IP addresses, and action output.
#[derive(Debug, Clone)]
pub struct Event {
    /// Per-process monotonically increasing sequence.
    pub sequence: u64,
    /// Category.
    pub kind: EventKind,
    /// Current phase.
    pub phase: Phase,
    /// Stable reason code.
    pub reason: &'static str,
    /// Configured instance name.
    pub name: String,
    /// Observed local-window key for condition events, or the current
    /// scheduling-window key for lifecycle events.
    pub window_key: Option<String>,
    /// Optional condition snapshot.
    pub conditions: Option<ConditionSnapshot>,
    /// Optional action leader PID.
    pub action_pid: Option<u32>,
    /// Optional action PGID.
    pub action_pgid: Option<i32>,
    /// Optional normal exit code.
    pub exit_code: Option<i32>,
    /// Optional terminating signal.
    pub exit_signal: Option<i32>,
}

impl Event {
    /// Encode according to the stable JSON-lines event schema.
    #[must_use]
    pub fn to_json(&self) -> String {
        let mut object = json::Object::new();
        object
            .number("api_version", crate::API_VERSION)
            .number("sequence", self.sequence)
            .text("event", self.kind.as_str())
            .text("phase", self.phase.as_str())
            .text("reason", self.reason)
            .text("name", &self.name)
            .optional_text("window_key", self.window_key.as_deref());
        match self.action_pid {
            Some(value) => {
                object.number("action_pid", value);
            }
            None => {
                object.raw("action_pid", "null");
            }
        }
        match self.action_pgid {
            Some(value) => {
                object.number("action_pgid", value);
            }
            None => {
                object.raw("action_pgid", "null");
            }
        }
        match self.exit_code {
            Some(value) => {
                object.number("exit_code", value);
            }
            None => {
                object.raw("exit_code", "null");
            }
        }
        match self.exit_signal {
            Some(value) => {
                object.number("exit_signal", value);
            }
            None => {
                object.raw("exit_signal", "null");
            }
        }
        if let Some(snapshot) = &self.conditions {
            object
                .text("wifi", snapshot.wifi.state.as_str())
                .text("wifi_reason", snapshot.wifi.reason)
                .text("power", snapshot.power.state.as_str())
                .text("power_reason", snapshot.power.reason)
                .text("idle", snapshot.idle.state.as_str())
                .text("idle_reason", snapshot.idle.reason)
                .text("window", snapshot.window.state.as_str())
                .text("window_reason", snapshot.window.reason)
                .boolean("eligible", snapshot.all_met())
                .number(
                    "observed_monotonic_ms",
                    snapshot.observed_monotonic.as_millis(),
                );
        } else {
            object.raw("eligible", "null");
        }
        object.finish()
    }
}

/// Event output seam.
pub trait EventSink {
    /// Consume one event.
    fn emit(&mut self, event: &Event) -> Result<()>;
}

/// Sink that discards events.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&mut self, _event: &Event) -> Result<()> {
        Ok(())
    }
}

/// JSON-lines event sink suitable for agents and journald.
pub struct JsonLineSink<W: Write> {
    writer: W,
}

impl<W: Write> JsonLineSink<W> {
    /// Wrap a writer.
    #[must_use]
    pub const fn new(writer: W) -> Self {
        Self { writer }
    }
}

impl<W: Write> EventSink for JsonLineSink<W> {
    fn emit(&mut self, event: &Event) -> Result<()> {
        let encoded = event.to_json();
        self.writer
            .write_all(encoded.as_bytes())
            .and_then(|()| self.writer.write_all(b"\n"))
            .and_then(|()| self.writer.flush())
            .map_err(|error| Error::io(ErrorKind::Os, "cannot write event", error))
    }
}

/// Why a run loop returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// One-shot evaluation found conditions false or unknown.
    NotEligible,
    /// The action completed successfully.
    Completed,
    /// The action exited unsuccessfully.
    Failed,
    /// A live guard became false/unknown and the action was stopped.
    GuardLost,
    /// Runtime cap stopped the action.
    RuntimeLimit,
    /// SIGINT/SIGTERM stopped the supervisor.
    Shutdown(i32),
    /// The current local window was already completed.
    AlreadyCompleted,
    /// Attempts were exhausted for this window.
    AttemptsExhausted,
}

/// Real process supervisor.
pub struct Supervisor<P: Probe, S: EventSink> {
    config: Config,
    probe: P,
    sink: S,
    sequence: u64,
    action_live: bool,
    deferred_events: Vec<Event>,
    process_exit_required: bool,
}

impl<P: Probe, S: EventSink> Supervisor<P, S> {
    /// Construct a supervisor.
    #[must_use]
    pub const fn new(config: Config, probe: P, sink: S) -> Self {
        Self {
            config,
            probe,
            sink,
            sequence: 0,
            action_live: false,
            deferred_events: Vec::new(),
            process_exit_required: false,
        }
    }

    /// Start the run loop.
    pub fn run(&mut self, mode: RunMode) -> Result<RunOutcome> {
        if self.process_exit_required {
            return Err(Error::new(
                ErrorKind::Internal,
                "this supervisor process is poisoned and must exit before reuse",
            )
            .requiring_process_exit());
        }
        security::require_unprivileged_user()?;
        security::require_process_handle_support()?;
        // `run` is the explicit mutating boundary. Read-only config/status/
        // planning validation never creates state directories.
        security::ensure_state_parent(&self.config.state_file)?;
        self.config.validate()?;
        let state_lock = StateLock::acquire(&self.config.state_file)?;
        let mut state = PersistentState::load(&self.config.state_file)?;
        state.bind_config_fingerprint(&self.config.state_fingerprint()?)?;
        Self::recover_or_reject_stale_action(&mut state)?;

        state.daemon_pid = Some(std::process::id());
        state.daemon_start_ticks = Some(security::process_start_ticks(
            std::process::id(),
            Path::new("/proc"),
        )?);
        state.phase = Phase::Waiting;
        state.action_pid = None;
        state.action_pgid = None;
        state.action_start_ticks = None;
        state.last_reason = Some("initialized".to_owned());
        state.store(&self.config.state_file)?;
        self.event(EventKind::Initialized, &state, "initialized", None, None)?;

        let result = self.run_loop(mode, &mut state);
        if matches!(&result, Err(error) if error.requires_process_exit()) {
            self.require_process_exit();
        }
        let final_event = if self.process_exit_required {
            Ok(())
        } else if let Ok(outcome) = &result {
            state.phase = Phase::Stopped;
            state.last_reason = Some(outcome_reason(*outcome).to_owned());
            self.event(
                EventKind::Shutdown,
                &state,
                outcome_reason(*outcome),
                None,
                None,
            )
        } else {
            state.phase = Phase::Fault;
            state.last_reason = Some("supervisor_error".to_owned());
            self.event(EventKind::Fault, &state, "supervisor_error", None, None)
        };
        state.action_pid = None;
        state.action_pgid = None;
        state.action_start_ticks = None;
        state.daemon_pid = None;
        state.daemon_start_ticks = None;
        let final_store = if self.process_exit_required {
            Ok(())
        } else {
            state.store(&self.config.state_file)
        };
        if self.process_exit_required {
            // A detached, potentially blocked state writer or an unkillable
            // process group must keep the instance lock until this process
            // exits. The CLI exits immediately; embedded callers must do the
            // same before constructing another supervisor for this state.
            std::mem::forget(state_lock);
            return Err(match result {
                Err(error) => error.requiring_process_exit(),
                Ok(_) => Error::new(
                    ErrorKind::Internal,
                    "terminal supervisor state requires process exit",
                )
                .requiring_process_exit(),
            });
        }
        match result {
            Err(error) => Err(error),
            Ok(outcome) => {
                final_event?;
                final_store?;
                Ok(outcome)
            }
        }
    }

    fn run_loop(&mut self, mode: RunMode, state: &mut PersistentState) -> Result<RunOutcome> {
        loop {
            if let Some(signal) = security::requested_termination_signal() {
                return Ok(RunOutcome::Shutdown(signal));
            }

            let snapshot = self.observe(state)?;
            let window_key = snapshot
                .local_time
                .and_then(|local| local.window_key(self.config.window));
            state.window_key.clone_from(&window_key);

            if let Some(key) = window_key.as_deref() {
                if state.attempt_window.as_deref() != Some(key) {
                    state.attempt_window = Some(key.to_owned());
                    state.attempts = 0;
                }
                if state
                    .completed_window
                    .as_deref()
                    .is_some_and(|completed| key <= completed)
                {
                    self.transition(state, Phase::Completed, "window_already_completed")?;
                    if mode == RunMode::Once {
                        return Ok(RunOutcome::AlreadyCompleted);
                    }
                    if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                        return Ok(RunOutcome::Shutdown(signal));
                    }
                    continue;
                }
                if state.attempts >= self.config.max_attempts_per_window {
                    state.completed_window = Some(key.to_owned());
                    self.transition(state, Phase::Completed, "attempts_exhausted")?;
                    if mode == RunMode::Once {
                        return Ok(RunOutcome::AttemptsExhausted);
                    }
                    if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                        return Ok(RunOutcome::Shutdown(signal));
                    }
                    continue;
                }
            }

            if !snapshot.all_met() {
                self.transition(
                    state,
                    Phase::Waiting,
                    snapshot.first_blocker().unwrap_or("conditions_not_met"),
                )?;
                if mode == RunMode::Once {
                    return Ok(RunOutcome::NotEligible);
                }
                if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                    return Ok(RunOutcome::Shutdown(signal));
                }
                continue;
            }
            let Some(window_key) = window_key else {
                return Err(Error::new(
                    ErrorKind::Internal,
                    "eligible snapshot has no local window key",
                ));
            };

            self.transition(state, Phase::Qualifying, "stabilizing_conditions")?;
            if !self.qualify(state)? {
                if let Some(signal) = security::requested_termination_signal() {
                    return Ok(RunOutcome::Shutdown(signal));
                }
                if mode == RunMode::Once {
                    return Ok(RunOutcome::NotEligible);
                }
                self.transition(state, Phase::Waiting, "stability_lost")?;
                if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                    return Ok(RunOutcome::Shutdown(signal));
                }
                continue;
            }

            // Digest verification can be expensive, so finish it before the
            // final condition query. Launch then performs only a quick inode
            // identity check.
            let prepared = PreparedAction::prepare(&self.config)?;
            if let Some(signal) = security::requested_termination_signal() {
                return Ok(RunOutcome::Shutdown(signal));
            }

            // Recheck after potentially expensive artifact preparation and
            // before reserving a durable launch attempt.
            let pre_intent = self.probe.snapshot();
            let pre_intent_key = pre_intent
                .local_time
                .and_then(|local| local.window_key(self.config.window));
            if !pre_intent.all_met() || pre_intent_key.as_deref() != Some(window_key.as_str()) {
                if mode == RunMode::Once {
                    self.event(
                        EventKind::Conditions,
                        state,
                        pre_intent
                            .first_blocker()
                            .unwrap_or("pre_intent_window_changed"),
                        Some(pre_intent),
                        None,
                    )?;
                    return Ok(RunOutcome::NotEligible);
                }
                self.event(
                    EventKind::Conditions,
                    state,
                    pre_intent
                        .first_blocker()
                        .unwrap_or("pre_intent_window_changed"),
                    Some(pre_intent.clone()),
                    None,
                )?;
                self.transition(
                    state,
                    Phase::Waiting,
                    pre_intent
                        .first_blocker()
                        .unwrap_or("pre_intent_window_changed"),
                )?;
                if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                    return Ok(RunOutcome::Shutdown(signal));
                }
                continue;
            }

            if let Some(signal) = security::requested_termination_signal() {
                return Ok(RunOutcome::Shutdown(signal));
            }
            state.attempts = state.attempts.saturating_add(1);
            state.attempt_window = Some(window_key.clone());
            state.phase = Phase::Qualifying;
            state.last_reason = Some("launch_intent_persisted".to_owned());
            state.store(&self.config.state_file)?;

            if let Some(signal) = security::requested_termination_signal() {
                return Ok(RunOutcome::Shutdown(signal));
            }

            // No synchronous state/event I/O is allowed after this last guard
            // query. The launch attempt is already durable, so a crash in the
            // remaining fork/exec window cannot erase its attempt accounting.
            let pre_spawn = self.probe.snapshot();
            let pre_spawn_key = pre_spawn
                .local_time
                .and_then(|local| local.window_key(self.config.window));
            if !pre_spawn.all_met() || pre_spawn_key.as_deref() != Some(window_key.as_str()) {
                if mode == RunMode::Once {
                    self.event(
                        EventKind::Conditions,
                        state,
                        pre_spawn
                            .first_blocker()
                            .unwrap_or("pre_spawn_window_changed"),
                        Some(pre_spawn),
                        None,
                    )?;
                    return Ok(RunOutcome::NotEligible);
                }
                self.event(
                    EventKind::Conditions,
                    state,
                    pre_spawn
                        .first_blocker()
                        .unwrap_or("pre_spawn_window_changed"),
                    Some(pre_spawn.clone()),
                    None,
                )?;
                self.transition(
                    state,
                    Phase::Waiting,
                    pre_spawn
                        .first_blocker()
                        .unwrap_or("pre_spawn_window_changed"),
                )?;
                if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                    return Ok(RunOutcome::Shutdown(signal));
                }
                continue;
            }
            if let Some(signal) = security::requested_termination_signal() {
                return Ok(RunOutcome::Shutdown(signal));
            }
            let mut action = ActionProcess::spawn_prepared(&self.config, &prepared)?;
            self.action_live = true;
            state.phase = Phase::Running;
            state.action_pid = Some(action.pid());
            state.action_pgid = Some(action.process_group());
            state.action_start_ticks = action.start_ticks();
            state.last_reason = Some("action_started".to_owned());
            self.event(
                EventKind::ActionStarted,
                state,
                "action_started",
                None,
                None,
            )?;

            // Immediate post-spawn recheck catches a change during fork/exec.
            let post_spawn = self.observe(state)?;
            let post_spawn_key = post_spawn
                .local_time
                .and_then(|local| local.window_key(self.config.window));
            let post_spawn_exit = match action.poll(self.config.stop_grace) {
                Ok(exit) => exit,
                Err(error) => {
                    self.action_live = false;
                    if error.requires_process_exit() {
                        self.require_process_exit();
                        std::mem::forget(action);
                    } else {
                        state.action_pid = None;
                        state.action_pgid = None;
                        state.action_start_ticks = None;
                        let _ = self.flush_deferred_events();
                    }
                    return Err(error);
                }
            };
            let immediate_outcome = if let Some(exit) = post_spawn_exit {
                Some(MonitorOutcome::Exited(exit))
            } else if !post_spawn.all_met()
                || post_spawn_key.as_deref() != Some(window_key.as_str())
            {
                let reason = post_spawn
                    .first_blocker()
                    .unwrap_or("post_spawn_window_changed");
                let stop_result =
                    self.stop_action_with_grace(state, &mut action, reason, Duration::ZERO);
                match stop_result {
                    Ok(stop) => Some(classify_stop(reason, stop)),
                    Err(error) => {
                        if self.process_exit_required {
                            std::mem::forget(action);
                        }
                        return Err(error);
                    }
                }
            } else {
                None
            };

            let outcome = if let Some(outcome) = immediate_outcome {
                outcome
            } else {
                let mut state_writer = match persist_state_in_background(
                    state,
                    &self.config.state_file,
                    self.config.guard_interval.max(MIN_STATE_WRITE_DEADLINE),
                ) {
                    Ok(writer) => writer,
                    Err(error) => {
                        return Err(
                            self.cleanup_after_state_writer_start_failure(state, action, error)
                        );
                    }
                };
                let outcome = match self.monitor_action(
                    state,
                    &mut action,
                    &window_key,
                    &mut state_writer,
                ) {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        self.action_live = false;
                        if error.requires_process_exit() {
                            self.require_process_exit();
                            std::mem::forget(action);
                            drop(state_writer);
                            return Err(error);
                        }
                        if self.process_exit_required {
                            std::mem::forget(action);
                            drop(state_writer);
                            return Err(error);
                        }
                        match action.stop(Duration::ZERO) {
                            Ok(stop) if stop.group_empty => {}
                            Ok(_) => {
                                self.require_process_exit();
                                std::mem::forget(action);
                                drop(state_writer);
                                return Err(Error::new(
                                    ErrorKind::Security,
                                    "action process group remained populated after SIGKILL; process exit is required",
                                ));
                            }
                            Err(cleanup_error) => {
                                self.require_process_exit();
                                std::mem::forget(action);
                                drop(state_writer);
                                return Err(cleanup_error);
                            }
                        }
                        match finish_state_writer(state_writer) {
                            Ok(StateWriterFinish::Complete) => {}
                            Ok(StateWriterFinish::TimedOut) => {
                                self.require_process_exit();
                                return Err(state_writer_timeout());
                            }
                            Err(writer_error) => {
                                state.action_pid = None;
                                state.action_pgid = None;
                                state.action_start_ticks = None;
                                let _ = self.flush_deferred_events();
                                return Err(writer_error);
                            }
                        }
                        state.action_pid = None;
                        state.action_pgid = None;
                        state.action_start_ticks = None;
                        let _ = self.flush_deferred_events();
                        return Err(error);
                    }
                };
                match finish_state_writer(state_writer) {
                    Ok(StateWriterFinish::Complete) => {}
                    Ok(StateWriterFinish::TimedOut) => {
                        self.require_process_exit();
                        return Err(state_writer_timeout());
                    }
                    Err(error) => {
                        self.action_live = false;
                        state.action_pid = None;
                        state.action_pgid = None;
                        state.action_start_ticks = None;
                        let _ = self.flush_deferred_events();
                        return Err(error);
                    }
                }
                outcome
            };
            match outcome {
                MonitorOutcome::Exited(exit) => {
                    state.last_exit_code = exit.code;
                    state.last_exit_signal = exit.signal;
                    self.event(
                        EventKind::ActionExited,
                        state,
                        if exit.success {
                            "action_completed"
                        } else {
                            "action_failed"
                        },
                        None,
                        Some(exit),
                    )?;
                    state.action_pid = None;
                    state.action_pgid = None;
                    state.action_start_ticks = None;
                    self.action_live = false;
                    let (phase, reason, run_outcome, terminal) = if exit.success {
                        (
                            Phase::Completed,
                            "action_completed",
                            RunOutcome::Completed,
                            true,
                        )
                    } else if !self.config.retry_on_failure
                        || state.attempts >= self.config.max_attempts_per_window
                    {
                        (
                            Phase::Completed,
                            "action_failed_terminal",
                            RunOutcome::Failed,
                            true,
                        )
                    } else {
                        (
                            Phase::Waiting,
                            "action_failed_retryable",
                            RunOutcome::Failed,
                            false,
                        )
                    };
                    if terminal {
                        state.completed_window = Some(window_key);
                    }
                    state.phase = phase;
                    state.last_reason = Some(reason.to_owned());
                    state.store(&self.config.state_file)?;
                    self.flush_deferred_events()?;
                    self.event(EventKind::Phase, state, reason, None, None)?;
                    if mode == RunMode::Once {
                        return Ok(run_outcome);
                    }
                }
                MonitorOutcome::Stopped(reason, stop) => {
                    if !stop.group_empty {
                        self.require_process_exit();
                        std::mem::forget(action);
                        return Err(Error::new(
                            ErrorKind::Security,
                            "action process group remained populated after SIGKILL; process exit is required",
                        ));
                    }
                    state.last_reason = Some(reason.to_owned());
                    if let Some(exit) = stop.leader_exit {
                        state.last_exit_code = exit.code;
                        state.last_exit_signal = exit.signal;
                    }
                    self.action_live = false;
                    state.action_pid = None;
                    state.action_pgid = None;
                    state.action_start_ticks = None;
                    let run_outcome = if reason == "runtime_limit" {
                        RunOutcome::RuntimeLimit
                    } else if reason == "shutdown_signal" {
                        RunOutcome::Shutdown(
                            security::requested_termination_signal().unwrap_or(security::SIGTERM),
                        )
                    } else {
                        RunOutcome::GuardLost
                    };
                    let terminal = match run_outcome {
                        RunOutcome::RuntimeLimit => true,
                        RunOutcome::GuardLost => {
                            !self.config.retry_after_guard_loss
                                || state.attempts >= self.config.max_attempts_per_window
                        }
                        RunOutcome::Shutdown(_) => false,
                        _ => unreachable!("stopped monitor produced an invalid run outcome"),
                    };
                    if terminal {
                        state.completed_window = Some(window_key);
                    }
                    state.phase = if terminal {
                        Phase::Completed
                    } else {
                        Phase::Waiting
                    };
                    state.last_reason = Some(reason.to_owned());
                    state.store(&self.config.state_file)?;
                    self.flush_deferred_events()?;
                    self.event(EventKind::Phase, state, reason, None, None)?;
                    // Returning lets systemd apply its cgroup-wide cleanup
                    // backstop before Restart=on-failure resumes waiting.
                    return Ok(run_outcome);
                }
            }
            state.store(&self.config.state_file)?;
            if let Some(signal) = wait_interruptible(self.config.poll_interval, false) {
                return Ok(RunOutcome::Shutdown(signal));
            }
        }
    }

    fn qualify(&mut self, state: &mut PersistentState) -> Result<bool> {
        if self.config.start_stability.is_zero() {
            return Ok(true);
        }
        let started = Instant::now();
        while started.elapsed() < self.config.start_stability {
            let remaining = self
                .config
                .start_stability
                .saturating_sub(started.elapsed());
            let wait = remaining.min(self.config.guard_interval);
            if wait_interruptible(wait, true).is_some() {
                return Ok(false);
            }
            let snapshot = self.observe(state)?;
            if !snapshot.all_met() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn monitor_action(
        &mut self,
        state: &mut PersistentState,
        action: &mut ActionProcess,
        expected_window: &str,
        state_writer: &mut StateWriter,
    ) -> Result<MonitorOutcome> {
        loop {
            state_writer.poll()?;
            if let Some(exit) = action.poll(self.config.stop_grace)? {
                return Ok(MonitorOutcome::Exited(exit));
            }
            if security::requested_termination_signal().is_some() {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let stop = self.stop_action(state, action, "shutdown_signal")?;
                return Ok(classify_stop("shutdown_signal", stop));
            }
            if self
                .config
                .max_runtime
                .is_some_and(|limit| action.elapsed() >= limit)
            {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let stop = self.stop_action(state, action, "runtime_limit")?;
                return Ok(classify_stop("runtime_limit", stop));
            }
            let interrupted = wait_interruptible(self.config.guard_interval, true);
            state_writer.poll()?;
            if let Some(exit) = action.poll(self.config.stop_grace)? {
                return Ok(MonitorOutcome::Exited(exit));
            }
            if interrupted.is_some() || security::requested_termination_signal().is_some() {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let stop = self.stop_action(state, action, "shutdown_signal")?;
                return Ok(classify_stop("shutdown_signal", stop));
            }
            if self
                .config
                .max_runtime
                .is_some_and(|limit| action.elapsed() >= limit)
            {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let stop = self.stop_action(state, action, "runtime_limit")?;
                return Ok(classify_stop("runtime_limit", stop));
            }
            let snapshot = self.observe(state)?;
            let observed_window = snapshot
                .local_time
                .and_then(|local| local.window_key(self.config.window));
            if let Some(exit) = action.poll(self.config.stop_grace)? {
                return Ok(MonitorOutcome::Exited(exit));
            }
            if security::requested_termination_signal().is_some() {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let stop = self.stop_action(state, action, "shutdown_signal")?;
                return Ok(classify_stop("shutdown_signal", stop));
            }
            if self
                .config
                .max_runtime
                .is_some_and(|limit| action.elapsed() >= limit)
            {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let stop = self.stop_action(state, action, "runtime_limit")?;
                return Ok(classify_stop("runtime_limit", stop));
            }
            if !snapshot.all_met() || observed_window.as_deref() != Some(expected_window) {
                if let Some(exit) = action.poll(self.config.stop_grace)? {
                    return Ok(MonitorOutcome::Exited(exit));
                }
                let reason = snapshot.first_blocker().unwrap_or("running_window_changed");
                let stop = self.stop_action_with_grace(state, action, reason, Duration::ZERO)?;
                return Ok(classify_stop(reason, stop));
            }
        }
    }

    fn stop_action(
        &mut self,
        state: &mut PersistentState,
        action: &mut ActionProcess,
        reason: &'static str,
    ) -> Result<StopOutcome> {
        self.stop_action_with_grace(state, action, reason, self.config.stop_grace)
    }

    fn cleanup_after_state_writer_start_failure(
        &mut self,
        state: &mut PersistentState,
        mut action: ActionProcess,
        original_error: Error,
    ) -> Error {
        self.action_live = false;
        match action.stop(Duration::ZERO) {
            Ok(stop) if stop.group_empty => {}
            Ok(_) => {
                self.require_process_exit();
                std::mem::forget(action);
                return Error::new(
                    ErrorKind::Security,
                    "action process group remained populated after state-writer startup failure",
                )
                .requiring_process_exit();
            }
            Err(cleanup_error) => {
                self.require_process_exit();
                std::mem::forget(action);
                return cleanup_error.requiring_process_exit();
            }
        }
        state.action_pid = None;
        state.action_pgid = None;
        state.action_start_ticks = None;
        let _ = self.flush_deferred_events();
        original_error
    }

    fn stop_action_with_grace(
        &mut self,
        state: &mut PersistentState,
        action: &mut ActionProcess,
        reason: &'static str,
        grace: Duration,
    ) -> Result<StopOutcome> {
        state.phase = Phase::Stopping;
        state.last_reason = Some(reason.to_owned());
        let stop = match action.stop(grace) {
            Ok(stop) => stop,
            Err(error) => {
                self.require_process_exit();
                return Err(error);
            }
        };
        if !stop.group_empty {
            self.require_process_exit();
            return Err(Error::new(
                ErrorKind::Security,
                "action process group remained populated after SIGKILL; process exit is required",
            ));
        }
        if stop.exit_timing == StopExitTiming::BeforeSignal {
            state.phase = Phase::Running;
            state.last_reason = Some("action_started".to_owned());
            return Ok(stop);
        }
        self.event(EventKind::Phase, state, reason, None, None)?;
        self.event(EventKind::ActionStopping, state, reason, None, None)?;
        self.event(EventKind::ActionStopped, state, reason, None, None)?;
        Ok(stop)
    }

    fn observe(&mut self, state: &PersistentState) -> Result<ConditionSnapshot> {
        let snapshot = self.probe.snapshot();
        self.event(
            EventKind::Conditions,
            state,
            snapshot.first_blocker().unwrap_or("all_conditions_met"),
            Some(snapshot.clone()),
            None,
        )?;
        Ok(snapshot)
    }

    fn transition(
        &mut self,
        state: &mut PersistentState,
        phase: Phase,
        reason: &'static str,
    ) -> Result<()> {
        state.phase = phase;
        state.last_reason = Some(reason.to_owned());
        state.store(&self.config.state_file)?;
        self.event(EventKind::Phase, state, reason, None, None)
    }

    fn event(
        &mut self,
        kind: EventKind,
        state: &PersistentState,
        reason: &'static str,
        conditions: Option<ConditionSnapshot>,
        exit: Option<ActionExit>,
    ) -> Result<()> {
        if self.action_live
            && kind == EventKind::Conditions
            && conditions.as_ref().is_some_and(ConditionSnapshot::all_met)
        {
            return Ok(());
        }
        self.sequence = self.sequence.saturating_add(1);
        let window_key = if kind == EventKind::Conditions {
            conditions.as_ref().and_then(|snapshot| {
                snapshot
                    .local_time
                    .and_then(|local| local.window_key(self.config.window))
            })
        } else {
            state.window_key.clone()
        };
        let event = Event {
            sequence: self.sequence,
            kind,
            phase: state.phase,
            reason,
            name: self.config.name.clone(),
            window_key,
            conditions,
            action_pid: state.action_pid,
            action_pgid: state.action_pgid,
            exit_code: exit.and_then(|value| value.code),
            exit_signal: exit.and_then(|value| value.signal),
        };
        if self.action_live {
            if self.deferred_events.len() < 128 {
                self.deferred_events.push(event);
            }
            return Ok(());
        }
        self.sink.emit(&event)
    }

    fn flush_deferred_events(&mut self) -> Result<()> {
        for event in std::mem::take(&mut self.deferred_events) {
            self.sink.emit(&event)?;
        }
        Ok(())
    }

    fn require_process_exit(&mut self) {
        self.action_live = false;
        self.process_exit_required = true;
        self.deferred_events.clear();
    }

    fn recover_or_reject_stale_action(state: &mut PersistentState) -> Result<()> {
        if state.phase == Phase::Fault {
            return Err(Error::new(
                ErrorKind::Security,
                "persisted fault state requires operator review and state rotation",
            ));
        }
        if state.has_unresolved_launch_intent() {
            return Err(Error::new(
                ErrorKind::Security,
                "an earlier daemon died with an unresolved launch intent; verify cgroup/process cleanup and rotate the state before restart",
            ));
        }
        let (Some(pid), Some(action_group), Some(expected_ticks)) = (
            state.action_pid,
            state.action_pgid,
            state.action_start_ticks,
        ) else {
            state.action_pid = None;
            state.action_pgid = None;
            state.action_start_ticks = None;
            return Ok(());
        };
        match security::inspect_process_start_ticks(pid, Path::new("/proc"))? {
            Some(actual_ticks) if actual_ticks == expected_ticks => {
                security::validate_signal_group(action_group)?;
                Err(Error::new(
                    ErrorKind::Security,
                    "a previously supervised action is still alive; stop its systemd user unit or process group before restart",
                ))
            }
            Some(_) => Err(Error::new(
                ErrorKind::Security,
                "stale action PID was reused; refusing automatic cleanup",
            )),
            None => {
                if security::process_group_exists(action_group)? {
                    return Err(Error::new(
                        ErrorKind::Security,
                        "the recorded action leader is gone but its process group is still populated; refusing restart",
                    ));
                }
                Err(Error::new(
                    ErrorKind::Security,
                    "a previously launched action exited without a durable terminal result; refusing a possible duplicate launch",
                ))
            }
        }
    }
}

enum MonitorOutcome {
    Exited(ActionExit),
    Stopped(&'static str, StopOutcome),
}

fn classify_stop(reason: &'static str, stop: StopOutcome) -> MonitorOutcome {
    match (stop.exit_timing, stop.leader_exit) {
        (StopExitTiming::BeforeSignal, Some(exit)) => MonitorOutcome::Exited(exit),
        _ => MonitorOutcome::Stopped(reason, stop),
    }
}

struct StateWriter {
    receiver: mpsc::Receiver<Result<()>>,
    handle: thread::JoinHandle<()>,
    deadline: Instant,
    completed: bool,
    timed_out: bool,
}

impl StateWriter {
    fn poll(&mut self) -> Result<()> {
        if self.completed {
            return Ok(());
        }
        match self.receiver.try_recv() {
            Ok(result) => {
                self.completed = true;
                result
            }
            Err(mpsc::TryRecvError::Empty) if Instant::now() < self.deadline => Ok(()),
            Err(mpsc::TryRecvError::Empty) => {
                self.timed_out = true;
                Err(state_writer_timeout())
            }
            Err(mpsc::TryRecvError::Disconnected) => Err(Error::new(
                ErrorKind::Internal,
                "running-state writer disconnected without a result",
            )),
        }
    }
}

fn persist_state_in_background(
    state: &PersistentState,
    path: &Path,
    timeout: Duration,
) -> Result<StateWriter> {
    persist_state_in_background_with(state, path, timeout, |mut snapshot, path, sender| {
        thread::Builder::new()
            .name("idlepilot-state-writer".to_owned())
            .spawn(move || {
                let _ = sender.send(snapshot.store(&path));
            })
    })
}

fn persist_state_in_background_with<F>(
    state: &PersistentState,
    path: &Path,
    timeout: Duration,
    spawn: F,
) -> Result<StateWriter>
where
    F: FnOnce(
        PersistentState,
        std::path::PathBuf,
        mpsc::SyncSender<Result<()>>,
    ) -> std::io::Result<thread::JoinHandle<()>>,
{
    let snapshot = state.clone();
    let path = path.to_owned();
    let (sender, receiver) = mpsc::sync_channel(1);
    let handle = spawn(snapshot, path, sender).map_err(|error| {
        Error::io(
            ErrorKind::Os,
            "cannot start running-state writer thread",
            error,
        )
    })?;
    Ok(StateWriter {
        receiver,
        handle,
        deadline: Instant::now() + timeout,
        completed: false,
        timed_out: false,
    })
}

enum StateWriterFinish {
    Complete,
    TimedOut,
}

fn finish_state_writer(mut writer: StateWriter) -> Result<StateWriterFinish> {
    if writer.timed_out {
        return Ok(StateWriterFinish::TimedOut);
    }
    let mut write_result = Ok(());
    if !writer.completed {
        let remaining = writer.deadline.saturating_duration_since(Instant::now());
        match writer.receiver.recv_timeout(remaining) {
            Ok(result) => {
                writer.completed = true;
                write_result = result;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Ok(StateWriterFinish::TimedOut);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::new(
                    ErrorKind::Internal,
                    "running-state writer completed without a result",
                ));
            }
        }
    }
    writer
        .handle
        .join()
        .map_err(|_| Error::new(ErrorKind::Internal, "state writer thread panicked"))?;
    write_result?;
    Ok(StateWriterFinish::Complete)
}

fn state_writer_timeout() -> Error {
    Error::new(
        ErrorKind::State,
        "running state was not persisted within its bounded deadline",
    )
}

fn wait_interruptible(duration: Duration, active: bool) -> Option<i32> {
    let deadline = Instant::now() + duration;
    let maximum_step = if active {
        Duration::from_millis(100)
    } else {
        Duration::from_secs(1)
    };
    loop {
        if let Some(signal) = security::requested_termination_signal() {
            return Some(signal);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        thread::sleep((deadline - now).min(maximum_step));
    }
}

const fn outcome_reason(outcome: RunOutcome) -> &'static str {
    match outcome {
        RunOutcome::NotEligible => "not_eligible",
        RunOutcome::Completed => "completed",
        RunOutcome::Failed => "failed",
        RunOutcome::GuardLost => "guard_lost",
        RunOutcome::RuntimeLimit => "runtime_limit",
        RunOutcome::Shutdown(_) => "shutdown_signal",
        RunOutcome::AlreadyCompleted => "already_completed",
        RunOutcome::AttemptsExhausted => "attempts_exhausted",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct UnusedProbe;

    impl Probe for UnusedProbe {
        fn snapshot(&mut self) -> ConditionSnapshot {
            panic!("writer-start cleanup test never probes conditions")
        }
    }

    #[test]
    fn successful_exit_reaped_while_stopping_wins_over_the_stop_reason() {
        let completed = StopOutcome {
            term_sent: true,
            kill_sent: false,
            group_empty: true,
            leader_exit: Some(ActionExit {
                code: Some(0),
                signal: None,
                success: true,
            }),
            exit_timing: StopExitTiming::BeforeSignal,
            elapsed: Duration::ZERO,
        };

        assert!(matches!(
            classify_stop("running_window_changed", completed),
            MonitorOutcome::Exited(ActionExit {
                code: Some(0),
                signal: None,
                success: true
            })
        ));

        let interrupted = StopOutcome {
            exit_timing: StopExitTiming::AfterSignal,
            leader_exit: Some(ActionExit {
                code: None,
                signal: Some(security::SIGTERM),
                success: false,
            }),
            ..completed
        };
        assert!(matches!(
            classify_stop("shutdown_signal", interrupted),
            MonitorOutcome::Stopped("shutdown_signal", _)
        ));
    }

    #[test]
    fn state_writer_thread_start_failure_is_returned_after_action_cleanup() {
        let state_path = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!("writer-start-failure-{}.state", std::process::id()));
        let mut config = Config::new("writer-start-failure", "/usr/bin/sleep", &state_path)
            .expect("build action config");
        config.args.push("30".to_owned());
        let action = ActionProcess::spawn(&config).expect("spawn cleanup fixture");
        let action_pid = action.pid();
        let mut state = PersistentState {
            phase: Phase::Running,
            action_pid: Some(action_pid),
            action_pgid: Some(action.process_group()),
            action_start_ticks: action.start_ticks(),
            ..PersistentState::default()
        };
        let Err(writer_error) = persist_state_in_background_with(
            &state,
            &state_path,
            Duration::from_secs(1),
            |_, _, _| Err::<thread::JoinHandle<()>, _>(std::io::Error::from_raw_os_error(11)),
        ) else {
            panic!("injected state-writer spawn failure unexpectedly succeeded");
        };
        assert_eq!(writer_error.kind(), ErrorKind::Os);

        let mut supervisor = Supervisor::new(config, UnusedProbe, NullSink);
        supervisor.action_live = true;
        let error =
            supervisor.cleanup_after_state_writer_start_failure(&mut state, action, writer_error);

        assert_eq!(error.kind(), ErrorKind::Os);
        assert!(!error.requires_process_exit());
        assert!(!supervisor.action_live);
        assert!(!supervisor.process_exit_required);
        assert!(state.action_pid.is_none());
        assert!(state.action_pgid.is_none());
        assert!(state.action_start_ticks.is_none());
        assert_eq!(
            security::inspect_process_start_ticks(action_pid, Path::new("/proc"))
                .expect("inspect cleaned fixture"),
            None
        );
    }

    #[test]
    fn running_state_writer_deadline_fails_closed_while_io_is_pending() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            let _ = sender.send(Ok(()));
        });
        let mut writer = StateWriter {
            receiver,
            handle,
            deadline: Instant::now(),
            completed: false,
            timed_out: false,
        };
        let error = writer
            .poll()
            .expect_err("a pending writer at its deadline must fail closed");
        assert_eq!(error.kind(), ErrorKind::State);
        assert!(matches!(
            finish_state_writer(writer).expect("finish delayed writer"),
            StateWriterFinish::TimedOut
        ));
    }
}
