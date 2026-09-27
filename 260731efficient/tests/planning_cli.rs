#![allow(missing_docs)]

mod common;

use common::TestWorkspace;
use idlepilot::config::Config;
use idlepilot::state::{PersistentState, Phase};
use std::fs;
use std::path::Path;
use std::process::{Command, Output};

fn invoke(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .args(arguments)
        .output()
        .expect("run idlepilot")
}

fn current_window() -> String {
    let output = Command::new("/usr/bin/date")
        .arg("+%H:%M")
        .output()
        .expect("query local wall clock");
    assert!(output.status.success());
    let value = String::from_utf8(output.stdout).expect("UTF-8 date output");
    let (hour, minute) = value.trim().split_once(':').expect("HH:MM output");
    let now = hour.parse::<u16>().expect("hour") * 60 + minute.parse::<u16>().expect("minute");
    let start = (now + 1_439) % 1_440;
    let end = (now + 5) % 1_440;
    format!(
        "{:02}:{:02}-{:02}:{:02}",
        start / 60,
        start % 60,
        end / 60,
        end % 60
    )
}

fn initialize(workspace: &TestWorkspace, label: &str) -> (String, String) {
    let config = workspace.path(&format!("config/{label}.conf"));
    let state = workspace.path(&format!("state/{label}.state"));
    let window = current_window();
    let output = invoke(&[
        "init",
        "--config",
        config.to_str().expect("UTF-8 config path"),
        "--executable",
        "/usr/bin/true",
        "--working-directory",
        "/usr/bin",
        "--state-file",
        state.to_str().expect("UTF-8 state path"),
        "--name",
        label,
        "--window",
        &window,
        "--wifi",
        "disabled",
        "--power",
        "ignore",
        "--idle",
        "disabled",
        "--idle-seconds",
        "0",
        "--start-stability-seconds",
        "0",
        "--poll-seconds",
        "10",
        "--guard-milliseconds",
        "100",
        "--stop-grace-seconds",
        "1",
        "--max-runtime-seconds",
        "10",
    ]);
    assert!(
        output.status.success(),
        "init failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    (
        config.to_str().expect("UTF-8 config path").to_owned(),
        state.to_str().expect("UTF-8 state path").to_owned(),
    )
}

#[test]
fn plan_explains_ready_then_completed_without_launching_twice() {
    let workspace = TestWorkspace::new("planning-ready-completed");
    let (config, _) = initialize(&workspace, "daily-household-task");

    let ready = invoke(&["plan", "--config", &config]);
    assert_eq!(ready.status.code(), Some(0));
    let ready_json = String::from_utf8(ready.stdout).expect("UTF-8 ready plan");
    for expected in [
        "\"status\":\"ready\"",
        "\"decision\":\"ready\"",
        "\"would_launch\":true",
        "\"artifact\":\"verified\"",
        "\"attempts\":0",
    ] {
        assert!(
            ready_json.contains(expected),
            "missing {expected}: {ready_json}"
        );
    }

    let run = invoke(&["run", "--config", &config, "--once"]);
    assert_eq!(
        run.status.code(),
        Some(0),
        "run failed: {}",
        String::from_utf8_lossy(&run.stdout)
    );

    let completed = invoke(&["plan", "--config", &config]);
    assert_eq!(completed.status.code(), Some(3));
    let completed_json = String::from_utf8(completed.stdout).expect("UTF-8 completed plan");
    assert!(completed_json.contains("\"decision\":\"already_completed\""));
    assert!(completed_json.contains("\"would_launch\":false"));
    assert!(completed_json.contains("\"attempts\":1"));

    let status = invoke(&["status", "--config", &config]);
    assert_eq!(status.status.code(), Some(0));
    let status_json = String::from_utf8(status.stdout).expect("UTF-8 status");
    assert!(status_json.contains("\"last_exit_code\":0"));
    assert!(status_json.contains("\"action_status\":\"none\""));
    assert!(status_json.contains("\"attention_required\":false"));
}

#[test]
fn plan_fails_closed_on_an_executable_digest_mismatch() {
    let workspace = TestWorkspace::new("planning-digest-mismatch");
    let (config, state) = initialize(&workspace, "digest-mismatch");
    let contents = fs::read_to_string(&config).expect("read initialized config");
    let digest_line = contents
        .lines()
        .find(|line| line.starts_with("executable_sha256 = "))
        .expect("digest line");
    let modified = contents.replacen(
        digest_line,
        &format!("executable_sha256 = {}", "0".repeat(64)),
        1,
    );
    fs::write(&config, modified).expect("replace executable pin");

    let plan = invoke(&["plan", "--config", &config]);
    assert_eq!(plan.status.code(), Some(5));
    let response = String::from_utf8(plan.stdout).expect("UTF-8 mismatch plan");
    assert!(response.contains("\"status\":\"attention\""));
    assert!(response.contains("\"decision\":\"artifact_mismatch\""));
    assert!(response.contains("\"attention_required\":true"));
    assert!(response.contains("\"would_launch\":false"));
    assert!(!std::path::Path::new(&state).exists());
}

#[test]
fn status_and_plan_surface_ambiguous_action_and_fault_recovery() {
    let workspace = TestWorkspace::new("planning-recovery-required");
    let (config_path, state_path) = initialize(&workspace, "recovery-required");
    let configuration =
        Config::load_secure(Path::new(&config_path)).expect("load initialized configuration");
    let fingerprint = configuration
        .state_fingerprint()
        .expect("configuration fingerprint");
    let mut state = PersistentState {
        config_fingerprint: Some(fingerprint),
        phase: Phase::Running,
        action_pid: Some(i32::MAX as u32),
        action_pgid: Some(i32::MAX),
        action_start_ticks: Some(1),
        last_reason: Some("action_started".to_owned()),
        ..PersistentState::default()
    };
    state
        .store(Path::new(&state_path))
        .expect("persist ambiguous action state");

    let status = invoke(&["status", "--config", &config_path]);
    assert_eq!(status.status.code(), Some(0));
    let status_json = String::from_utf8(status.stdout).expect("UTF-8 status");
    assert!(status_json.contains("\"action_status\":\"terminal_result_unknown\""));
    assert!(status_json.contains("\"action_alive\":false"));
    assert!(status_json.contains("\"attention_required\":true"));

    let plan = invoke(&["plan", "--config", &config_path]);
    assert_eq!(plan.status.code(), Some(5));
    let plan_json = String::from_utf8(plan.stdout).expect("UTF-8 plan");
    assert!(plan_json.contains("\"decision\":\"recovery_required\""));
    assert!(plan_json.contains("\"attention_required\":true"));

    let current_pid = std::process::id();
    let current_ticks = idlepilot::security::process_start_ticks(current_pid, Path::new("/proc"))
        .expect("current process identity");
    state.action_pid = Some(current_pid);
    state.action_pgid = Some(i32::try_from(current_pid).expect("test PID fits i32"));
    state.action_start_ticks = Some(current_ticks.saturating_add(1));
    state
        .store(Path::new(&state_path))
        .expect("persist reused PID state");
    let reused_status = invoke(&["status", "--config", &config_path]);
    assert_eq!(reused_status.status.code(), Some(0));
    let reused_json = String::from_utf8(reused_status.stdout).expect("UTF-8 reused PID status");
    assert!(reused_json.contains("\"action_status\":\"pid_reused\""));
    assert!(reused_json.contains("\"action_alive\":false"));
    assert!(reused_json.contains("\"attention_required\":true"));

    state.phase = Phase::Fault;
    state.action_pid = None;
    state.action_pgid = None;
    state.action_start_ticks = None;
    state.last_reason = Some("supervisor_error".to_owned());
    state
        .store(Path::new(&state_path))
        .expect("persist fault state");

    let fault_status = invoke(&["status", "--config", &config_path]);
    assert_eq!(fault_status.status.code(), Some(0));
    let fault_status_json = String::from_utf8(fault_status.stdout).expect("UTF-8 fault status");
    assert!(fault_status_json.contains("\"phase\":\"fault\""));
    assert!(fault_status_json.contains("\"attention_required\":true"));

    let fault_plan = invoke(&["plan", "--config", &config_path]);
    assert_eq!(fault_plan.status.code(), Some(5));
    let fault_plan_json = String::from_utf8(fault_plan.stdout).expect("UTF-8 fault plan");
    assert!(fault_plan_json.contains("\"decision\":\"recovery_required\""));
}

#[test]
fn corrupted_attempt_accounting_is_rejected_before_plan_or_run() {
    let workspace = TestWorkspace::new("corrupted-attempt-accounting");
    let (config_path, state_path) = initialize(&workspace, "corrupted-attempts");
    let mut state = PersistentState::default();
    state
        .store(Path::new(&state_path))
        .expect("store canonical pristine state");
    let canonical = fs::read_to_string(&state_path).expect("read canonical state");
    let corrupted = canonical.replacen("attempts=0\n", "attempts=1\n", 1);
    assert_ne!(canonical, corrupted);
    fs::write(&state_path, &corrupted).expect("inject invalid attempt relation");

    for arguments in [
        vec!["plan", "--config", config_path.as_str()],
        vec!["run", "--config", config_path.as_str(), "--once"],
    ] {
        let output = invoke(&arguments);
        assert_eq!(output.status.code(), Some(70));
        let response = String::from_utf8(output.stdout).expect("UTF-8 state error");
        assert!(response.contains("\"kind\":\"state\""), "{response}");
        assert!(
            response.contains("nonzero attempts require an attempt window"),
            "{response}"
        );
    }
    assert_eq!(
        fs::read_to_string(&state_path).expect("reread rejected state"),
        corrupted,
        "rejection must not rewrite corrupted accounting"
    );
}
