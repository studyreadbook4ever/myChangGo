#![allow(missing_docs)]

mod common;

use common::{
    TestWorkspace, literal_config, tree_config, wait_for_identity_records,
    wait_until_processes_absent,
};
use idlepilot::{ActionProcess, StopExitTiming};
use std::fs;
use std::thread;
use std::time::{Duration, Instant};

#[test]
#[ignore = "helper entrypoint launched explicitly by the integration test"]
fn fixture_entry() {
    common::fixture_entry();
}

#[test]
fn term_then_kill_removes_the_entire_dedicated_process_group() {
    let workspace = TestWorkspace::new("process-group");
    let identities_path = workspace.path("identities");
    let heartbeat_path = workspace.path("heartbeat");
    let configuration = tree_config(
        &workspace,
        &identities_path,
        &heartbeat_path,
        "process-group",
    );

    let mut action = ActionProcess::spawn(&configuration).expect("spawn fixture tree");
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
            .all(|identity| identity.group == action.process_group()),
        "all descendants must inherit the dedicated PGID: {identities:?}"
    );
    assert_eq!(identities[1].parent, identities[0].pid);
    assert_eq!(identities[2].parent, identities[1].pid);

    let outcome = action
        .stop(Duration::from_millis(120))
        .expect("stop fixture process group");
    assert!(outcome.term_sent, "SIGTERM must be attempted");
    assert!(
        outcome.kill_sent,
        "SIGKILL must follow because every fixture node ignores SIGTERM"
    );
    assert!(
        outcome.group_empty,
        "the process group must be proven empty"
    );
    assert_eq!(outcome.exit_timing, StopExitTiming::AfterSignal);
    assert!(outcome.leader_exit.is_some_and(|exit| !exit.success));
    wait_until_processes_absent(&identities);
}

#[test]
fn shell_metacharacters_are_delivered_as_one_literal_argument() {
    let workspace = TestWorkspace::new("literal-argument");
    let output = workspace.path("argument");
    let expansion_marker = workspace.path("must-not-exist");
    let payload = format!(
        "spaces ; $(/usr/bin/touch {}) && * ? `false`\nsecond-line",
        expansion_marker.display()
    );
    let configuration = literal_config(&workspace, &output, &payload, "literal-argument");

    let mut action = ActionProcess::spawn(&configuration).expect("spawn argument recorder");
    let deadline = Instant::now() + Duration::from_secs(3);
    let exit = loop {
        if let Some(exit) = action
            .poll(Duration::from_millis(100))
            .expect("poll argument recorder")
        {
            break exit;
        }
        assert!(Instant::now() < deadline, "argument recorder did not exit");
        thread::sleep(Duration::from_millis(10));
    };

    assert!(
        exit.success,
        "argument recorder must exit cleanly: {exit:?}"
    );
    assert_eq!(
        fs::read(&output).expect("read recorded argument"),
        payload.as_bytes()
    );
    assert!(
        !expansion_marker.exists(),
        "shell command substitution must never be evaluated"
    );
}
