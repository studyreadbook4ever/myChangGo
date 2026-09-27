#![allow(missing_docs)]

mod common;

use common::{TestWorkspace, snapshot};
use idlepilot::conditions::{ConditionSnapshot, ConditionState, Probe};
use idlepilot::config::{Config, IdleMode, PowerPolicy, WifiPolicy};
use idlepilot::supervisor::{NullSink, RunMode, RunOutcome, Supervisor};
use std::ffi::OsString;
use std::fs;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

fn invoke(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .args(arguments)
        .output()
        .expect("run idlepilot")
}

#[test]
fn version_and_schema_have_stable_single_object_output() {
    let version = invoke(&["version"]);
    assert!(version.status.success());
    assert!(version.stderr.is_empty());
    assert_eq!(
        String::from_utf8(version.stdout).expect("UTF-8 version output"),
        format!(
            "{{\"api_version\":1,\"name\":\"idlepilot\",\"version\":\"{}\"}}\n",
            env!("CARGO_PKG_VERSION")
        )
    );

    let schema = invoke(&["schema"]);
    assert!(schema.status.success());
    assert!(schema.stderr.is_empty());
    assert_eq!(
        String::from_utf8(schema.stdout).expect("UTF-8 schema output"),
        concat!(
            "{\"api_version\":1,\"status\":\"ok\",",
            "\"commands\":[\"init\",\"validate\",\"check\",\"plan\",\"doctor\",\"run\",",
            "\"status\",\"stop\",\"digest\",\"import\",\"schema\",\"version\"],",
            "\"run_modes\":[\"daemon\",\"once\"],",
            "\"condition_states\":[\"met\",\"not_met\",\"unknown\"],",
            "\"plan_decisions\":[\"ready\",\"conditions_blocked\",",
            "\"artifact_mismatch\",\"daemon_running\",\"recovery_required\",",
            "\"already_completed\",\"attempts_exhausted\",\"invalid_snapshot\"],",
            "\"config_schema_version\":1,\"state_schema_version\":2,",
            "\"shell_execution\":false,",
            "\"arbitrary_exec_over_control_interface\":false}\n"
        )
    );
}

#[test]
fn usage_failure_is_machine_readable_and_does_not_echo_input() {
    let secret_like_input = "secret-token-should-not-be-echoed";
    let output = invoke(&["version", secret_like_input]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 error output");
    assert_eq!(
        stdout,
        concat!(
            "{\"api_version\":1,\"status\":\"error\",",
            "\"error\":{\"kind\":\"usage\",",
            "\"message\":\"unexpected command-line argument\"}}\n"
        )
    );
    assert!(!stdout.contains(secret_like_input));
}

#[test]
fn non_utf8_argv_is_a_structured_usage_error_not_a_panic() {
    let output = Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .arg(OsString::from_vec(vec![0xff, b'x']))
        .output()
        .expect("run idlepilot with non-UTF-8 argv");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).expect("UTF-8 structured error"),
        concat!(
            "{\"api_version\":1,\"status\":\"error\",",
            "\"error\":{\"kind\":\"usage\",",
            "\"message\":\"command-line arguments must be valid UTF-8\"}}\n"
        )
    );
}

#[test]
fn human_mode_keeps_the_explicit_human_contract() {
    let output = invoke(&["version", "--human"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).expect("UTF-8 human output"),
        format!("idlepilot {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn offline_help_lists_every_extended_init_control() {
    let output = invoke(&["help"]);
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).expect("UTF-8 help output");
    for option in [
        "--start-stability-seconds",
        "--stop-grace-seconds",
        "--max-runtime-seconds",
        "--no-runtime-limit",
        "--no-retry-after-guard-loss",
    ] {
        assert!(help.contains(option), "help omitted {option}: {help}");
    }
}

#[test]
fn init_creates_private_nested_configuration_and_state_parents() {
    let workspace = TestWorkspace::new("cli-init");
    let config = workspace.path("config/nested/task.conf");
    let state = workspace.path("state/nested/task.state");
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
    ]);
    assert!(
        output.status.success(),
        "init failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        fs::symlink_metadata(&config)
            .expect("config metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    for directory in [
        config.parent().expect("config parent"),
        config
            .parent()
            .and_then(|parent| parent.parent())
            .expect("config ancestor"),
        state.parent().expect("state parent"),
    ] {
        assert_eq!(
            fs::symlink_metadata(directory)
                .expect("private directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn init_builds_a_complete_household_task_without_manual_editing() {
    let workspace = TestWorkspace::new("cli-onboarding");
    let config_path = workspace.path("config/photos.conf");
    let state_path = workspace.path("state/photos.state");
    let output = invoke(&[
        "init",
        "--config",
        config_path.to_str().expect("UTF-8 config path"),
        "--executable",
        "/usr/bin/true",
        "--state-file",
        state_path.to_str().expect("UTF-8 state path"),
        "--name",
        "photos",
        "--working-directory",
        "/usr/bin",
        "--arg",
        "--power",
        "--arg",
        "--human",
        "--arg",
        "literal ; $(never-evaluated)",
        "--env",
        "OUTPUT_LABEL=household",
        "--env",
        "BACKUP_MODE=incremental",
        "--window",
        "23:00-05:00",
        "--poll-seconds",
        "10",
        "--guard-milliseconds",
        "100",
        "--start-stability-seconds",
        "0",
        "--idle-seconds",
        "0",
        "--wifi",
        "disabled",
        "--power",
        "ignore",
        "--idle",
        "disabled",
        "--stop-grace-seconds",
        "1",
        "--max-runtime-seconds",
        "60",
        "--max-attempts-per-window",
        "2",
        "--retry-on-failure",
        "--no-retry-after-guard-loss",
    ]);
    assert!(
        output.status.success(),
        "extended init failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );

    let config = Config::load_secure(&config_path).expect("load generated configuration");
    assert_eq!(config.name, "photos");
    assert_eq!(
        config.args,
        ["--power", "--human", "literal ; $(never-evaluated)"]
    );
    assert_eq!(
        config.environment.get("BACKUP_MODE").map(String::as_str),
        Some("incremental")
    );
    assert_eq!(config.window.canonical(), "23:00-05:00");
    assert_eq!(config.poll_interval, Duration::from_secs(10));
    assert_eq!(config.guard_interval, Duration::from_millis(100));
    assert_eq!(config.wifi, WifiPolicy::Disabled);
    assert_eq!(config.power, PowerPolicy::Ignore);
    assert_eq!(config.idle, IdleMode::Disabled);
    assert_eq!(config.max_runtime, Some(Duration::from_secs(60)));
    assert_eq!(config.max_attempts_per_window, 2);
    assert!(config.retry_on_failure);
    assert!(!config.retry_after_guard_loss);
    assert!(config.executable_sha256.is_some());
    assert_eq!(
        fs::read_to_string(&config_path).expect("read generated config"),
        config
            .to_canonical_text()
            .expect("canonical generated config")
    );
}

#[test]
fn closed_stdout_is_a_clean_pipe_exit_not_a_panic() {
    let (reader, writer) = UnixStream::pair().expect("create closed-output socket pair");
    drop(reader);
    let output = Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .arg("schema")
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn idlepilot with closed output")
        .wait_with_output()
        .expect("wait for closed-output command");
    assert_eq!(output.status.code(), Some(0));
    assert!(
        output.stderr.is_empty(),
        "closed output must not leak a panic: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[derive(Default)]
struct EligibleProbe;

impl Probe for EligibleProbe {
    fn snapshot(&mut self) -> ConditionSnapshot {
        snapshot(ConditionState::Met, "test_wifi_met")
    }
}

#[test]
fn one_config_cannot_control_or_inherit_another_configs_state() {
    let workspace = TestWorkspace::new("config-state-binding");
    let state_path = workspace.path("state/shared.state");
    let config_a_path = workspace.path("config/a.conf");
    let config_b_path = workspace.path("config/b.conf");
    let mut config_a = Config::new("task-a", "/usr/bin/true", &state_path).expect("config A");
    config_a.start_stability = Duration::ZERO;
    let mut config_b = config_a.clone();
    config_b.name = "task-b".to_owned();
    config_a
        .store_new_secure(&config_a_path)
        .expect("store config A");
    config_b
        .store_new_secure(&config_b_path)
        .expect("store config B");

    let mut supervisor = Supervisor::new(config_a, EligibleProbe, NullSink);
    assert_eq!(
        supervisor.run(RunMode::Once).expect("run config A"),
        RunOutcome::Completed
    );

    for command in ["status", "stop"] {
        let output = invoke(&[
            command,
            "--config",
            config_b_path.to_str().expect("UTF-8 config B path"),
        ]);
        assert_eq!(output.status.code(), Some(5), "{command} must fail closed");
        let response = String::from_utf8(output.stdout).expect("UTF-8 binding error");
        assert!(response.contains("\"kind\":\"security\""));
        assert!(response.contains("different configuration"));
    }

    let mut mismatched = Supervisor::new(config_b, EligibleProbe, NullSink);
    let error = mismatched
        .run(RunMode::Once)
        .expect_err("mismatched run must fail closed");
    assert_eq!(error.kind(), idlepilot::error::ErrorKind::Security);
}
