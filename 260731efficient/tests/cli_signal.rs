#![allow(missing_docs)]

mod common;

use common::{TestWorkspace, wait_for_identity_records, wait_until_processes_absent};
use idlepilot::clock::{Clock, SystemClock};
use idlepilot::state::PersistentState;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::process::{Command, Stdio};

#[test]
#[ignore = "helper entrypoint launched explicitly by the integration test"]
fn fixture_entry() {
    common::fixture_entry();
}

#[test]
fn stop_command_interrupts_supervisor_and_reaps_the_action_tree() {
    let workspace = TestWorkspace::new("cli-signal");
    let identities = workspace.path("identities");
    let heartbeat = workspace.path("heartbeat");
    let state = workspace.path("state/idlepilot.state");
    let configuration = workspace.path("idlepilot.conf");
    let other_configuration = workspace.path("other.conf");
    let source_executable = std::env::current_exe().expect("resolve integration test executable");
    let executable = workspace.path("fixture-executable");
    fs::copy(&source_executable, &executable).expect("copy fixture executable");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("secure fixture executable");
    let local = SystemClock::new().local_now().expect("read local time");
    let minute = local.minute_of_day();
    let start = (minute + 1_439) % 1_440;
    let end = (minute + 2) % 1_440;
    let window = format!(
        "{:02}:{:02}-{:02}:{:02}",
        start / 60,
        start % 60,
        end / 60,
        end % 60
    );
    let contents = format!(
        concat!(
            "schema_version = 1\n",
            "name = cli-signal\n",
            "executable = \"{}\"\n",
            "arg = \"--ignored\"\n",
            "arg = \"--exact\"\n",
            "arg = \"fixture_entry\"\n",
            "arg = \"--test-threads=1\"\n",
            "working_directory = \"{}\"\n",
            "env = \"IDLEPILOT_TEST_MODE=tree\"\n",
            "env = \"IDLEPILOT_TEST_ROLE=leader\"\n",
            "env = \"IDLEPILOT_TEST_IDENTITIES={}\"\n",
            "env = \"IDLEPILOT_TEST_HEARTBEAT={}\"\n",
            "env = \"IDLEPILOT_TEST_IGNORE_TERM=1\"\n",
            "window = {}\n",
            "poll_seconds = 10\n",
            "guard_milliseconds = 100\n",
            "start_stability_seconds = 0\n",
            "idle_seconds = 0\n",
            "wifi = disabled\n",
            "power = ignore\n",
            "idle = disabled\n",
            "stop_grace_seconds = 1\n",
            "max_runtime_seconds = 30\n",
            "max_attempts_per_window = 2\n",
            "retry_on_failure = false\n",
            "retry_after_guard_loss = false\n",
            "state_file = \"{}\"\n"
        ),
        executable.display(),
        workspace.root().display(),
        identities.display(),
        heartbeat.display(),
        window,
        state.display()
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&configuration)
        .expect("create CLI configuration");
    file.write_all(contents.as_bytes())
        .expect("write CLI configuration");
    file.sync_all().expect("sync CLI configuration");
    let other_contents = contents.replacen("name = cli-signal", "name = cli-other", 1);
    let mut other_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&other_configuration)
        .expect("create mismatched CLI configuration");
    other_file
        .write_all(other_contents.as_bytes())
        .expect("write mismatched CLI configuration");
    other_file
        .sync_all()
        .expect("sync mismatched CLI configuration");

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .args(["run", "--config"])
        .arg(&configuration)
        .arg("--once")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start idlepilot CLI");

    let process_identities = wait_for_identity_records(&identities, 3);
    for command in ["status", "stop"] {
        let wrong_control = Command::new(env!("CARGO_BIN_EXE_idlepilot"))
            .args([command, "--config"])
            .arg(&other_configuration)
            .output()
            .expect("invoke mismatched control command");
        assert_eq!(wrong_control.status.code(), Some(5));
        assert!(
            String::from_utf8_lossy(&wrong_control.stdout)
                .contains("state file belongs to a different configuration")
        );
    }
    for identity in &process_identities {
        assert!(
            idlepilot::security::process_start_ticks(identity.pid, std::path::Path::new("/proc"))
                .is_ok(),
            "mismatched stop signalled {}",
            identity.role
        );
    }
    fs::remove_file(&executable).expect("remove configured executable during run");
    let status = Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .args(["status", "--config"])
        .arg(&configuration)
        .output()
        .expect("invoke status command");
    assert!(
        status.status.success(),
        "status failed after executable removal: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    assert!(String::from_utf8_lossy(&status.stdout).contains("\"daemon_alive\":true"));

    let stop = Command::new(env!("CARGO_BIN_EXE_idlepilot"))
        .args(["stop", "--config"])
        .arg(&configuration)
        .output()
        .expect("invoke stop command");
    assert!(
        stop.status.success(),
        "stop command failed: {}",
        String::from_utf8_lossy(&stop.stdout)
    );

    let exit = daemon.wait().expect("wait for idlepilot CLI");
    assert_eq!(exit.code(), Some(143));
    wait_until_processes_absent(&process_identities);
    let stopped = PersistentState::load(&state).expect("load operator-stopped state");
    assert_eq!(stopped.attempts, 1);
    assert!(
        stopped.completed_window.is_none(),
        "operator stop must not be treated as a terminal guard loss"
    );
}
