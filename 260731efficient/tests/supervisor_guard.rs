#![allow(missing_docs)]

mod common;

use common::{
    TestWorkspace, backup_config, literal_config, snapshot, tree_config, wait_for_identity_records,
    wait_until_processes_absent,
};
use idlepilot::Result;
use idlepilot::conditions::{ConditionSnapshot, ConditionState, Probe};
use idlepilot::state::{PersistentState, Phase};
use idlepilot::supervisor::{
    Event, EventKind, EventSink, NullSink, RunMode, RunOutcome, Supervisor,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

static PERSISTENCE_FAILURE_LOCK: Mutex<()> = Mutex::new(());

#[test]
#[ignore = "helper entrypoint launched explicitly by the integration test"]
fn fixture_entry() {
    common::fixture_entry();
}

struct PostSpawnLossProbe {
    calls: usize,
    loss: ConditionState,
    identities: PathBuf,
}

impl Probe for PostSpawnLossProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        self.calls += 1;
        if self.calls <= 3 {
            return snapshot(ConditionState::Met, "test_wifi_met");
        }

        // The fourth query is Supervisor's immediate post-spawn guard. Waiting
        // for all records makes the assertion prove a real live process tree
        // was stopped, rather than merely racing exec before it initialized.
        let _ = wait_for_identity_records(&self.identities, 3);
        match self.loss {
            ConditionState::NotMet => snapshot(ConditionState::NotMet, "test_wifi_disconnected"),
            ConditionState::Unknown => snapshot(ConditionState::Unknown, "test_wifi_unknown"),
            ConditionState::Met => unreachable!("test probe requires a guard loss"),
        }
    }
}

struct FinalGuardLossProbe {
    calls: usize,
}

struct ExitDuringPostSpawnProbe {
    calls: usize,
    output: PathBuf,
}

impl Probe for ExitDuringPostSpawnProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        self.calls += 1;
        if self.calls <= 3 {
            return snapshot(ConditionState::Met, "test_wifi_met");
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.output.exists() {
            assert!(
                Instant::now() < deadline,
                "short action did not publish output"
            );
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_millis(50));
        snapshot(ConditionState::NotMet, "post_spawn_guard_changed")
    }
}

struct ExitDuringGuardWaitProbe {
    calls: usize,
    output: PathBuf,
}

impl Probe for ExitDuringGuardWaitProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        self.calls += 1;
        if self.calls <= 4 {
            snapshot(ConditionState::Met, "test_wifi_met")
        } else {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !self.output.exists() {
                assert!(
                    Instant::now() < deadline,
                    "delayed action did not publish output"
                );
                thread::sleep(Duration::from_millis(5));
            }
            thread::sleep(Duration::from_millis(50));
            snapshot(ConditionState::NotMet, "guard_changed_after_exit")
        }
    }
}

#[test]
fn completed_exit_wins_over_a_post_spawn_guard_change() {
    let workspace = TestWorkspace::new("post-spawn-exit-wins");
    let output = workspace.path("literal-output");
    let mut configuration = literal_config(
        &workspace,
        &output,
        "completed-once",
        "post-spawn-exit-wins",
    );
    configuration.retry_after_guard_loss = true;
    configuration.max_attempts_per_window = 2;
    let state_path = configuration.state_file.clone();
    let sink = RecordingSink::default();
    let event_view = Arc::clone(&sink.events);
    let mut supervisor = Supervisor::new(
        configuration.clone(),
        ExitDuringPostSpawnProbe {
            calls: 0,
            output: output.clone(),
        },
        sink,
    );

    assert_eq!(
        supervisor.run(RunMode::Once).expect("post-spawn result"),
        RunOutcome::Completed
    );
    let state = PersistentState::load(&state_path).expect("load completed state");
    assert_eq!(state.last_exit_code, Some(0));
    assert!(state.completed_window.is_some());
    let events = event_view.lock().expect("event lock");
    assert!(
        events.iter().any(
            |event| event.kind == EventKind::ActionExited && event.reason == "action_completed"
        )
    );
    assert!(
        events.iter().all(|event| !matches!(
            event.kind,
            EventKind::ActionStopping | EventKind::ActionStopped
        )),
        "a pre-signal natural exit must not be reported as stopped: {events:?}"
    );
    drop(events);

    let mut restart = Supervisor::new(
        configuration,
        ExitDuringGuardWaitProbe {
            calls: 0,
            output: output.clone(),
        },
        NullSink,
    );
    assert_eq!(
        restart.run(RunMode::Once).expect("completed restart"),
        RunOutcome::AlreadyCompleted
    );
}

#[test]
fn completed_exit_wins_over_a_guard_change_after_the_guard_wait() {
    let workspace = TestWorkspace::new("guard-wait-exit-wins");
    let output = workspace.path("literal-output");
    let mut configuration = literal_config(
        &workspace,
        &output,
        "completed-once",
        "guard-wait-exit-wins",
    );
    configuration
        .environment
        .insert("IDLEPILOT_TEST_DELAY_MS".to_owned(), "40".to_owned());
    configuration.retry_after_guard_loss = true;
    configuration.max_attempts_per_window = 2;
    let state_path = configuration.state_file.clone();
    let mut supervisor = Supervisor::new(
        configuration.clone(),
        ExitDuringGuardWaitProbe {
            calls: 0,
            output: output.clone(),
        },
        NullSink,
    );

    assert_eq!(
        supervisor.run(RunMode::Once).expect("guard-wait result"),
        RunOutcome::Completed
    );
    assert_eq!(
        fs::read_to_string(&output).expect("action output"),
        "completed-once"
    );
    let state = PersistentState::load(&state_path).expect("load completed state");
    assert_eq!(state.last_exit_code, Some(0));
    assert!(state.completed_window.is_some());

    let mut restart = Supervisor::new(
        configuration,
        ExitDuringGuardWaitProbe { calls: 0, output },
        NullSink,
    );
    assert_eq!(
        restart.run(RunMode::Once).expect("completed restart"),
        RunOutcome::AlreadyCompleted
    );
}

impl Probe for FinalGuardLossProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        self.calls += 1;
        if self.calls <= 2 {
            snapshot(ConditionState::Met, "test_wifi_met")
        } else {
            snapshot(ConditionState::NotMet, "final_guard_lost")
        }
    }
}

#[test]
fn final_guard_loss_consumes_durable_attempt_without_executing_action() {
    let workspace = TestWorkspace::new("final-guard-loss");
    let output = workspace.path("must-not-exist");
    let configuration = literal_config(&workspace, &output, "must-not-run", "final-guard-loss");
    let state_file = configuration.state_file.clone();
    let mut supervisor = Supervisor::new(configuration, FinalGuardLossProbe { calls: 0 }, NullSink);

    assert_eq!(
        supervisor.run(RunMode::Once).expect("final guard decision"),
        RunOutcome::NotEligible
    );
    assert!(
        !output.exists(),
        "action ran after its final guard was lost"
    );

    let state = PersistentState::load(&state_file).expect("load final state");
    assert_eq!(state.attempts, 1);
    assert!(state.attempt_window.is_some());
    assert!(state.action_pid.is_none());
    assert!(state.action_pgid.is_none());
}

#[test]
fn unresolved_launch_intent_blocks_restart_before_another_action_can_run() {
    let workspace = TestWorkspace::new("unresolved-launch-intent");
    let output = workspace.path("must-not-exist");
    let configuration = literal_config(
        &workspace,
        &output,
        "must-not-run",
        "unresolved-launch-intent",
    );
    let fingerprint = configuration
        .state_fingerprint()
        .expect("configuration fingerprint");
    let mut state = PersistentState {
        config_fingerprint: Some(fingerprint),
        daemon_pid: Some(std::process::id()),
        daemon_start_ticks: Some(
            idlepilot::security::process_start_ticks(
                std::process::id(),
                std::path::Path::new("/proc"),
            )
            .expect("current process identity"),
        ),
        phase: Phase::Qualifying,
        window_key: Some("2026-211".to_owned()),
        attempt_window: Some("2026-211".to_owned()),
        attempts: 1,
        last_reason: Some("launch_intent_persisted".to_owned()),
        ..PersistentState::default()
    };
    state
        .store(&configuration.state_file)
        .expect("persist simulated interrupted launch intent");

    let mut supervisor = Supervisor::new(configuration, FinalGuardLossProbe { calls: 0 }, NullSink);
    let error = supervisor
        .run(RunMode::Once)
        .expect_err("unresolved launch intent must fail closed");

    assert_eq!(error.kind(), idlepilot::error::ErrorKind::Security);
    assert!(
        error.to_string().contains("unresolved launch intent"),
        "unexpected recovery error: {error}"
    );
    assert!(!error.requires_process_exit());
    assert!(!output.exists(), "restart launched a duplicate action");
}

#[test]
fn dead_recorded_action_without_a_terminal_result_blocks_duplicate_launch() {
    let workspace = TestWorkspace::new("dead-recorded-action");
    let output = workspace.path("must-not-exist");
    let configuration = literal_config(&workspace, &output, "must-not-run", "dead-recorded-action");
    let fingerprint = configuration
        .state_fingerprint()
        .expect("configuration fingerprint");
    let impossible_pid = i32::MAX as u32;
    let mut state = PersistentState {
        config_fingerprint: Some(fingerprint),
        phase: Phase::Running,
        attempt_window: Some("2026-211@01:00-03:00".to_owned()),
        attempts: 1,
        action_pid: Some(impossible_pid),
        action_pgid: Some(i32::MAX),
        action_start_ticks: Some(1),
        last_reason: Some("action_started".to_owned()),
        ..PersistentState::default()
    };
    state
        .store(&configuration.state_file)
        .expect("persist simulated dead action identity");

    let mut supervisor = Supervisor::new(configuration, DatedProbe { year_day: 211 }, NullSink);
    let error = supervisor
        .run(RunMode::Once)
        .expect_err("ambiguous terminal result must fail closed");

    assert_eq!(error.kind(), idlepilot::error::ErrorKind::Security);
    assert!(
        error.to_string().contains("durable terminal result"),
        "unexpected recovery error: {error}"
    );
    assert!(!output.exists(), "restart launched a duplicate action");
}

#[derive(Clone, Default)]
struct RecordingSink {
    events: Arc<Mutex<Vec<Event>>>,
}

impl EventSink for RecordingSink {
    fn emit(&mut self, event: &Event) -> Result<()> {
        self.events.lock().expect("event lock").push(event.clone());
        Ok(())
    }
}

struct FailFirstDeferredStart {
    failed: bool,
}

impl EventSink for FailFirstDeferredStart {
    fn emit(&mut self, event: &Event) -> Result<()> {
        if event.kind == EventKind::ActionStarted && !self.failed {
            self.failed = true;
            return Err(idlepilot::error::Error::new(
                idlepilot::error::ErrorKind::Os,
                "intentional deferred event failure",
            ));
        }
        Ok(())
    }
}

#[test]
fn deferred_event_failure_after_action_exit_persists_a_restart_fence() {
    let _guard = PERSISTENCE_FAILURE_LOCK
        .lock()
        .expect("persistence failure test lock");
    let workspace = TestWorkspace::new("deferred-event-failure");
    let source = workspace.path("source");
    let publication = workspace.path("publication/backup");
    let identities_path = workspace.path("backup-identities");
    fs::create_dir_all(&source).expect("create backup source");
    fs::write(
        source.join("settings.txt"),
        b"verified household settings\n",
    )
    .expect("write backup source");
    let configuration = backup_config(
        &workspace,
        &source,
        &publication,
        &identities_path,
        "deferred-event-failure",
    );
    let state_path = configuration.state_file.clone();
    let mut first = Supervisor::new(
        configuration.clone(),
        DatedProbe { year_day: 211 },
        FailFirstDeferredStart { failed: false },
    );

    let error = first
        .run(RunMode::Once)
        .expect_err("deferred sink failure must be reported");
    assert_eq!(error.kind(), idlepilot::error::ErrorKind::Os);
    assert!(publication.is_dir(), "the reviewed action did complete");
    let identities = wait_for_identity_records(&identities_path, 1);
    wait_until_processes_absent(&identities);

    let state = PersistentState::load(&state_path).expect("load durable restart fence");
    assert_eq!(state.phase, Phase::Fault);
    assert!(state.completed_window.is_some());
    assert!(state.action_pid.is_none());
    assert!(state.action_pgid.is_none());

    let mut restart = Supervisor::new(configuration, DatedProbe { year_day: 211 }, NullSink);
    let restart_error = restart
        .run(RunMode::Once)
        .expect_err("fault state must block a possible duplicate");
    assert_eq!(restart_error.kind(), idlepilot::error::ErrorKind::Security);
    assert!(restart_error.to_string().contains("fault state"));
    assert_eq!(
        fs::read_to_string(&identities_path)
            .expect("read action identities")
            .lines()
            .count(),
        1,
        "event delivery failure must not repeat the side effect"
    );
}

#[test]
fn immediate_post_spawn_not_met_and_unknown_both_stop_fail_closed() {
    for (suffix, loss, reason) in [
        ("not-met", ConditionState::NotMet, "test_wifi_disconnected"),
        ("unknown", ConditionState::Unknown, "test_wifi_unknown"),
    ] {
        let workspace = TestWorkspace::new(suffix);
        let identities_path = workspace.path("identities");
        let heartbeat_path = workspace.path("heartbeat");
        let configuration = tree_config(&workspace, &identities_path, &heartbeat_path, suffix);
        let state_path = configuration.state_file.clone();
        let probe = PostSpawnLossProbe {
            calls: 0,
            loss,
            identities: identities_path.clone(),
        };
        let sink = RecordingSink::default();
        let event_view = Arc::clone(&sink.events);
        let mut supervisor = Supervisor::new(configuration, probe, sink);

        let outcome = supervisor
            .run(RunMode::Once)
            .expect("supervisor should stop safely");
        assert_eq!(outcome, RunOutcome::GuardLost);

        let identities = wait_for_identity_records(&identities_path, 3);
        wait_until_processes_absent(&identities);
        let events = event_view.lock().expect("event lock");
        let started = events
            .iter()
            .find(|event| {
                event.kind == EventKind::ActionStarted && event.reason == "action_started"
            })
            .expect("action-started event");
        assert_eq!(started.name, suffix);
        assert_eq!(
            started.action_pid.and_then(|pid| i32::try_from(pid).ok()),
            started.action_pgid
        );
        assert!(started.window_key.is_some());
        assert!(
            events
                .iter()
                .any(|event| event.kind == EventKind::ActionStopping
                    && event.reason == reason
                    && event.name == suffix
                    && event.action_pid == started.action_pid
                    && event.action_pgid == started.action_pgid
                    && event.window_key == started.window_key),
            "missing fail-closed stopping event in {events:?}"
        );
        let stopped_index = events
            .iter()
            .position(|event| {
                event.kind == EventKind::ActionStopped
                    && event.reason == reason
                    && event.name == suffix
                    && event.action_pid == started.action_pid
                    && event.action_pgid == started.action_pgid
                    && event.window_key == started.window_key
            })
            .unwrap_or_else(|| panic!("missing fail-closed stopped event in {events:?}"));
        let final_phase_index = events
            .iter()
            .position(|event| {
                event.kind == EventKind::Phase
                    && event.phase == Phase::Completed
                    && event.reason == reason
                    && event.action_pid.is_none()
                    && event.action_pgid.is_none()
            })
            .unwrap_or_else(|| panic!("missing durable final phase event in {events:?}"));
        assert!(
            final_phase_index > stopped_index,
            "final phase must follow the deferred stop audit events: {events:?}"
        );
        drop(events);

        let state = PersistentState::load(&state_path).expect("load final supervisor state");
        assert_eq!(state.phase, Phase::Stopped);
        assert_eq!(state.last_reason.as_deref(), Some("guard_lost"));
        assert!(state.daemon_pid.is_none());
        assert!(state.action_pid.is_none());
        assert!(state.action_pgid.is_none());
        assert!(state.completed_window.is_some());
    }
}

struct ExternallyTrippedProbe {
    loss_requested: Arc<AtomicBool>,
}

impl Probe for ExternallyTrippedProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        if self.loss_requested.load(Ordering::SeqCst) {
            snapshot(ConditionState::NotMet, "periodic_wifi_loss")
        } else {
            snapshot(ConditionState::Met, "test_wifi_met")
        }
    }
}

struct BlockingActionStartedSink {
    loss_requested: Arc<AtomicBool>,
}

impl EventSink for BlockingActionStartedSink {
    fn emit(&mut self, event: &Event) -> Result<()> {
        if event.kind == EventKind::ActionStarted {
            while !self.loss_requested.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            thread::sleep(Duration::from_millis(800));
        }
        Ok(())
    }
}

#[test]
fn periodic_guard_hard_stops_before_a_slow_event_sink_can_block() {
    let workspace = TestWorkspace::new("periodic-loss");
    let identities_path = workspace.path("identities");
    let heartbeat_path = workspace.path("heartbeat");
    let configuration = tree_config(
        &workspace,
        &identities_path,
        &heartbeat_path,
        "periodic-loss",
    );
    let loss_requested = Arc::new(AtomicBool::new(false));
    let probe = ExternallyTrippedProbe {
        loss_requested: Arc::clone(&loss_requested),
    };
    let sink = BlockingActionStartedSink {
        loss_requested: Arc::clone(&loss_requested),
    };
    let supervisor_thread = thread::spawn(move || {
        let mut supervisor = Supervisor::new(configuration, probe, sink);
        supervisor.run(RunMode::Once)
    });

    let identities = wait_for_identity_records(&identities_path, 3);
    let loss_observed = Instant::now();
    loss_requested.store(true, Ordering::SeqCst);
    wait_until_processes_absent(&identities);
    let latency = loss_observed.elapsed();
    assert!(
        latency < Duration::from_millis(500),
        "hard stop was delayed by {latency:?}"
    );
    assert_eq!(
        supervisor_thread
            .join()
            .expect("supervisor thread")
            .expect("supervisor result"),
        RunOutcome::GuardLost
    );
}

struct StatePersistenceFailureProbe {
    calls: usize,
    identities: PathBuf,
    state_file: PathBuf,
}

impl Probe for StatePersistenceFailureProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        self.calls += 1;
        if self.calls == 4 {
            let _ = wait_for_identity_records(&self.identities, 3);
            fs::set_permissions(&self.state_file, fs::Permissions::from_mode(0o644))
                .expect("make running-state persistence fail");
        }
        snapshot(ConditionState::Met, "test_wifi_met")
    }
}

#[test]
fn running_state_persistence_failure_hard_stops_the_action_tree() {
    let _guard = PERSISTENCE_FAILURE_LOCK
        .lock()
        .expect("persistence failure test lock");
    let workspace = TestWorkspace::new("state-persistence-failure");
    let identities_path = workspace.path("identities");
    let heartbeat_path = workspace.path("heartbeat");
    let configuration = tree_config(
        &workspace,
        &identities_path,
        &heartbeat_path,
        "state-persistence-failure",
    );
    let state_file = configuration.state_file.clone();
    let probe = StatePersistenceFailureProbe {
        calls: 0,
        identities: identities_path.clone(),
        state_file: state_file.clone(),
    };
    let mut supervisor = Supervisor::new(configuration, probe, NullSink);
    let started = Instant::now();
    let error = supervisor
        .run(RunMode::Once)
        .expect_err("unsafe state destination must fail closed");
    assert!(
        matches!(
            error.kind(),
            idlepilot::error::ErrorKind::Security | idlepilot::error::ErrorKind::State
        ),
        "unexpected error: {error}"
    );
    // This end-to-end interval includes fixture-tree startup, three identity
    // records, synchronous launch-intent fsync, writer failure detection, and
    // bounded group cleanup. Keep a coarse hang detector without making slow
    // CI storage look like a supervision failure.
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "state persistence failure path exceeded its end-to-end test bound"
    );
    let identities = wait_for_identity_records(&identities_path, 3);
    wait_until_processes_absent(&identities);
    fs::set_permissions(&state_file, fs::Permissions::from_mode(0o600))
        .expect("restore state permissions");
    let persisted =
        PersistentState::load_for_control(&state_file).expect("load durable launch intent");
    assert_eq!(persisted.attempts, 1);
    assert!(persisted.action_pid.is_none());
    assert_eq!(
        persisted.last_reason.as_deref(),
        Some("launch_intent_persisted")
    );
}

struct DatedProbe {
    year_day: u16,
}

impl Probe for DatedProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        let mut value = snapshot(ConditionState::Met, "test_wifi_met");
        value.local_time.as_mut().expect("local time").year_day = self.year_day;
        value
    }
}

#[test]
fn completed_window_survives_multi_day_clock_rollback() {
    let workspace = TestWorkspace::new("clock-rollback");
    let output = workspace.path("literal-output");
    let configuration = literal_config(&workspace, &output, "ok", "clock-rollback");

    for day in [211, 212] {
        let mut supervisor = Supervisor::new(
            configuration.clone(),
            DatedProbe { year_day: day },
            NullSink,
        );
        assert_eq!(
            supervisor.run(RunMode::Once).expect("completed run"),
            RunOutcome::Completed
        );
    }

    let mut rolled_back = Supervisor::new(configuration, DatedProbe { year_day: 211 }, NullSink);
    assert_eq!(
        rolled_back.run(RunMode::Once).expect("rollback decision"),
        RunOutcome::AlreadyCompleted
    );
}
