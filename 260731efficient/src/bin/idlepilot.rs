//! Headless command-line interface for `idlepilot`.

use idlepilot::conditions::{ConditionSnapshot, LinuxProbe, Probe};
use idlepilot::config::{Config, IdleMode, PowerPolicy, TimeWindow, WifiPolicy};
use idlepilot::error::{Error, ErrorKind, Result};
use idlepilot::json;
use idlepilot::planning::{LaunchPlan, PlanDecision};
use idlepilot::state::PersistentState;
use idlepilot::supervisor::{Event, EventSink, JsonLineSink, RunMode, RunOutcome, Supervisor};
use std::collections::BTreeMap;
use std::env;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

fn main() -> ExitCode {
    let mut arguments = Vec::new();
    for argument in env::args_os().skip(1) {
        let Ok(argument) = argument.into_string() else {
            let error = Error::new(
                ErrorKind::Usage,
                "command-line arguments must be valid UTF-8",
            );
            let _ = write_stdout_line(&error_json(&error));
            return ExitCode::from(error_exit_code(error.kind()));
        };
        arguments.push(argument);
    }
    let human = remove_global_flag(&mut arguments, "--human");
    let _json = remove_global_flag(&mut arguments, "--json");
    match dispatch(arguments, human) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            if !error.requires_process_exit() {
                if human {
                    let _ = writeln!(io::stderr().lock(), "{error}");
                } else {
                    let _ = write_stdout_line(&error_json(&error));
                }
            }
            // A terminal supervisor error deliberately retains its instance
            // lock and may need systemd to reap the service cgroup. Any output
            // on that path could block process exit on a full pipe or journal.
            ExitCode::from(error_exit_code(error.kind()))
        }
    }
}

fn dispatch(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let command = arguments.first().cloned().ok_or_else(usage)?;
    arguments.remove(0);
    match command.as_str() {
        "version" | "--version" | "-V" => {
            require_empty(&arguments)?;
            let mut object = json::Object::new();
            object
                .number("api_version", idlepilot::API_VERSION)
                .text("name", "idlepilot")
                .text("version", idlepilot::VERSION);
            emit_one(
                human,
                &object.finish(),
                &format!("idlepilot {}", idlepilot::VERSION),
            )?;
            Ok(0)
        }
        "schema" => {
            require_empty(&arguments)?;
            emit_one(human, schema_json(), "idlepilot machine schema v1")?;
            Ok(0)
        }
        "init" => init_config(arguments, human),
        "validate" => validate_config(arguments, human),
        "check" => check(arguments, human),
        "plan" => plan(arguments, human),
        "doctor" => doctor(arguments, human),
        "run" => run(arguments, human),
        "status" => status(arguments, human),
        "stop" => stop(arguments, human),
        "digest" => digest(arguments, human),
        "import" => import_artifact(arguments, human),
        "help" | "--help" | "-h" => {
            require_empty(&arguments)?;
            if human {
                write_stdout_line(help_text())?;
            } else {
                let mut object = json::Object::new();
                object
                    .number("api_version", idlepilot::API_VERSION)
                    .text("status", "ok")
                    .text("help", help_text());
                write_stdout_line(&object.finish())?;
            }
            Ok(0)
        }
        _ => Err(usage()),
    }
}

fn init_config(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let config_path = required_path(&mut arguments, "--config")?;
    let executable = required_path(&mut arguments, "--executable")?;
    let state_file = required_path(&mut arguments, "--state-file")?;
    let name = take_option(&mut arguments, "--name").unwrap_or_else(|| "nightly-task".to_owned());
    let working_directory = take_option(&mut arguments, "--working-directory").map(PathBuf::from);
    let task_arguments = take_options(&mut arguments, "--arg")?;
    let environment_entries = take_options(&mut arguments, "--env")?;
    let window = take_option(&mut arguments, "--window")
        .map(|value| TimeWindow::parse(&value))
        .transpose()?;
    let poll_seconds = take_bounded_option(&mut arguments, "--poll-seconds", 10, 600)?;
    let guard_milliseconds = take_bounded_option(&mut arguments, "--guard-milliseconds", 100, 250)?;
    let start_stability_seconds =
        take_bounded_option(&mut arguments, "--start-stability-seconds", 0, 300)?;
    let idle_seconds = take_bounded_option(&mut arguments, "--idle-seconds", 0, 86_400)?;
    let wifi = take_option(&mut arguments, "--wifi")
        .map(|value| WifiPolicy::parse(&value))
        .transpose()?;
    let power = take_option(&mut arguments, "--power")
        .map(|value| PowerPolicy::parse(&value))
        .transpose()?;
    let idle = take_option(&mut arguments, "--idle")
        .map(|value| IdleMode::parse(&value))
        .transpose()?;
    let stop_grace_seconds = take_bounded_option(&mut arguments, "--stop-grace-seconds", 1, 300)?;
    let max_runtime_seconds =
        take_bounded_option(&mut arguments, "--max-runtime-seconds", 1, 604_800)?;
    let no_runtime_limit = remove_flag(&mut arguments, "--no-runtime-limit");
    if no_runtime_limit && max_runtime_seconds.is_some() {
        return Err(Error::new(
            ErrorKind::Usage,
            "--no-runtime-limit conflicts with --max-runtime-seconds",
        ));
    }
    let max_attempts = take_bounded_option(&mut arguments, "--max-attempts-per-window", 1, 100)?;
    let retry_on_failure = remove_flag(&mut arguments, "--retry-on-failure");
    let no_retry_after_guard_loss = remove_flag(&mut arguments, "--no-retry-after-guard-loss");
    require_empty(&arguments)?;
    idlepilot::security::require_unprivileged_user()?;
    let input = idlepilot::security::open_secure_input_file(&executable, 512 * 1024 * 1024)?;
    let (_, digest) = idlepilot::sha256::copy_and_digest(input, io::sink(), 512 * 1024 * 1024)?;
    let mut config = Config::new(name, executable, state_file)?;
    config.executable_sha256 = Some(digest.clone());
    config.args = task_arguments;
    config.environment = parse_cli_environment(environment_entries)?;
    if let Some(working_directory) = working_directory {
        if !working_directory.is_absolute() {
            return Err(Error::new(
                ErrorKind::Usage,
                "--working-directory requires an absolute path",
            ));
        }
        config.working_directory = working_directory;
    }
    if let Some(window) = window {
        config.window = window;
    }
    if let Some(value) = poll_seconds {
        config.poll_interval = Duration::from_secs(value);
    }
    if let Some(value) = guard_milliseconds {
        config.guard_interval = Duration::from_millis(value);
    }
    if let Some(value) = start_stability_seconds {
        config.start_stability = Duration::from_secs(value);
    }
    if let Some(value) = idle_seconds {
        config.idle_minimum = Duration::from_secs(value);
    }
    if let Some(value) = wifi {
        config.wifi = value;
    }
    if let Some(value) = power {
        config.power = value;
    }
    if let Some(value) = idle {
        config.idle = value;
    }
    if let Some(value) = stop_grace_seconds {
        config.stop_grace = Duration::from_secs(value);
    }
    if no_runtime_limit {
        config.max_runtime = None;
    } else if let Some(value) = max_runtime_seconds {
        config.max_runtime = Some(Duration::from_secs(value));
    }
    if let Some(value) = max_attempts {
        config.max_attempts_per_window = u32::try_from(value)
            .map_err(|_| Error::new(ErrorKind::Usage, "attempt limit does not fit u32"))?;
    }
    config.retry_on_failure = retry_on_failure;
    config.retry_after_guard_loss = !no_retry_after_guard_loss;
    config.store_new_secure(&config_path)?;
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", "created")
        .text("config", &config_path.to_string_lossy())
        .text("executable_sha256", &digest);
    emit_one(
        human,
        &object.finish(),
        &format!("created {}", config_path.display()),
    )?;
    Ok(0)
}

fn validate_config(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    require_empty(&arguments)?;
    let config = Config::load_secure(&path)?;
    let warnings = config.warnings();
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", "valid")
        .text("name", &config.name)
        .raw("warnings", json::string_array(warnings.iter().copied()));
    emit_one(
        human,
        &object.finish(),
        if warnings.is_empty() {
            "configuration is valid".to_owned()
        } else {
            format!(
                "configuration is valid with warnings: {}",
                warnings.join(", ")
            )
        }
        .as_str(),
    )?;
    Ok(0)
}

fn check(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    require_empty(&arguments)?;
    let config = Config::load_secure(&path)?;
    let mut probe = LinuxProbe::system(config);
    let snapshot = probe.snapshot();
    emit_snapshot(human, &snapshot)?;
    Ok(if snapshot.all_met() { 0 } else { 3 })
}

fn plan(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    require_empty(&arguments)?;
    let config = Config::load_secure(&path)?;
    let state = PersistentState::load_for_control(&config.state_file)?;
    state.verify_config_fingerprint(&config.state_fingerprint()?)?;
    let mut probe = LinuxProbe::system(config.clone());
    let launch_plan = LaunchPlan::inspect(&config, probe.snapshot(), &state)?;
    let status = if launch_plan.decision == PlanDecision::Ready {
        "ready"
    } else if launch_plan.decision.requires_attention() {
        "attention"
    } else {
        "blocked"
    };
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", status)
        .text("name", &config.name)
        .text("decision", launch_plan.decision.as_str())
        .text("reason", launch_plan.reason)
        .boolean("would_launch", launch_plan.decision.would_launch())
        .boolean(
            "attention_required",
            launch_plan.decision.requires_attention(),
        )
        .text("artifact", launch_plan.artifact.as_str())
        .text("state_phase", launch_plan.state_phase.as_str())
        .boolean("daemon_alive", launch_plan.daemon_alive)
        .number("attempts", launch_plan.effective_attempts)
        .number("max_attempts", launch_plan.max_attempts)
        .optional_text("window_key", launch_plan.window_key.as_deref())
        .text("wifi", launch_plan.conditions.wifi.state.as_str())
        .text("wifi_reason", launch_plan.conditions.wifi.reason)
        .text("power", launch_plan.conditions.power.state.as_str())
        .text("power_reason", launch_plan.conditions.power.reason)
        .text("idle", launch_plan.conditions.idle.state.as_str())
        .text("idle_reason", launch_plan.conditions.idle.reason)
        .text("window", launch_plan.conditions.window.state.as_str())
        .text("window_reason", launch_plan.conditions.window.reason)
        .raw(
            "warnings",
            json::string_array(config.warnings().iter().copied()),
        );
    emit_one(
        human,
        &object.finish(),
        &format!(
            "{}: {} ({})",
            config.name,
            launch_plan.decision.as_str(),
            launch_plan.reason
        ),
    )?;
    Ok(if launch_plan.decision == PlanDecision::Ready {
        0
    } else if launch_plan.decision.requires_attention() {
        5
    } else {
        3
    })
}

fn doctor(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    let watch_seconds = take_option(&mut arguments, "--watch-seconds")
        .map(|value| parse_u64(&value, 1, 3600))
        .transpose()?
        .unwrap_or(30);
    require_empty(&arguments)?;
    let config = Config::load_secure(&path)?;
    let mut probe = LinuxProbe::system(config);
    let deadline = Instant::now() + Duration::from_secs(watch_seconds);
    let mut all_met_once = false;
    while Instant::now() < deadline {
        let snapshot = probe.snapshot();
        all_met_once |= snapshot.all_met();
        emit_snapshot(human, &snapshot)?;
        thread::sleep(
            Duration::from_secs(1).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    Ok(if all_met_once { 0 } else { 3 })
}

fn run(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    let once = remove_flag(&mut arguments, "--once");
    require_empty(&arguments)?;
    let config = Config::load_for_run(&path)?;
    idlepilot::security::install_termination_handlers()?;
    let probe = LinuxProbe::system(config.clone());
    let outcome = if human {
        let sink = HumanSink;
        let mut supervisor = Supervisor::new(config, probe, sink);
        supervisor.run(if once { RunMode::Once } else { RunMode::Daemon })?
    } else {
        let sink = JsonLineSink::new(io::stdout().lock());
        let mut supervisor = Supervisor::new(config, probe, sink);
        supervisor.run(if once { RunMode::Once } else { RunMode::Daemon })?
    };
    Ok(run_outcome_exit_code(outcome))
}

fn status(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    require_empty(&arguments)?;
    let config = Config::load_for_control(&path)?;
    let state = PersistentState::load_for_control(&config.state_file)?;
    state.verify_config_fingerprint(&config.state_fingerprint()?)?;
    let daemon_alive = daemon_identity_matches(&state)?;
    let (action_status, action_alive, action_attention) = inspect_action_status(&state)?;
    let attention_required = action_attention
        || (action_alive && !daemon_alive)
        || state.has_unresolved_launch_intent()
        || (!daemon_alive && state.phase == idlepilot::state::Phase::Fault);
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", if daemon_alive { "running" } else { "stopped" })
        .text("name", &config.name)
        .text("phase", state.phase.as_str())
        .boolean("daemon_alive", daemon_alive)
        .text("action_status", action_status)
        .boolean("action_alive", action_alive)
        .boolean("attention_required", attention_required)
        .number("attempts", state.attempts)
        .number("max_attempts", config.max_attempts_per_window)
        .optional_text("window_key", state.window_key.as_deref())
        .optional_text("completed_window", state.completed_window.as_deref())
        .optional_text("attempt_window", state.attempt_window.as_deref())
        .optional_text("last_reason", state.last_reason.as_deref())
        .number("updated_unix_seconds", state.updated_unix_seconds);
    optional_number(&mut object, "daemon_pid", state.daemon_pid);
    optional_number(&mut object, "action_pid", state.action_pid);
    optional_number(&mut object, "action_pgid", state.action_pgid);
    optional_number(&mut object, "last_exit_code", state.last_exit_code);
    optional_number(&mut object, "last_exit_signal", state.last_exit_signal);
    emit_one(
        human,
        &object.finish(),
        &format!(
            "{} ({})",
            if daemon_alive { "running" } else { "stopped" },
            state.phase.as_str()
        ),
    )?;
    Ok(0)
}

fn stop(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--config")?;
    let wait_seconds = take_option(&mut arguments, "--wait-seconds")
        .map(|value| parse_u64(&value, 1, 60))
        .transpose()?
        .unwrap_or(15);
    require_empty(&arguments)?;
    let config = Config::load_for_control(&path)?;
    let state = PersistentState::load_for_control(&config.state_file)?;
    state.verify_config_fingerprint(&config.state_fingerprint()?)?;
    let (Some(pid), Some(expected_ticks)) = (state.daemon_pid, state.daemon_start_ticks) else {
        emit_stopped(human, false)?;
        return Ok(0);
    };
    let Some(handle) = idlepilot::security::ProcessHandle::open(pid)? else {
        emit_stopped(human, false)?;
        return Ok(0);
    };
    let actual = idlepilot::security::inspect_process_start_ticks(pid, Path::new("/proc"))?;
    match actual {
        None => {
            emit_stopped(human, false)?;
            return Ok(0);
        }
        Some(actual) if actual != expected_ticks => {
            return Err(Error::new(
                ErrorKind::Security,
                "daemon PID identity mismatch; refusing to signal",
            ));
        }
        Some(_) => {}
    }
    if !handle.signal(idlepilot::security::SIGTERM)? {
        emit_stopped(human, false)?;
        return Ok(0);
    }
    let deadline = Instant::now() + Duration::from_secs(wait_seconds);
    while Instant::now() < deadline {
        if handle.has_exited()? {
            emit_stopped(human, true)?;
            return Ok(0);
        }
        thread::sleep(Duration::from_millis(100));
    }
    if handle.has_exited()? {
        emit_stopped(human, true)?;
        return Ok(0);
    }
    Err(Error::new(
        ErrorKind::Process,
        "daemon did not stop within the requested timeout",
    ))
}

fn digest(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let path = required_path(&mut arguments, "--file")?;
    require_empty(&arguments)?;
    let file = idlepilot::security::open_secure_input_file(&path, 512 * 1024 * 1024)?;
    let (_, digest) = idlepilot::sha256::copy_and_digest(file, io::sink(), 512 * 1024 * 1024)?;
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", "ok")
        .text("sha256", &digest);
    emit_one(human, &object.finish(), &digest)?;
    Ok(0)
}

fn import_artifact(mut arguments: Vec<String>, human: bool) -> Result<u8> {
    let source = required_path(&mut arguments, "--source")?;
    let directory = required_path(&mut arguments, "--artifact-dir")?;
    require_empty(&arguments)?;
    let imported = idlepilot::artifact::import(&source, &directory)?;
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", "imported")
        .text("sha256", &imported.sha256)
        .text("path", &imported.path.to_string_lossy())
        .number("size", imported.size)
        .boolean("already_present", imported.already_present);
    emit_one(
        human,
        &object.finish(),
        &format!("{}  {}", imported.sha256, imported.path.display()),
    )?;
    Ok(0)
}

struct HumanSink;

impl EventSink for HumanSink {
    fn emit(&mut self, event: &Event) -> Result<()> {
        writeln!(
            io::stderr().lock(),
            "[{}] {}: {}",
            event.sequence,
            event.kind.as_str(),
            event.reason
        )
        .map_err(|error| Error::io(ErrorKind::Os, "cannot write human event", error))
    }
}

fn emit_snapshot(human: bool, snapshot: &ConditionSnapshot) -> Result<()> {
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text(
            "status",
            if snapshot.all_met() {
                "eligible"
            } else {
                "blocked"
            },
        )
        .boolean("eligible", snapshot.all_met())
        .text("wifi", snapshot.wifi.state.as_str())
        .text("wifi_reason", snapshot.wifi.reason)
        .text("power", snapshot.power.state.as_str())
        .text("power_reason", snapshot.power.reason)
        .text("idle", snapshot.idle.state.as_str())
        .text("idle_reason", snapshot.idle.reason)
        .text("window", snapshot.window.state.as_str())
        .text("window_reason", snapshot.window.reason);
    emit_one(
        human,
        &object.finish(),
        &format!(
            "eligible={} wifi={} power={} idle={} window={}",
            snapshot.all_met(),
            snapshot.wifi.state.as_str(),
            snapshot.power.state.as_str(),
            snapshot.idle.state.as_str(),
            snapshot.window.state.as_str()
        ),
    )
}

fn emit_stopped(human: bool, signaled: bool) -> Result<()> {
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", "stopped")
        .boolean("signal_sent", signaled);
    emit_one(human, &object.finish(), "stopped")
}

fn daemon_identity_matches(state: &PersistentState) -> Result<bool> {
    let (Some(pid), Some(expected)) = (state.daemon_pid, state.daemon_start_ticks) else {
        return Ok(false);
    };
    Ok(
        idlepilot::security::inspect_process_start_ticks(pid, Path::new("/proc"))?
            .is_some_and(|actual| actual == expected),
    )
}

fn inspect_action_status(state: &PersistentState) -> Result<(&'static str, bool, bool)> {
    match (
        state.action_pid,
        state.action_pgid,
        state.action_start_ticks,
    ) {
        (None, None, None) if state.has_unresolved_launch_intent() => {
            Ok(("launch_intent_unresolved", false, true))
        }
        (None, None, None) => Ok(("none", false, false)),
        (Some(pid), Some(group), Some(expected_ticks)) => {
            match idlepilot::security::inspect_process_start_ticks(pid, Path::new("/proc"))? {
                Some(actual_ticks) if actual_ticks == expected_ticks => {
                    Ok(("recorded_process_running", true, false))
                }
                Some(_) => Ok(("pid_reused", false, true)),
                None if idlepilot::security::process_group_exists(group)? => {
                    Ok(("descendant_group_running", true, true))
                }
                None => Ok(("terminal_result_unknown", false, true)),
            }
        }
        _ => Ok(("identity_incomplete", false, true)),
    }
}

fn schema_json() -> &'static str {
    r#"{"api_version":1,"status":"ok","commands":["init","validate","check","plan","doctor","run","status","stop","digest","import","schema","version"],"run_modes":["daemon","once"],"condition_states":["met","not_met","unknown"],"plan_decisions":["ready","conditions_blocked","artifact_mismatch","daemon_running","recovery_required","already_completed","attempts_exhausted","invalid_snapshot"],"config_schema_version":1,"state_schema_version":2,"shell_execution":false,"arbitrary_exec_over_control_interface":false}"#
}

fn help_text() -> &'static str {
    "idlepilot: fail-closed Linux idle-task supervisor\n\
\n\
Commands:\n\
  init --config PATH --executable PATH --state-file PATH [OPTIONS]\n\
       Repeated: --arg VALUE, --env KEY=VALUE\n\
       Policies: --window HH:MM-HH:MM --wifi POLICY --power POLICY --idle POLICY\n\
       Timing: --poll-seconds N --guard-milliseconds N --start-stability-seconds N\n\
               --idle-seconds N --stop-grace-seconds N\n\
       Runtime: --max-runtime-seconds N | --no-runtime-limit\n\
       Retry: --max-attempts-per-window N --retry-on-failure\n\
              --no-retry-after-guard-loss\n\
  validate --config PATH\n\
  check --config PATH\n\
  plan --config PATH\n\
  doctor --config PATH [--watch-seconds N]\n\
  run --config PATH [--once]\n\
  status --config PATH\n\
  stop --config PATH [--wait-seconds N]\n\
  digest --file PATH\n\
  import --source PATH --artifact-dir PATH\n\
  schema | version\n\
\n\
Output is JSON/JSONL by default. Add --human for terse human output."
}

fn required_path(arguments: &mut Vec<String>, flag: &str) -> Result<PathBuf> {
    let value = take_option(arguments, flag)
        .ok_or_else(|| Error::new(ErrorKind::Usage, format!("missing required option {flag}")))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(Error::new(
            ErrorKind::Usage,
            format!("{flag} requires an absolute path"),
        ));
    }
    Ok(path)
}

fn take_option(arguments: &mut Vec<String>, flag: &str) -> Option<String> {
    let index = arguments.iter().position(|argument| argument == flag)?;
    if index + 1 >= arguments.len() {
        return None;
    }
    arguments.remove(index);
    Some(arguments.remove(index))
}

fn take_options(arguments: &mut Vec<String>, flag: &str) -> Result<Vec<String>> {
    let mut values = Vec::new();
    while let Some(index) = arguments.iter().position(|argument| argument == flag) {
        if index + 1 >= arguments.len() {
            return Err(Error::new(
                ErrorKind::Usage,
                format!("missing value for {flag}"),
            ));
        }
        arguments.remove(index);
        values.push(arguments.remove(index));
    }
    Ok(values)
}

fn take_bounded_option(
    arguments: &mut Vec<String>,
    flag: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>> {
    take_option(arguments, flag)
        .map(|value| parse_u64(&value, minimum, maximum))
        .transpose()
}

fn remove_flag(arguments: &mut Vec<String>, flag: &str) -> bool {
    if let Some(index) = arguments.iter().position(|argument| argument == flag) {
        arguments.remove(index);
        true
    } else {
        false
    }
}

fn remove_global_flag(arguments: &mut Vec<String>, flag: &str) -> bool {
    let index = if arguments.first().is_some_and(|argument| argument == flag) {
        Some(0)
    } else if arguments.get(1).is_some_and(|argument| argument == flag) {
        Some(1)
    } else {
        None
    };
    index.is_some_and(|index| {
        arguments.remove(index);
        true
    })
}

fn require_empty(arguments: &[String]) -> Result<()> {
    if arguments.is_empty() {
        Ok(())
    } else {
        Err(Error::new(
            ErrorKind::Usage,
            "unexpected command-line argument",
        ))
    }
}

fn parse_cli_environment(entries: Vec<String>) -> Result<BTreeMap<String, String>> {
    let mut environment = BTreeMap::new();
    for entry in entries {
        let (key, value) = entry
            .split_once('=')
            .ok_or_else(|| Error::new(ErrorKind::Usage, "--env values must use KEY=value"))?;
        if environment
            .insert(key.to_owned(), value.to_owned())
            .is_some()
        {
            return Err(Error::new(
                ErrorKind::Usage,
                "duplicate --env key is not allowed",
            ));
        }
    }
    Ok(environment)
}

fn optional_number(object: &mut json::Object, key: &str, value: Option<impl std::fmt::Display>) {
    if let Some(value) = value {
        object.number(key, value);
    } else {
        object.raw(key, "null");
    }
}

fn parse_u64(value: &str, minimum: u64, maximum: u64) -> Result<u64> {
    let parsed = value
        .parse()
        .map_err(|_| Error::new(ErrorKind::Usage, "option value is not an integer"))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(Error::new(
            ErrorKind::Usage,
            format!("option value must be in {minimum}..={maximum}"),
        ));
    }
    Ok(parsed)
}

fn run_outcome_exit_code(outcome: RunOutcome) -> u8 {
    match outcome {
        RunOutcome::Completed | RunOutcome::AlreadyCompleted => 0,
        RunOutcome::NotEligible | RunOutcome::AttemptsExhausted => 3,
        RunOutcome::Failed => 6,
        RunOutcome::GuardLost => 7,
        RunOutcome::RuntimeLimit => 8,
        RunOutcome::Shutdown(signal) if signal == idlepilot::security::SIGINT => 130,
        RunOutcome::Shutdown(signal) if signal == idlepilot::security::SIGTERM => 143,
        RunOutcome::Shutdown(_) => 70,
    }
}

const fn error_exit_code(kind: ErrorKind) -> u8 {
    match kind {
        ErrorKind::Usage | ErrorKind::Config => 2,
        ErrorKind::Probe => 4,
        ErrorKind::Security => 5,
        ErrorKind::Process => 6,
        _ => 70,
    }
}

fn error_json(error: &Error) -> String {
    let mut detail = json::Object::new();
    detail
        .text("kind", error.kind().as_str())
        .text("message", error.message());
    let mut object = json::Object::new();
    object
        .number("api_version", idlepilot::API_VERSION)
        .text("status", "error")
        .raw("error", detail.finish());
    object.finish()
}

fn emit_one(human: bool, json: &str, human_text: &str) -> Result<()> {
    write_stdout_line(if human { human_text } else { json })
}

fn write_stdout_line(value: &str) -> Result<()> {
    match writeln!(io::stdout().lock(), "{value}") {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(Error::io(
            ErrorKind::Os,
            "cannot write command output",
            error,
        )),
    }
}

fn usage() -> Error {
    Error::new(
        ErrorKind::Usage,
        "usage error; run `idlepilot help --human`",
    )
}
