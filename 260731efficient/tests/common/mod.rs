#![allow(dead_code, unsafe_code)]

use idlepilot::clock::LocalDateTime;
use idlepilot::conditions::{ConditionSnapshot, ConditionState, ConditionStatus};
use idlepilot::config::{Config, IdleMode, PowerPolicy, TimeWindow, WifiPolicy};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TERMINATE_REQUESTED: AtomicBool = AtomicBool::new(false);
const MODE_VARIABLE: &str = "IDLEPILOT_TEST_MODE";
const ROLE_VARIABLE: &str = "IDLEPILOT_TEST_ROLE";
const IDENTITIES_VARIABLE: &str = "IDLEPILOT_TEST_IDENTITIES";
const HEARTBEAT_VARIABLE: &str = "IDLEPILOT_TEST_HEARTBEAT";
const IGNORE_TERM_VARIABLE: &str = "IDLEPILOT_TEST_IGNORE_TERM";
const GRACEFUL_TERM_VARIABLE: &str = "IDLEPILOT_TEST_GRACEFUL_TERM";
const OUTPUT_VARIABLE: &str = "IDLEPILOT_TEST_OUTPUT";
const SOURCE_VARIABLE: &str = "IDLEPILOT_TEST_SOURCE";
const PUBLICATION_VARIABLE: &str = "IDLEPILOT_TEST_PUBLICATION";
const COUNTER_VARIABLE: &str = "IDLEPILOT_TEST_COUNTER";
const DELAY_MILLISECONDS_VARIABLE: &str = "IDLEPILOT_TEST_DELAY_MS";
const SIGTERM: i32 = 15;
const SIG_IGN: usize = 1;
const SIGNAL_ERROR: usize = usize::MAX;

unsafe extern "C" {
    fn getpgrp() -> i32;
    fn getppid() -> i32;
    fn signal(signal: i32, handler: usize) -> usize;
}

extern "C" fn request_termination(_signal: i32) {
    TERMINATE_REQUESTED.store(true, Ordering::SeqCst);
}

pub struct TestWorkspace {
    root: PathBuf,
}

impl TestWorkspace {
    pub fn new(label: &str) -> Self {
        let sequence = DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("idlepilot-integration")
            .join(format!("{label}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&root).expect("create private integration directory");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("secure integration directory");
        Self { root }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn tree_config(
    workspace: &TestWorkspace,
    identities: &Path,
    heartbeat: &Path,
    name: &str,
) -> Config {
    let mut environment = BTreeMap::new();
    environment.insert(MODE_VARIABLE.to_owned(), "tree".to_owned());
    environment.insert(ROLE_VARIABLE.to_owned(), "leader".to_owned());
    environment.insert(
        IDENTITIES_VARIABLE.to_owned(),
        identities.display().to_string(),
    );
    environment.insert(
        HEARTBEAT_VARIABLE.to_owned(),
        heartbeat.display().to_string(),
    );
    environment.insert(IGNORE_TERM_VARIABLE.to_owned(), "1".to_owned());
    config(workspace, harness_arguments(None), environment, name)
}

pub fn literal_config(
    workspace: &TestWorkspace,
    output: &Path,
    payload: &str,
    name: &str,
) -> Config {
    let mut environment = BTreeMap::new();
    environment.insert(MODE_VARIABLE.to_owned(), "literal".to_owned());
    environment.insert(OUTPUT_VARIABLE.to_owned(), output.display().to_string());
    config(
        workspace,
        harness_arguments(Some(payload)),
        environment,
        name,
    )
}

pub fn backup_config(
    workspace: &TestWorkspace,
    source: &Path,
    publication: &Path,
    identities: &Path,
    name: &str,
) -> Config {
    let mut environment = BTreeMap::new();
    environment.insert(MODE_VARIABLE.to_owned(), "backup".to_owned());
    environment.insert(SOURCE_VARIABLE.to_owned(), source.display().to_string());
    environment.insert(
        PUBLICATION_VARIABLE.to_owned(),
        publication.display().to_string(),
    );
    environment.insert(
        IDENTITIES_VARIABLE.to_owned(),
        identities.display().to_string(),
    );
    config(workspace, harness_arguments(None), environment, name)
}

pub fn flaky_config(
    workspace: &TestWorkspace,
    counter: &Path,
    output: &Path,
    identities: &Path,
    name: &str,
) -> Config {
    let mut environment = BTreeMap::new();
    environment.insert(MODE_VARIABLE.to_owned(), "flaky".to_owned());
    environment.insert(COUNTER_VARIABLE.to_owned(), counter.display().to_string());
    environment.insert(OUTPUT_VARIABLE.to_owned(), output.display().to_string());
    environment.insert(
        IDENTITIES_VARIABLE.to_owned(),
        identities.display().to_string(),
    );
    config(workspace, harness_arguments(None), environment, name)
}

fn config(
    workspace: &TestWorkspace,
    arguments: Vec<String>,
    environment: BTreeMap<String, String>,
    name: &str,
) -> Config {
    let executable = env::current_exe().expect("resolve integration test executable");
    assert!(
        executable.is_absolute(),
        "integration test executable path must be absolute"
    );
    Config {
        schema_version: 1,
        name: name.to_owned(),
        executable,
        args: arguments,
        working_directory: workspace.root().to_owned(),
        environment,
        executable_sha256: None,
        window: TimeWindow::parse("01:00-03:00").expect("test window"),
        poll_interval: Duration::from_secs(10),
        guard_interval: Duration::from_millis(100),
        start_stability: Duration::ZERO,
        idle_minimum: Duration::ZERO,
        wifi: WifiPolicy::Any,
        power: PowerPolicy::Auto,
        idle: IdleMode::LogindUser,
        stop_grace: Duration::from_secs(1),
        max_runtime: Some(Duration::from_secs(10)),
        max_attempts_per_window: 1,
        retry_on_failure: false,
        retry_after_guard_loss: false,
        state_file: workspace.path("state/idlepilot.state"),
    }
}

fn harness_arguments(skip_payload: Option<&str>) -> Vec<String> {
    let mut arguments = vec![
        "--ignored".to_owned(),
        "--exact".to_owned(),
        "fixture_entry".to_owned(),
        "--test-threads=1".to_owned(),
    ];
    if let Some(payload) = skip_payload {
        // libtest consumes this value as a skip filter. The ignored fixture
        // reads the original argv and records it, proving it was not parsed by
        // a shell while keeping every argument valid for the test harness.
        arguments.push("--skip".to_owned());
        arguments.push(payload.to_owned());
    }
    arguments
}

pub fn fixture_entry() {
    let Some(mode) = env::var(MODE_VARIABLE).ok() else {
        // `cargo test -- --ignored` is safe: only an ActionProcess-launched
        // harness with the explicit fixture environment performs any work.
        return;
    };
    let result = match mode.as_str() {
        "tree" => fixture_tree(),
        "literal" => fixture_record_literal(),
        "backup" => fixture_backup(),
        "flaky" => fixture_flaky(),
        _ => Err(format!("unknown fixture mode {mode:?}")),
    };
    if let Err(message) = result {
        panic!("idlepilot integration fixture: {message}");
    }
}

fn fixture_record_literal() -> Result<(), String> {
    let output = required_environment_path(OUTPUT_VARIABLE)?;
    if let Ok(raw_delay) = env::var(DELAY_MILLISECONDS_VARIABLE) {
        let delay = raw_delay
            .parse::<u64>()
            .map_err(|_| "literal fixture delay is invalid".to_owned())?;
        if delay > 2_000 {
            return Err("literal fixture delay exceeds two seconds".to_owned());
        }
        thread::sleep(Duration::from_millis(delay));
    }
    let arguments: Vec<String> = env::args().collect();
    let value = arguments
        .windows(2)
        .find(|pair| pair[0] == "--skip")
        .map(|pair| pair[1].as_str())
        .ok_or_else(|| "literal fixture is missing the --skip value".to_owned())?;
    fs::write(&output, value.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", output.display()))
}

fn fixture_backup() -> Result<(), String> {
    let source = required_environment_path(SOURCE_VARIABLE)?;
    let publication = required_environment_path(PUBLICATION_VARIABLE)?;
    record_fixture_identity("backup")?;

    if publication.exists() {
        return Err(format!(
            "backup publication already exists: {}",
            publication.display()
        ));
    }
    let publication_parent = publication
        .parent()
        .ok_or_else(|| "backup publication has no parent".to_owned())?;
    fs::create_dir_all(publication_parent).map_err(|error| {
        format!(
            "cannot create backup publication parent {}: {error}",
            publication_parent.display()
        )
    })?;
    let publication_name = publication
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "backup publication name must be UTF-8".to_owned())?;
    let staging = publication_parent.join(format!(
        ".{publication_name}.partial.{}",
        std::process::id()
    ));
    fs::create_dir(&staging)
        .map_err(|error| format!("cannot create {}: {error}", staging.display()))?;

    let mut relative_files = Vec::new();
    collect_regular_files(&source, &source, &mut relative_files)?;
    relative_files.sort();
    if relative_files.is_empty() {
        return Err("backup source must contain at least one regular file".to_owned());
    }

    let mut manifest = String::new();
    for relative in relative_files {
        let relative_text = relative
            .to_str()
            .ok_or_else(|| "backup relative path must be UTF-8".to_owned())?;
        let source_file = source.join(&relative);
        let destination_file = staging.join(&relative);
        let destination_parent = destination_file
            .parent()
            .ok_or_else(|| "backup destination has no parent".to_owned())?;
        fs::create_dir_all(destination_parent).map_err(|error| {
            format!(
                "cannot create backup directory {}: {error}",
                destination_parent.display()
            )
        })?;
        fs::copy(&source_file, &destination_file).map_err(|error| {
            format!(
                "cannot copy {} to {}: {error}",
                source_file.display(),
                destination_file.display()
            )
        })?;
        let source_bytes = fs::read(&source_file)
            .map_err(|error| format!("cannot verify {}: {error}", source_file.display()))?;
        let copied_bytes = fs::read(&destination_file)
            .map_err(|error| format!("cannot verify {}: {error}", destination_file.display()))?;
        if source_bytes != copied_bytes {
            return Err(format!("backup verification failed for {relative_text}"));
        }
        manifest.push_str(&idlepilot::sha256::digest_bytes(&source_bytes));
        manifest.push_str("  ");
        manifest.push_str(relative_text);
        manifest.push('\n');
    }

    fs::write(staging.join("MANIFEST.sha256"), manifest.as_bytes())
        .map_err(|error| format!("cannot write backup manifest: {error}"))?;
    fs::rename(&staging, &publication).map_err(|error| {
        format!(
            "cannot atomically publish {} as {}: {error}",
            staging.display(),
            publication.display()
        )
    })
}

fn fixture_flaky() -> Result<(), String> {
    let counter = required_environment_path(COUNTER_VARIABLE)?;
    let output = required_environment_path(OUTPUT_VARIABLE)?;
    record_fixture_identity("flaky")?;

    let previous = match fs::read_to_string(&counter) {
        Ok(value) => value
            .trim()
            .parse::<u32>()
            .map_err(|_| "flaky counter is invalid".to_owned())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("cannot read {}: {error}", counter.display())),
    };
    let attempt = previous
        .checked_add(1)
        .ok_or_else(|| "flaky attempt counter overflowed".to_owned())?;
    atomic_write(&counter, format!("{attempt}\n").as_bytes())?;
    match attempt {
        1 => Err("intentional first-attempt failure".to_owned()),
        2 => atomic_write(&output, b"household-index-ready\n"),
        _ => Err(format!("unexpected flaky attempt {attempt}")),
    }
}

fn record_fixture_identity(role: &str) -> Result<(), String> {
    let identities = required_environment_path(IDENTITIES_VARIABLE)?;
    append_identity(&identities, role)
}

fn collect_regular_files(
    root: &Path,
    directory: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("cannot read {}: {error}", directory.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|error| format!("cannot enumerate {}: {error}", directory.display()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if file_type.is_dir() {
            collect_regular_files(root, &path, output)?;
        } else if file_type.is_file() {
            output.push(
                path.strip_prefix(root)
                    .map_err(|_| "backup file escaped its source root".to_owned())?
                    .to_owned(),
            );
        } else {
            return Err(format!(
                "backup source contains a non-regular entry: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, value: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} name must be UTF-8", path.display()))?;
    let temporary = parent.join(format!(".{name}.tmp.{}", std::process::id()));
    fs::write(&temporary, value)
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|error| {
        format!(
            "cannot publish {} as {}: {error}",
            temporary.display(),
            path.display()
        )
    })
}

fn fixture_tree() -> Result<(), String> {
    let role = env::var(ROLE_VARIABLE).map_err(|_| "tree fixture role is missing".to_owned())?;
    if !matches!(role.as_str(), "leader" | "child" | "grandchild") {
        return Err(format!("invalid fixture role {role:?}"));
    }
    let identities = required_environment_path(IDENTITIES_VARIABLE)?;
    let heartbeat = required_environment_path(HEARTBEAT_VARIABLE)?;
    let ignore_term = env::var(IGNORE_TERM_VARIABLE).as_deref() == Ok("1");
    let graceful_term = env::var(GRACEFUL_TERM_VARIABLE).as_deref() == Ok("1");
    if ignore_term && graceful_term {
        return Err("tree fixture termination modes conflict".to_owned());
    }
    if ignore_term {
        install_term_ignore()?;
    } else if graceful_term {
        install_term_handler()?;
    }
    append_identity(&identities, &role)?;

    let mut descendant = match role.as_str() {
        "leader" => Some(spawn_fixture_node("child")?),
        "child" => Some(spawn_fixture_node("grandchild")?),
        "grandchild" => None,
        _ => unreachable!("role was validated"),
    };

    let mut sequence = 0_u64;
    loop {
        if TERMINATE_REQUESTED.load(Ordering::SeqCst) {
            if let Some(child) = descendant.as_mut() {
                child
                    .wait()
                    .map_err(|error| format!("cannot reap fixture descendant: {error}"))?;
            }
            return Ok(());
        }
        append_line(
            &heartbeat,
            &format!("{role} {} {sequence}\n", std::process::id()),
        )?;
        sequence = sequence.saturating_add(1);
        if let Some(child) = descendant.as_mut() {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("cannot poll fixture descendant: {error}"))?
            {
                return Err(format!("fixture descendant exited early: {status}"));
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn spawn_fixture_node(role: &str) -> Result<std::process::Child, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("cannot resolve test harness executable: {error}"))?;
    Command::new(executable)
        .args(harness_arguments(None))
        .env(ROLE_VARIABLE, role)
        .spawn()
        .map_err(|error| format!("cannot spawn {role}: {error}"))
}

fn required_environment_path(variable: &str) -> Result<PathBuf, String> {
    env::var_os(variable)
        .map(PathBuf::from)
        .ok_or_else(|| format!("fixture environment variable {variable} is missing"))
}

fn install_term_ignore() -> Result<(), String> {
    // SAFETY: SIG_IGN is a POSIX-defined special handler and SIGTERM is valid.
    let previous = unsafe { signal(SIGTERM, SIG_IGN) };
    if previous == SIGNAL_ERROR {
        Err(format!(
            "cannot ignore SIGTERM: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn install_term_handler() -> Result<(), String> {
    // SAFETY: request_termination has the C signal-handler ABI and SIGTERM is valid.
    let previous = unsafe { signal(SIGTERM, request_termination as *const () as usize) };
    if previous == SIGNAL_ERROR {
        Err(format!(
            "cannot install SIGTERM handler: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn append_identity(path: &Path, role: &str) -> Result<(), String> {
    // SAFETY: these process identity functions have no preconditions.
    let (parent, group) = unsafe { (getppid(), getpgrp()) };
    append_line(
        path,
        &format!("{role} {} {parent} {group}\n", std::process::id()),
    )
}

fn append_line(path: &Path, value: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    file.write_all(value.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", path.display()))
}

pub fn snapshot(wifi: ConditionState, wifi_reason: &'static str) -> ConditionSnapshot {
    ConditionSnapshot {
        wifi: ConditionStatus {
            state: wifi,
            reason: wifi_reason,
        },
        power: ConditionStatus {
            state: ConditionState::Met,
            reason: "test_power_met",
        },
        idle: ConditionStatus {
            state: ConditionState::Met,
            reason: "test_idle_met",
        },
        window: ConditionStatus {
            state: ConditionState::Met,
            reason: "test_window_met",
        },
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

pub fn wait_for_identity_records(path: &Path, count: usize) -> Vec<Identity> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            let identities: Vec<Identity> = contents.lines().filter_map(parse_identity).collect();
            if identities.len() >= count {
                return identities;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {count} process identity records at {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Debug)]
pub struct Identity {
    pub role: String,
    pub pid: u32,
    pub parent: u32,
    pub group: i32,
}

fn parse_identity(line: &str) -> Option<Identity> {
    let mut fields = line.split_whitespace();
    let role = fields.next()?.to_owned();
    let pid = fields.next()?.parse().ok()?;
    let parent = fields.next()?.parse().ok()?;
    let group = fields.next()?.parse().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some(Identity {
        role,
        pid,
        parent,
        group,
    })
}

pub fn wait_until_processes_absent(identities: &[Identity]) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if identities
            .iter()
            .all(|identity| !Path::new("/proc").join(identity.pid.to_string()).exists())
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "fixture processes still exist: {identities:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

pub fn wait_until_process_groups_absent(identities: &[Identity]) {
    let mut groups = identities
        .iter()
        .map(|identity| identity.group)
        .collect::<Vec<_>>();
    groups.sort_unstable();
    groups.dedup();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if groups.iter().all(|group| {
            !idlepilot::security::process_group_exists(*group)
                .expect("inspect integration fixture process group")
        }) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "fixture process groups still exist: {groups:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
