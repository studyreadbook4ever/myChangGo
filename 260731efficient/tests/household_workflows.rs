#![allow(missing_docs)]

mod common;

use common::{
    TestWorkspace, backup_config, flaky_config, snapshot, tree_config, wait_for_identity_records,
    wait_until_process_groups_absent, wait_until_processes_absent,
};
use idlepilot::conditions::{ConditionSnapshot, ConditionState, Probe};
use idlepilot::state::{PersistentState, Phase};
use idlepilot::supervisor::{NullSink, RunMode, RunOutcome, Supervisor};
use std::fmt::Write as _;
use std::fs;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const WINDOW_KEY: &str = "2026-212@01:00-03:00";
static WORKFLOW_LOCK: Mutex<()> = Mutex::new(());

fn workflow_guard() -> MutexGuard<'static, ()> {
    WORKFLOW_LOCK.lock().expect("household workflow test lock")
}

#[test]
#[ignore = "helper entrypoint launched explicitly by the integration test"]
fn fixture_entry() {
    common::fixture_entry();
}

#[derive(Default)]
struct EligibleProbe;

impl Probe for EligibleProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        snapshot(ConditionState::Met, "test_wifi_met")
    }
}

#[test]
fn household_backup_is_verified_atomically_published_and_runs_once_per_window() {
    let _guard = workflow_guard();
    let workspace = TestWorkspace::new("household-backup");
    let source = workspace.path("household-source");
    let publication = workspace.path("backups/2026-07-30");
    let identities_path = workspace.path("backup-identities");
    let files = [
        (
            "documents/budget.csv",
            b"month,power_kwh\n2026-07,287\n".as_slice(),
        ),
        ("notes.txt", b"router firmware checked\n".as_slice()),
        (
            "photos/index.txt",
            b"IMG_0001.jpg\nIMG_0002.jpg\n".as_slice(),
        ),
    ];
    for (relative, contents) in files {
        let path = source.join(relative);
        fs::create_dir_all(path.parent().expect("source file parent"))
            .expect("create deterministic source tree");
        fs::write(path, contents).expect("write deterministic source file");
    }

    let configuration = backup_config(
        &workspace,
        &source,
        &publication,
        &identities_path,
        "household-backup",
    );
    let state_path = configuration.state_file.clone();
    let mut supervisor = Supervisor::new(configuration.clone(), EligibleProbe, NullSink);
    assert_eq!(
        supervisor.run(RunMode::Once).expect("run household backup"),
        RunOutcome::Completed
    );

    let mut expected_manifest = String::new();
    for (relative, contents) in &files {
        writeln!(
            expected_manifest,
            "{}  {relative}",
            idlepilot::sha256::digest_bytes(contents)
        )
        .expect("write expected manifest");
    }
    assert_eq!(
        fs::read_to_string(publication.join("MANIFEST.sha256")).expect("read published manifest"),
        expected_manifest
    );
    for (relative, contents) in files {
        assert_eq!(
            fs::read(publication.join(relative)).expect("read published backup file"),
            contents
        );
    }
    assert!(
        fs::read_dir(publication.parent().expect("publication parent"))
            .expect("list publication parent")
            .all(|entry| !entry
                .expect("publication directory entry")
                .file_name()
                .to_string_lossy()
                .contains(".partial.")),
        "atomic publication must not leave a staging directory"
    );

    let identities = wait_for_identity_records(&identities_path, 1);
    assert_eq!(identities.len(), 1);
    assert_eq!(identities[0].role, "backup");
    wait_until_processes_absent(&identities);
    wait_until_process_groups_absent(&identities);

    let completed = PersistentState::load(&state_path).expect("load completed backup state");
    assert_eq!(completed.phase, Phase::Stopped);
    assert_eq!(completed.attempts, 1);
    assert_eq!(completed.attempt_window.as_deref(), Some(WINDOW_KEY));
    assert_eq!(completed.completed_window.as_deref(), Some(WINDOW_KEY));
    assert_eq!(completed.last_reason.as_deref(), Some("completed"));
    assert_eq!(completed.last_exit_code, Some(0));
    assert_eq!(completed.last_exit_signal, None);
    assert!(completed.action_pid.is_none());
    assert!(completed.action_pgid.is_none());

    let manifest_before = fs::read(publication.join("MANIFEST.sha256")).expect("snapshot manifest");
    let mut next_supervisor = Supervisor::new(configuration, EligibleProbe, NullSink);
    assert_eq!(
        next_supervisor
            .run(RunMode::Once)
            .expect("evaluate completed backup window"),
        RunOutcome::AlreadyCompleted
    );
    assert_eq!(
        fs::read(publication.join("MANIFEST.sha256")).expect("reread manifest"),
        manifest_before
    );
    assert_eq!(
        fs::read_to_string(&identities_path)
            .expect("read backup invocation records")
            .lines()
            .count(),
        1,
        "an already-completed window must not launch the backup again"
    );
}

#[test]
fn retryable_household_index_fails_once_then_succeeds_without_a_third_launch() {
    let _guard = workflow_guard();
    let workspace = TestWorkspace::new("flaky-household-index");
    let counter = workspace.path("index-attempts");
    let output = workspace.path("index/output.txt");
    let identities_path = workspace.path("index-identities");
    let mut configuration = flaky_config(
        &workspace,
        &counter,
        &output,
        &identities_path,
        "flaky-household-index",
    );
    configuration.retry_on_failure = true;
    configuration.max_attempts_per_window = 2;
    let state_path = configuration.state_file.clone();

    let mut first = Supervisor::new(configuration.clone(), EligibleProbe, NullSink);
    assert_eq!(
        first.run(RunMode::Once).expect("run first index attempt"),
        RunOutcome::Failed
    );
    assert_eq!(fs::read_to_string(&counter).expect("first counter"), "1\n");
    assert!(!output.exists(), "a failed attempt must not publish output");
    let first_identities = wait_for_identity_records(&identities_path, 1);
    wait_until_processes_absent(&first_identities);
    wait_until_process_groups_absent(&first_identities);

    let failed = PersistentState::load(&state_path).expect("load retryable failure state");
    assert_eq!(failed.phase, Phase::Stopped);
    assert_eq!(failed.attempts, 1);
    assert_eq!(failed.attempt_window.as_deref(), Some(WINDOW_KEY));
    assert_eq!(failed.completed_window, None);
    assert_eq!(failed.last_reason.as_deref(), Some("failed"));
    assert_eq!(failed.last_exit_code, Some(101));
    assert_eq!(failed.last_exit_signal, None);

    let mut second = Supervisor::new(configuration.clone(), EligibleProbe, NullSink);
    assert_eq!(
        second.run(RunMode::Once).expect("run second index attempt"),
        RunOutcome::Completed
    );
    assert_eq!(fs::read_to_string(&counter).expect("second counter"), "2\n");
    assert_eq!(
        fs::read(&output).expect("published index output"),
        b"household-index-ready\n"
    );
    let all_identities = wait_for_identity_records(&identities_path, 2);
    assert_eq!(
        all_identities
            .iter()
            .map(|identity| identity.role.as_str())
            .collect::<Vec<_>>(),
        ["flaky", "flaky"]
    );
    wait_until_processes_absent(&all_identities);
    wait_until_process_groups_absent(&all_identities);

    let completed = PersistentState::load(&state_path).expect("load successful retry state");
    assert_eq!(completed.phase, Phase::Stopped);
    assert_eq!(completed.attempts, 2);
    assert_eq!(completed.completed_window.as_deref(), Some(WINDOW_KEY));
    assert_eq!(completed.last_reason.as_deref(), Some("completed"));
    assert_eq!(completed.last_exit_code, Some(0));
    assert_eq!(completed.last_exit_signal, None);

    let mut third = Supervisor::new(configuration, EligibleProbe, NullSink);
    assert_eq!(
        third
            .run(RunMode::Once)
            .expect("evaluate completed retry window"),
        RunOutcome::AlreadyCompleted
    );
    assert_eq!(
        fs::read_to_string(&counter).expect("counter after completed-window evaluation"),
        "2\n"
    );
    assert_eq!(
        fs::read_to_string(&identities_path)
            .expect("index invocation records")
            .lines()
            .count(),
        2,
        "successful retry must suppress a third process launch"
    );
}

#[test]
fn runtime_limit_stops_the_whole_household_index_process_tree() {
    let _guard = workflow_guard();
    let workspace = TestWorkspace::new("household-index-runtime-limit");
    let identities_path = workspace.path("tree-identities");
    let heartbeat_path = workspace.path("tree-heartbeat");
    let mut configuration = tree_config(
        &workspace,
        &identities_path,
        &heartbeat_path,
        "household-index-runtime-limit",
    );
    configuration
        .environment
        .insert("IDLEPILOT_TEST_IGNORE_TERM".to_owned(), "0".to_owned());
    configuration
        .environment
        .insert("IDLEPILOT_TEST_GRACEFUL_TERM".to_owned(), "1".to_owned());
    configuration.max_runtime = Some(Duration::from_secs(1));
    let state_path = configuration.state_file.clone();

    let started = Instant::now();
    let mut supervisor = Supervisor::new(configuration.clone(), EligibleProbe, NullSink);
    assert_eq!(
        supervisor
            .run(RunMode::Once)
            .expect("run bounded household index"),
        RunOutcome::RuntimeLimit
    );
    let elapsed = started.elapsed();
    // The full run includes the one-second runtime plus durable state fsync,
    // whose documented fail-closed deadline is fifteen seconds on slow home
    // storage, as well as bounded process cleanup.
    assert!(
        elapsed < Duration::from_secs(20),
        "runtime-limit run should remain bounded; elapsed={elapsed:?}"
    );

    let identities = wait_for_identity_records(&identities_path, 3);
    assert_eq!(
        identities
            .iter()
            .map(|identity| identity.role.as_str())
            .collect::<Vec<_>>(),
        ["leader", "child", "grandchild"]
    );
    assert!(
        identities
            .iter()
            .all(|identity| identity.group == identities[0].group),
        "the indexer descendants must remain in the supervised process group"
    );
    wait_until_processes_absent(&identities);
    wait_until_process_groups_absent(&identities);
    let heartbeat_after_stop = fs::read(&heartbeat_path).expect("read stopped heartbeat");
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        fs::read(&heartbeat_path).expect("reread stopped heartbeat"),
        heartbeat_after_stop,
        "no descendant may continue work after runtime-limit cleanup"
    );

    let stopped = PersistentState::load(&state_path).expect("load runtime-limit state");
    assert_eq!(stopped.phase, Phase::Stopped);
    assert_eq!(stopped.attempts, 1);
    assert_eq!(stopped.attempt_window.as_deref(), Some(WINDOW_KEY));
    assert_eq!(stopped.completed_window.as_deref(), Some(WINDOW_KEY));
    assert_eq!(stopped.last_reason.as_deref(), Some("runtime_limit"));
    assert!(stopped.action_pid.is_none());
    assert!(stopped.action_pgid.is_none());

    let mut next = Supervisor::new(configuration, EligibleProbe, NullSink);
    assert_eq!(
        next.run(RunMode::Once)
            .expect("evaluate runtime-limited completed window"),
        RunOutcome::AlreadyCompleted
    );
    assert_eq!(
        fs::read_to_string(&identities_path)
            .expect("tree invocation records")
            .lines()
            .count(),
        3,
        "a runtime-limited window must not launch another process tree"
    );
}
