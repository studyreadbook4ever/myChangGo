use crate::error::{Error, ErrorKind, Result};
use crate::security;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_ARGS: usize = 256;
const MAX_ARG_BYTES: usize = 64 * 1024;
const MAX_TOTAL_ARG_BYTES: usize = 1024 * 1024;

/// Policy used to decide whether Wi-Fi connectivity is required.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WifiPolicy {
    /// At least one wireless interface must have carrier.
    Any,
    /// The named interface must have carrier.
    Interface(String),
    /// Explicitly disable this condition.
    Disabled,
}

impl WifiPolicy {
    /// Parse `any`, `disabled`, or `interface:NAME`.
    pub fn parse(value: &str) -> Result<Self> {
        parse_wifi(value)
    }

    /// Canonical configuration value.
    #[must_use]
    pub fn canonical(&self) -> String {
        match self {
            Self::Any => "any".to_owned(),
            Self::Interface(interface) => format!("interface:{interface}"),
            Self::Disabled => "disabled".to_owned(),
        }
    }
}

/// Policy used for external power.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerPolicy {
    /// Require external power when a system battery exists; pass on desktops.
    Auto,
    /// Always require an online external power source.
    Required,
    /// Explicitly ignore external power.
    Ignore,
}

impl PowerPolicy {
    /// Parse `auto`, `required`, or `ignore`.
    pub fn parse(value: &str) -> Result<Self> {
        parse_power(value)
    }

    /// Canonical configuration value.
    #[must_use]
    pub const fn canonical(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Required => "required",
            Self::Ignore => "ignore",
        }
    }
}

/// Provider used to determine user idle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleMode {
    /// Use systemd-logind's physical-seat idle hint.
    LogindSeat(String),
    /// Use systemd-logind's aggregate user idle hint.
    LogindUser,
    /// Explicitly disable the idle condition.
    Disabled,
}

impl IdleMode {
    /// Parse `logind-user`, `logind-seat:NAME`, or `disabled`.
    pub fn parse(value: &str) -> Result<Self> {
        parse_idle(value)
    }

    /// Canonical configuration value.
    #[must_use]
    pub fn canonical(&self) -> String {
        match self {
            Self::LogindSeat(seat) => format!("logind-seat:{seat}"),
            Self::LogindUser => "logind-user".to_owned(),
            Self::Disabled => "disabled".to_owned(),
        }
    }
}

/// A half-open local-time interval, `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeWindow {
    start_minute: u16,
    end_minute: u16,
}

impl TimeWindow {
    /// Parse `HH:MM-HH:MM`.
    pub fn parse(value: &str) -> Result<Self> {
        let (start, end) = value.split_once('-').ok_or_else(|| {
            Error::new(ErrorKind::Config, "window must have the form HH:MM-HH:MM")
        })?;
        let start_minute = parse_clock_minute(start)?;
        let end_minute = parse_clock_minute(end)?;
        if start_minute == end_minute {
            return Err(Error::new(
                ErrorKind::Config,
                "window start and end must differ; an always-open window is rejected",
            ));
        }
        Ok(Self {
            start_minute,
            end_minute,
        })
    }

    /// Whether the supplied local minute lies in the interval.
    #[must_use]
    pub const fn contains(self, minute: u16) -> bool {
        if self.start_minute < self.end_minute {
            minute >= self.start_minute && minute < self.end_minute
        } else {
            minute >= self.start_minute || minute < self.end_minute
        }
    }

    /// Local minute at which the interval begins.
    #[must_use]
    pub const fn start_minute(self) -> u16 {
        self.start_minute
    }

    /// Local minute at which the interval ends.
    #[must_use]
    pub const fn end_minute(self) -> u16 {
        self.end_minute
    }

    /// Canonical text form.
    #[must_use]
    pub fn canonical(self) -> String {
        format!(
            "{:02}:{:02}-{:02}:{:02}",
            self.start_minute / 60,
            self.start_minute % 60,
            self.end_minute / 60,
            self.end_minute % 60
        )
    }
}

/// Strict, shell-free scheduler configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Configuration schema version. Currently `1`.
    pub schema_version: u32,
    /// Safe identifier used in state and event output.
    pub name: String,
    /// Absolute executable or reviewed script path.
    pub executable: PathBuf,
    /// Literal argument vector. No shell parsing is performed.
    pub args: Vec<String>,
    /// Absolute working directory.
    pub working_directory: PathBuf,
    /// Explicit environment variables after the inherited environment is cleared.
    pub environment: BTreeMap<String, String>,
    /// Optional SHA-256 digest pin for the executable.
    pub executable_sha256: Option<String>,
    /// Allowed local-time interval.
    pub window: TimeWindow,
    /// Waiting-state late-poll interval.
    pub poll_interval: Duration,
    /// Running-state maximum guard recheck interval.
    pub guard_interval: Duration,
    /// Conditions must remain continuously true for this long before launch.
    pub start_stability: Duration,
    /// Minimum idle duration reported by logind.
    pub idle_minimum: Duration,
    /// Wi-Fi requirement.
    pub wifi: WifiPolicy,
    /// External-power requirement.
    pub power: PowerPolicy,
    /// Idle provider.
    pub idle: IdleMode,
    /// Grace period between process-group TERM and KILL.
    pub stop_grace: Duration,
    /// Optional hard runtime cap for one action.
    pub max_runtime: Option<Duration>,
    /// Maximum launches within one local window.
    pub max_attempts_per_window: u32,
    /// Retry a non-zero exit within the same window.
    pub retry_on_failure: bool,
    /// Retry after the guard becomes true again in the same window.
    pub retry_after_guard_loss: bool,
    /// Absolute durable state-file path.
    pub state_file: PathBuf,
}

impl Config {
    /// Construct a configuration with conservative household-task defaults.
    ///
    /// The caller can adjust public fields before calling [`Self::validate`]
    /// or [`Self::store_new_secure`]. The executable digest is intentionally
    /// left unset because computing it performs I/O.
    pub fn new(
        name: impl Into<String>,
        executable: impl Into<PathBuf>,
        state_file: impl Into<PathBuf>,
    ) -> Result<Self> {
        let executable = executable.into();
        let state_file = state_file.into();
        if !executable.is_absolute() || !state_file.is_absolute() {
            return Err(Error::new(
                ErrorKind::Config,
                "executable and state_file must be absolute paths",
            ));
        }
        let working_directory = executable
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_path_buf();
        let config = Self {
            schema_version: 1,
            name: name.into(),
            executable,
            args: Vec::new(),
            working_directory,
            environment: BTreeMap::new(),
            executable_sha256: None,
            window: TimeWindow::parse("01:00-06:00")?,
            poll_interval: Duration::from_secs(600),
            guard_interval: Duration::from_millis(250),
            start_stability: Duration::from_secs(15),
            idle_minimum: Duration::from_secs(900),
            wifi: WifiPolicy::Any,
            power: PowerPolicy::Auto,
            idle: IdleMode::LogindSeat("seat0".to_owned()),
            stop_grace: Duration::from_secs(5),
            max_runtime: Some(Duration::from_secs(14_400)),
            max_attempts_per_window: 3,
            retry_on_failure: false,
            retry_after_guard_loss: true,
            state_file,
        };
        config.validate_policy()?;
        Ok(config)
    }

    /// Parse an already-loaded configuration string.
    pub fn parse(input: &str) -> Result<Self> {
        if input.len() as u64 > MAX_CONFIG_BYTES {
            return Err(Error::new(ErrorKind::Config, "configuration is too large"));
        }

        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (index, raw_line) in input.lines().enumerate() {
            if raw_line.len() > MAX_ARG_BYTES {
                return Err(Error::new(
                    ErrorKind::Config,
                    format!("line {} exceeds the size limit", index + 1),
                ));
            }
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (raw_key, raw_value) = line.split_once('=').ok_or_else(|| {
                Error::new(
                    ErrorKind::Config,
                    format!("line {} must contain '='", index + 1),
                )
            })?;
            let key = raw_key.trim();
            if !valid_key(key) {
                return Err(Error::new(
                    ErrorKind::Config,
                    format!("line {} has an invalid key", index + 1),
                ));
            }
            let value = parse_value(raw_value.trim()).map_err(|error| {
                Error::new(
                    ErrorKind::Config,
                    format!("line {}: {}", index + 1, error.message()),
                )
            })?;
            values.entry(key.to_owned()).or_default().push(value);
        }

        let allowed: BTreeSet<&str> = [
            "schema_version",
            "name",
            "executable",
            "arg",
            "working_directory",
            "env",
            "executable_sha256",
            "window",
            "poll_seconds",
            "guard_milliseconds",
            "start_stability_seconds",
            "idle_seconds",
            "wifi",
            "power",
            "idle",
            "stop_grace_seconds",
            "max_runtime_seconds",
            "max_attempts_per_window",
            "retry_on_failure",
            "retry_after_guard_loss",
            "state_file",
        ]
        .into_iter()
        .collect();
        for key in values.keys() {
            if !allowed.contains(key.as_str()) {
                return Err(Error::new(
                    ErrorKind::Config,
                    format!("unknown configuration key '{key}'"),
                ));
            }
        }

        let schema_version = parse_u32(single_required(&values, "schema_version")?, 1, 1)?;
        let name = single_required(&values, "name")?.to_owned();
        validate_name(&name)?;
        let executable =
            parse_absolute_path(single_required(&values, "executable")?, "executable")?;
        let working_directory = parse_absolute_path(
            single_required(&values, "working_directory")?,
            "working_directory",
        )?;
        let state_file =
            parse_absolute_path(single_required(&values, "state_file")?, "state_file")?;
        let args = values.get("arg").cloned().unwrap_or_default();
        validate_args(&args)?;
        let environment = parse_environment(values.get("env"))?;
        let executable_sha256 = optional_single(&values, "executable_sha256")?
            .map(|value| validate_digest(value).map(ToOwned::to_owned))
            .transpose()?;
        let window = TimeWindow::parse(single_required(&values, "window")?)?;
        let poll_interval = Duration::from_secs(u64::from(parse_u32(
            single_required(&values, "poll_seconds")?,
            10,
            600,
        )?));
        let guard_interval = Duration::from_millis(u64::from(parse_u32(
            single_required(&values, "guard_milliseconds")?,
            100,
            250,
        )?));
        let start_stability = Duration::from_secs(u64::from(parse_u32(
            single_required(&values, "start_stability_seconds")?,
            0,
            300,
        )?));
        let idle_minimum = Duration::from_secs(u64::from(parse_u32(
            single_required(&values, "idle_seconds")?,
            0,
            86_400,
        )?));
        let wifi = parse_wifi(single_required(&values, "wifi")?)?;
        let power = parse_power(single_required(&values, "power")?)?;
        let idle = parse_idle(single_required(&values, "idle")?)?;
        let stop_grace = Duration::from_secs(u64::from(parse_u32(
            single_required(&values, "stop_grace_seconds")?,
            1,
            300,
        )?));
        let max_runtime = optional_single(&values, "max_runtime_seconds")?
            .map(|value| parse_u32(value, 1, 604_800).map(|v| Duration::from_secs(u64::from(v))))
            .transpose()?;
        let max_attempts_per_window =
            parse_u32(single_required(&values, "max_attempts_per_window")?, 1, 100)?;
        let retry_on_failure = parse_bool(single_required(&values, "retry_on_failure")?)?;
        let retry_after_guard_loss =
            parse_bool(single_required(&values, "retry_after_guard_loss")?)?;

        Ok(Self {
            schema_version,
            name,
            executable,
            args,
            working_directory,
            environment,
            executable_sha256,
            window,
            poll_interval,
            guard_interval,
            start_stability,
            idle_minimum,
            wifi,
            power,
            idle,
            stop_grace,
            max_runtime,
            max_attempts_per_window,
            retry_on_failure,
            retry_after_guard_loss,
            state_file,
        })
    }

    /// Load a regular, non-symlink configuration owned by the caller or root.
    pub fn load_secure(path: &Path) -> Result<Self> {
        let config = Self::load_parsed(path)?;
        config.validate()?;
        Ok(config)
    }

    /// Load a configuration for an explicit supervisor run, creating only
    /// the configured private state-directory chain when it is missing.
    pub fn load_for_run(path: &Path) -> Result<Self> {
        let config = Self::load_parsed(path)?;
        config.validate_policy()?;
        security::validate_executable(&config.executable)?;
        security::validate_working_directory(&config.working_directory)?;
        security::ensure_state_parent(&config.state_file)?;
        config.validate()?;
        Ok(config)
    }

    /// Load enough validated configuration for status and stop operations.
    ///
    /// Unlike [`Self::load_secure`], this keeps the control plane available if
    /// the configured action or working directory disappeared after startup.
    pub fn load_for_control(path: &Path) -> Result<Self> {
        let config = Self::load_parsed(path)?;
        config.validate_policy()?;
        security::validate_state_parent(&config.state_file)?;
        Ok(config)
    }

    /// Render a deterministic, shell-free schema-v1 configuration.
    ///
    /// Every string is quoted and escaped, repeated values retain argument
    /// order, and environment entries use sorted key order.
    pub fn to_canonical_text(&self) -> Result<String> {
        self.validate_policy()?;
        validate_serializable_duration(
            self.poll_interval,
            Duration::from_secs(1),
            "poll_interval",
        )?;
        validate_serializable_duration(
            self.guard_interval,
            Duration::from_millis(1),
            "guard_interval",
        )?;
        validate_serializable_duration(
            self.start_stability,
            Duration::from_secs(1),
            "start_stability",
        )?;
        validate_serializable_duration(self.idle_minimum, Duration::from_secs(1), "idle_minimum")?;
        validate_serializable_duration(self.stop_grace, Duration::from_secs(1), "stop_grace")?;
        if let Some(runtime) = self.max_runtime {
            validate_serializable_duration(runtime, Duration::from_secs(1), "max_runtime")?;
        }

        let mut output =
            String::from("# idlepilot configuration v1. Values are never evaluated by a shell.\n");
        push_config_line(
            &mut output,
            "schema_version",
            &self.schema_version.to_string(),
        );
        push_config_line(&mut output, "name", &quote_config(&self.name));
        push_config_line(
            &mut output,
            "executable",
            &quote_config(utf8_path(&self.executable, "executable")?),
        );
        output.push_str("# Repeated arg entries preserve literal argv order.\n");
        for argument in &self.args {
            push_config_line(&mut output, "arg", &quote_config(argument));
        }
        push_config_line(
            &mut output,
            "working_directory",
            &quote_config(utf8_path(&self.working_directory, "working_directory")?),
        );
        output.push_str("# Environment is cleared first; never place secrets here.\n");
        for (key, value) in &self.environment {
            push_config_line(&mut output, "env", &quote_config(&format!("{key}={value}")));
        }
        if let Some(digest) = &self.executable_sha256 {
            push_config_line(&mut output, "executable_sha256", digest);
        }
        push_config_line(&mut output, "window", &self.window.canonical());
        push_config_line(
            &mut output,
            "poll_seconds",
            &self.poll_interval.as_secs().to_string(),
        );
        push_config_line(
            &mut output,
            "guard_milliseconds",
            &self.guard_interval.as_millis().to_string(),
        );
        push_config_line(
            &mut output,
            "start_stability_seconds",
            &self.start_stability.as_secs().to_string(),
        );
        push_config_line(
            &mut output,
            "idle_seconds",
            &self.idle_minimum.as_secs().to_string(),
        );
        push_config_line(&mut output, "wifi", &self.wifi.canonical());
        push_config_line(&mut output, "power", self.power.canonical());
        push_config_line(&mut output, "idle", &self.idle.canonical());
        push_config_line(
            &mut output,
            "stop_grace_seconds",
            &self.stop_grace.as_secs().to_string(),
        );
        if let Some(runtime) = self.max_runtime {
            push_config_line(
                &mut output,
                "max_runtime_seconds",
                &runtime.as_secs().to_string(),
            );
        }
        push_config_line(
            &mut output,
            "max_attempts_per_window",
            &self.max_attempts_per_window.to_string(),
        );
        push_config_line(
            &mut output,
            "retry_on_failure",
            if self.retry_on_failure {
                "true"
            } else {
                "false"
            },
        );
        push_config_line(
            &mut output,
            "retry_after_guard_loss",
            if self.retry_after_guard_loss {
                "true"
            } else {
                "false"
            },
        );
        push_config_line(
            &mut output,
            "state_file",
            &quote_config(utf8_path(&self.state_file, "state_file")?),
        );
        if output.lines().any(|line| line.len() > MAX_ARG_BYTES) {
            return Err(Error::new(
                ErrorKind::Config,
                "canonical configuration contains a line beyond the schema-v1 size limit",
            ));
        }
        if output.len() as u64 > MAX_CONFIG_BYTES {
            return Err(Error::new(
                ErrorKind::Config,
                "canonical configuration exceeds the schema-v1 size limit",
            ));
        }
        Ok(output)
    }

    /// Stable SHA-256 binding used to prevent one configuration from reading
    /// or signalling another configuration's shared state file.
    ///
    /// The preimage is the UTF-8 output of [`Self::to_canonical_text`] with
    /// every line beginning with `#` removed and every retained line
    /// terminated by one `\n` byte.
    pub fn state_fingerprint(&self) -> Result<String> {
        let canonical = self.to_canonical_text()?;
        let mut semantic = String::new();
        for line in canonical.lines().filter(|line| !line.starts_with('#')) {
            semantic.push_str(line);
            semantic.push('\n');
        }
        Ok(crate::sha256::digest_bytes(semantic.as_bytes()))
    }

    /// Validate and create a new mode-0600 configuration without overwriting.
    pub fn store_new_secure(&self, path: &Path) -> Result<()> {
        self.validate_policy()?;
        let contents = self.to_canonical_text()?;
        security::validate_executable(&self.executable)?;
        security::validate_working_directory(&self.working_directory)?;
        security::ensure_state_parent(&self.state_file)?;
        security::ensure_state_parent(path)?;
        self.validate()?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| Error::io(ErrorKind::Config, "cannot create configuration", error))?;
        file.write_all(contents.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| Error::io(ErrorKind::Config, "cannot persist configuration", error))
    }

    fn load_parsed(path: &Path) -> Result<Self> {
        let file = security::open_secure_input_file(path, MAX_CONFIG_BYTES)?;
        let mut bytes = Vec::new();
        file.take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| Error::io(ErrorKind::Config, "cannot read configuration", error))?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_CONFIG_BYTES {
            return Err(Error::new(
                ErrorKind::Config,
                "configuration grew beyond its size limit while being read",
            ));
        }
        let input = std::str::from_utf8(&bytes)
            .map_err(|_| Error::new(ErrorKind::Config, "configuration must be UTF-8"))?;
        Self::parse(input)
    }

    /// Validate all policy and filesystem invariants.
    ///
    /// Library callers that construct [`Config`] directly receive the same
    /// validation as CLI-loaded configurations.
    pub fn validate(&self) -> Result<()> {
        self.validate_policy()?;
        self.validate_runtime_paths()
    }

    pub(crate) fn validate_action(&self) -> Result<()> {
        self.validate_policy()?;
        security::validate_executable(&self.executable)?;
        security::validate_working_directory(&self.working_directory)
    }

    fn validate_policy(&self) -> Result<()> {
        if self.schema_version != 1 {
            return Err(Error::new(
                ErrorKind::Config,
                "unsupported configuration schema",
            ));
        }
        validate_name(&self.name)?;
        validate_args(&self.args)?;
        for (key, value) in &self.environment {
            if !valid_env_key(key)
                || value.contains('\0')
                || contains_unsupported_control(value)
                || value.len() > MAX_ARG_BYTES
            {
                return Err(Error::new(
                    ErrorKind::Config,
                    "unsafe environment entry in configuration",
                ));
            }
        }
        if let Some(digest) = &self.executable_sha256 {
            validate_digest(digest)?;
        }
        validate_duration(
            self.poll_interval,
            Duration::from_secs(10),
            Duration::from_secs(600),
            "poll_interval",
        )?;
        validate_duration(
            self.guard_interval,
            Duration::from_millis(100),
            Duration::from_millis(250),
            "guard_interval",
        )?;
        validate_duration(
            self.start_stability,
            Duration::ZERO,
            Duration::from_secs(300),
            "start_stability",
        )?;
        validate_duration(
            self.idle_minimum,
            Duration::ZERO,
            Duration::from_secs(86_400),
            "idle_minimum",
        )?;
        validate_duration(
            self.stop_grace,
            Duration::from_secs(1),
            Duration::from_secs(300),
            "stop_grace",
        )?;
        if self
            .max_runtime
            .is_some_and(|value| value.is_zero() || value > Duration::from_secs(604_800))
        {
            return Err(Error::new(
                ErrorKind::Config,
                "max_runtime is outside 1s..=7d",
            ));
        }
        if !(1..=100).contains(&self.max_attempts_per_window) {
            return Err(Error::new(
                ErrorKind::Config,
                "max_attempts_per_window is outside 1..=100",
            ));
        }
        if let WifiPolicy::Interface(interface) = &self.wifi {
            validate_component_name(interface, 15, "Wi-Fi interface")?;
        }
        if let IdleMode::LogindSeat(seat) = &self.idle {
            validate_component_name(seat, 64, "logind seat")?;
        }
        Ok(())
    }

    /// Validate executable and working-directory invariants.
    pub fn validate_runtime_paths(&self) -> Result<()> {
        security::validate_executable(&self.executable)?;
        security::validate_working_directory(&self.working_directory)?;
        security::validate_state_parent(&self.state_file)?;
        Ok(())
    }

    /// Warnings for intentionally weakened conditions.
    #[must_use]
    pub fn warnings(&self) -> Vec<&'static str> {
        let mut warnings = Vec::new();
        if self.wifi == WifiPolicy::Disabled {
            warnings.push("wifi condition is disabled");
        }
        if self.power == PowerPolicy::Ignore {
            warnings.push("external-power condition is ignored");
        }
        if self.idle == IdleMode::Disabled {
            warnings.push("user-idle condition is disabled");
        }
        if self.executable_sha256.is_none() {
            warnings.push("executable content is not pinned by SHA-256");
        }
        warnings
    }
}

fn parse_clock_minute(value: &str) -> Result<u16> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or_else(|| Error::new(ErrorKind::Config, "clock value must have the form HH:MM"))?;
    if hour.len() != 2 || minute.len() != 2 {
        return Err(Error::new(
            ErrorKind::Config,
            "clock value must use two-digit HH:MM",
        ));
    }
    let hour: u16 = hour
        .parse()
        .map_err(|_| Error::new(ErrorKind::Config, "invalid clock hour"))?;
    let minute: u16 = minute
        .parse()
        .map_err(|_| Error::new(ErrorKind::Config, "invalid clock minute"))?;
    if hour > 23 || minute > 59 {
        return Err(Error::new(
            ErrorKind::Config,
            "clock value is outside 00:00-23:59",
        ));
    }
    Ok(hour * 60 + minute)
}

fn valid_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn parse_value(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Err(Error::new(ErrorKind::Config, "value must not be empty"));
    }
    if !raw.starts_with('"') {
        if raw.chars().any(char::is_control) {
            return Err(Error::new(
                ErrorKind::Config,
                "unquoted value contains a control character",
            ));
        }
        return Ok(raw.to_owned());
    }
    if !raw.ends_with('"') || raw.len() < 2 {
        return Err(Error::new(
            ErrorKind::Config,
            "quoted value is not terminated",
        ));
    }
    let inner = &raw[1..raw.len() - 1];
    let mut result = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            if character.is_control() || character == '"' {
                return Err(Error::new(
                    ErrorKind::Config,
                    "quoted value contains a raw control character or quote",
                ));
            }
            result.push(character);
            continue;
        }
        let escaped = chars
            .next()
            .ok_or_else(|| Error::new(ErrorKind::Config, "quoted value ends with an escape"))?;
        match escaped {
            '\\' => result.push('\\'),
            '"' => result.push('"'),
            'n' => result.push('\n'),
            'r' => result.push('\r'),
            't' => result.push('\t'),
            _ => {
                return Err(Error::new(
                    ErrorKind::Config,
                    format!("unsupported escape '\\{escaped}'"),
                ));
            }
        }
    }
    if result.contains('\0') {
        return Err(Error::new(ErrorKind::Config, "NUL is not allowed"));
    }
    Ok(result)
}

fn single_required<'a>(values: &'a BTreeMap<String, Vec<String>>, key: &str) -> Result<&'a str> {
    optional_single(values, key)?.ok_or_else(|| {
        Error::new(
            ErrorKind::Config,
            format!("missing required configuration key '{key}'"),
        )
    })
}

fn optional_single<'a>(
    values: &'a BTreeMap<String, Vec<String>>,
    key: &str,
) -> Result<Option<&'a str>> {
    match values.get(key) {
        None => Ok(None),
        Some(entries) if entries.len() == 1 => Ok(Some(entries[0].as_str())),
        Some(_) => Err(Error::new(
            ErrorKind::Config,
            format!("configuration key '{key}' may appear only once"),
        )),
    }
}

fn validate_name(value: &str) -> Result<()> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(Error::new(ErrorKind::Config, "name must not be empty"));
    };
    if value.len() > 64
        || !first.is_ascii_alphanumeric()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(Error::new(
            ErrorKind::Config,
            "name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}",
        ));
    }
    Ok(())
}

fn parse_absolute_path(value: &str, key: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{key} must be an absolute path"),
        ));
    }
    if path.as_os_str().len() > 4096 {
        return Err(Error::new(ErrorKind::Config, format!("{key} is too long")));
    }
    Ok(path)
}

fn validate_args(args: &[String]) -> Result<()> {
    if args.len() > MAX_ARGS {
        return Err(Error::new(ErrorKind::Config, "too many argument entries"));
    }
    let mut total = 0usize;
    for argument in args {
        if argument.len() > MAX_ARG_BYTES
            || argument.contains('\0')
            || contains_unsupported_control(argument)
        {
            return Err(Error::new(
                ErrorKind::Config,
                "an argument is too large or contains an unsupported control character",
            ));
        }
        total = total.saturating_add(argument.len());
    }
    if total > MAX_TOTAL_ARG_BYTES {
        return Err(Error::new(
            ErrorKind::Config,
            "total argument bytes exceed the limit",
        ));
    }
    Ok(())
}

fn parse_environment(entries: Option<&Vec<String>>) -> Result<BTreeMap<String, String>> {
    let mut environment = BTreeMap::new();
    for entry in entries.into_iter().flatten() {
        let (key, value) = entry
            .split_once('=')
            .ok_or_else(|| Error::new(ErrorKind::Config, "env entries must use KEY=value"))?;
        if !valid_env_key(key) {
            return Err(Error::new(
                ErrorKind::Config,
                format!("unsafe or invalid environment key '{key}'"),
            ));
        }
        if value.contains('\0')
            || contains_unsupported_control(value)
            || value.len() > MAX_ARG_BYTES
        {
            return Err(Error::new(
                ErrorKind::Config,
                "environment value is too large or contains an unsupported control character",
            ));
        }
        if environment
            .insert(key.to_owned(), value.to_owned())
            .is_some()
        {
            return Err(Error::new(
                ErrorKind::Config,
                format!("duplicate environment key '{key}'"),
            ));
        }
    }
    Ok(environment)
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic())
        || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    {
        return false;
    }
    let upper = key.to_ascii_uppercase();
    !upper.starts_with("LD_")
        && !upper.starts_with("DYLD_")
        && !upper.starts_with("PYTHON")
        && !upper.starts_with("PERL")
        && !upper.starts_with("RUBY")
        && !upper.starts_with("GIT_")
        && !upper.starts_with("LC_")
        && !matches!(
            upper.as_str(),
            "PATH"
                | "LANG"
                | "BASH_ENV"
                | "ENV"
                | "IFS"
                | "SHELLOPTS"
                | "GCONV_PATH"
                | "NODE_OPTIONS"
                | "JAVA_TOOL_OPTIONS"
                | "_JAVA_OPTIONS"
                | "SSH_AUTH_SOCK"
                | "DBUS_SESSION_BUS_ADDRESS"
        )
}

fn validate_duration(
    value: Duration,
    minimum: Duration,
    maximum: Duration,
    name: &str,
) -> Result<()> {
    if value < minimum || value > maximum {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{name} is outside its supported range"),
        ));
    }
    Ok(())
}

fn validate_serializable_duration(value: Duration, unit: Duration, name: &str) -> Result<()> {
    if value.as_nanos() % unit.as_nanos() != 0 {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{name} cannot be represented by configuration schema v1"),
        ));
    }
    Ok(())
}

fn push_config_line(output: &mut String, key: &str, value: &str) {
    output.push_str(key);
    output.push_str(" = ");
    output.push_str(value);
    output.push('\n');
}

fn quote_config(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

fn utf8_path<'a>(path: &'a Path, label: &str) -> Result<&'a str> {
    if !path.is_absolute() {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{label} must be an absolute path"),
        ));
    }
    let value = path.to_str().ok_or_else(|| {
        Error::new(
            ErrorKind::Config,
            format!("{label} must be valid UTF-8 for configuration schema v1"),
        )
    })?;
    if value.len() > 4096 {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{label} is too long"),
        ));
    }
    if contains_unsupported_control(value) {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{label} contains a control character unsupported by schema v1"),
        ));
    }
    Ok(value)
}

fn contains_unsupported_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn validate_component_name(value: &str, maximum: usize, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > maximum
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(Error::new(
            ErrorKind::Config,
            format!("{label} name is invalid"),
        ));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<&str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(Error::new(
            ErrorKind::Config,
            "executable_sha256 must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(value)
}

fn parse_u32(value: &str, minimum: u32, maximum: u32) -> Result<u32> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| Error::new(ErrorKind::Config, format!("'{value}' is not an integer")))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(Error::new(
            ErrorKind::Config,
            format!("integer {parsed} is outside {minimum}..={maximum}"),
        ));
    }
    Ok(parsed)
}

fn parse_bool(value: &str) -> Result<bool> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(Error::new(
            ErrorKind::Config,
            format!("'{value}' must be true or false"),
        )),
    }
}

fn parse_wifi(value: &str) -> Result<WifiPolicy> {
    match value {
        "any" => Ok(WifiPolicy::Any),
        "disabled" => Ok(WifiPolicy::Disabled),
        _ => {
            let interface = value.strip_prefix("interface:").ok_or_else(|| {
                Error::new(
                    ErrorKind::Config,
                    "wifi must be any, disabled, or interface:NAME",
                )
            })?;
            if interface.is_empty()
                || interface.len() > 15
                || !interface
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            {
                return Err(Error::new(
                    ErrorKind::Config,
                    "Wi-Fi interface name is invalid",
                ));
            }
            Ok(WifiPolicy::Interface(interface.to_owned()))
        }
    }
}

fn parse_power(value: &str) -> Result<PowerPolicy> {
    match value {
        "auto" => Ok(PowerPolicy::Auto),
        "required" => Ok(PowerPolicy::Required),
        "ignore" => Ok(PowerPolicy::Ignore),
        _ => Err(Error::new(
            ErrorKind::Config,
            "power must be auto, required, or ignore",
        )),
    }
}

fn parse_idle(value: &str) -> Result<IdleMode> {
    match value {
        "logind-user" => Ok(IdleMode::LogindUser),
        "disabled" => Ok(IdleMode::Disabled),
        _ => {
            let seat = value.strip_prefix("logind-seat:").ok_or_else(|| {
                Error::new(
                    ErrorKind::Config,
                    "idle must be logind-user, logind-seat:NAME, or disabled",
                )
            })?;
            if seat.is_empty()
                || seat.len() > 64
                || !seat
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            {
                return Err(Error::new(ErrorKind::Config, "logind seat is invalid"));
            }
            Ok(IdleMode::LogindSeat(seat.to_owned()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn valid_config() -> &'static str {
        r#"
schema_version = 1
name = nightly-backup
executable = /usr/bin/true
arg = "--literal ; $(touch /tmp/no)"
working_directory = /tmp
env = "BACKUP_PROFILE=nightly"
executable_sha256 = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
window = 01:00-06:00
poll_seconds = 600
guard_milliseconds = 250
start_stability_seconds = 2
idle_seconds = 900
wifi = any
power = auto
idle = logind-seat:seat0
stop_grace_seconds = 5
max_runtime_seconds = 14400
max_attempts_per_window = 3
retry_on_failure = false
retry_after_guard_loss = true
state_file = /tmp/idlepilot/state
"#
    }

    #[test]
    fn parses_strict_configuration() {
        let config = Config::parse(valid_config()).expect("valid config");
        assert_eq!(config.name, "nightly-backup");
        assert_eq!(config.args, vec!["--literal ; $(touch /tmp/no)"]);
        assert_eq!(config.poll_interval, Duration::from_secs(600));
        assert!(config.window.contains(60));
        assert!(!config.window.contains(360));
    }

    #[test]
    fn rejects_unknown_and_duplicate_keys() {
        assert!(Config::parse(&format!("{}\nunknown = x", valid_config())).is_err());
        assert!(Config::parse(&format!("{}\nname = other", valid_config())).is_err());
    }

    #[test]
    fn quoted_values_require_embedded_quotes_to_be_escaped() {
        assert!(parse_value(r#""a"b""#).is_err());
        assert!(parse_value(r#""a"""#).is_err());
        assert_eq!(parse_value(r#""a\"b""#).expect("escaped quote"), "a\"b");
    }

    #[test]
    fn time_window_wraps_midnight() {
        let window = TimeWindow::parse("23:00-02:00").expect("window");
        assert!(window.contains(23 * 60));
        assert!(window.contains(60));
        assert!(!window.contains(12 * 60));
    }

    #[test]
    fn dangerous_loader_environment_is_rejected() {
        let config = valid_config().replace(
            "env = \"BACKUP_PROFILE=nightly\"",
            "env = \"LD_PRELOAD=/tmp/evil.so\"",
        );
        assert!(Config::parse(&config).is_err());
    }

    #[test]
    fn fixed_runner_environment_cannot_be_overridden() {
        for entry in [
            "PATH=/attacker/bin",
            "LANG=attacker",
            "NODE_OPTIONS=--require=/tmp/evil.js",
            "GIT_SSH_COMMAND=/tmp/evil",
            "PYTHONSTARTUP=/tmp/evil.py",
        ] {
            let config = valid_config().replace(
                "env = \"BACKUP_PROFILE=nightly\"",
                &format!("env = \"{entry}\""),
            );
            assert!(Config::parse(&config).is_err(), "{entry} was accepted");
        }
    }

    #[test]
    fn active_guard_leaves_time_for_the_bounded_probe() {
        let config = valid_config().replace("guard_milliseconds = 250", "guard_milliseconds = 251");
        assert!(Config::parse(&config).is_err());
    }

    #[test]
    fn waiting_poll_cannot_be_later_than_ten_minutes() {
        let config = valid_config().replace("poll_seconds = 600", "poll_seconds = 601");
        assert!(Config::parse(&config).is_err());
    }

    #[test]
    fn canonical_text_round_trips_literal_arguments_and_sorted_environment() {
        let mut config = Config::parse(valid_config()).expect("valid config");
        config
            .args
            .push("line one\nline two \\\"quoted\\\"".to_owned());
        config
            .environment
            .insert("ALPHA".to_owned(), "first".to_owned());
        let text = config.to_canonical_text().expect("canonical text");
        assert!(text.find("env = \"ALPHA=first\"") < text.find("env = \"BACKUP_PROFILE=nightly\""));
        let reparsed = Config::parse(&text).expect("reparse canonical text");
        assert_eq!(reparsed.name, config.name);
        assert_eq!(reparsed.executable, config.executable);
        assert_eq!(reparsed.args, config.args);
        assert_eq!(reparsed.environment, config.environment);
        assert_eq!(reparsed.window, config.window);
        assert_eq!(reparsed.max_runtime, config.max_runtime);
    }

    #[test]
    fn constructor_uses_documented_conservative_defaults() {
        let config = Config::new("photos", "/usr/bin/true", "/tmp/idlepilot/photos.state")
            .expect("default config");
        assert_eq!(config.window.canonical(), "01:00-06:00");
        assert_eq!(config.guard_interval, Duration::from_millis(250));
        assert_eq!(config.max_runtime, Some(Duration::from_secs(14_400)));
        assert_eq!(config.max_attempts_per_window, 3);
        assert!(config.retry_after_guard_loss);
        assert!(config.executable_sha256.is_none());
        assert!(Config::new("relative", "bin/task", "/tmp/state").is_err());
        assert!(Config::new("relative", "/usr/bin/true", "state/task").is_err());
    }

    #[test]
    fn read_only_validation_never_creates_a_missing_state_parent() {
        let parent = std::env::current_dir()
            .expect("current directory")
            .join("target")
            .join(format!("read-only-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        let config =
            Config::new("read-only", "/usr/bin/true", parent.join("state")).expect("configuration");
        assert!(config.validate().is_err());
        assert!(!parent.exists(), "validation mutated the filesystem");
    }

    #[test]
    fn canonical_writer_rejects_non_utf8_paths_instead_of_changing_them() {
        let mut config = Config::new("non-utf8", "/usr/bin/true", "/tmp/idlepilot/state")
            .expect("configuration");
        config.state_file = PathBuf::from(std::ffi::OsString::from_vec(vec![b'/', b't', 0xff]));
        let error = config
            .to_canonical_text()
            .expect_err("non-UTF-8 path must be rejected");
        assert_eq!(error.kind(), ErrorKind::Config);
    }

    #[test]
    fn canonical_writer_rejects_mutated_paths_the_reader_cannot_accept() {
        for field in ["executable", "working_directory", "state_file"] {
            let mut relative = Config::new("relative", "/usr/bin/true", "/tmp/idlepilot/state")
                .expect("configuration");
            match field {
                "executable" => relative.executable = PathBuf::from("bin/task"),
                "working_directory" => relative.working_directory = PathBuf::from("work"),
                "state_file" => relative.state_file = PathBuf::from("state/task"),
                _ => unreachable!(),
            }
            assert!(
                relative.to_canonical_text().is_err(),
                "relative {field} was serialized"
            );

            let mut oversized = Config::new("oversized", "/usr/bin/true", "/tmp/idlepilot/state")
                .expect("configuration");
            let path = PathBuf::from(format!("/{}", "x".repeat(4096)));
            match field {
                "executable" => oversized.executable = path,
                "working_directory" => oversized.working_directory = path,
                "state_file" => oversized.state_file = path,
                _ => unreachable!(),
            }
            assert!(
                oversized.to_canonical_text().is_err(),
                "oversized {field} was serialized"
            );
        }
    }

    #[test]
    fn canonical_writer_rejects_unrepresentable_control_characters() {
        let mut config = Config::new("controls", "/usr/bin/true", "/tmp/idlepilot/state")
            .expect("configuration");
        config.args.push("bad\u{1}argument".to_owned());
        assert!(config.to_canonical_text().is_err());

        config.args.clear();
        config
            .environment
            .insert("PROFILE".to_owned(), "bad\u{7}value".to_owned());
        assert!(config.to_canonical_text().is_err());

        config.environment.clear();
        config.working_directory = PathBuf::from("/tmp/bad\u{1}path");
        assert!(config.to_canonical_text().is_err());
    }

    #[test]
    fn canonical_writer_never_emits_more_than_the_reader_accepts() {
        let mut config =
            Config::new("large", "/usr/bin/true", "/tmp/idlepilot/state").expect("configuration");
        config.args = (0..256).map(|_| "x".repeat(1_100)).collect();
        let error = config
            .to_canonical_text()
            .expect_err("oversized canonical output must fail");
        assert_eq!(error.kind(), ErrorKind::Config);

        let mut expanded = Config::new("expanded", "/usr/bin/true", "/tmp/idlepilot/state")
            .expect("configuration");
        expanded.args.push("\\".repeat(40_000));
        let error = expanded
            .to_canonical_text()
            .expect_err("escaping must not emit a line the reader rejects");
        assert_eq!(error.kind(), ErrorKind::Config);
    }

    #[test]
    fn state_fingerprint_is_format_independent_but_semantically_bound() {
        let original = Config::parse(valid_config()).expect("original config");
        let reformatted = Config::parse(&format!(
            "# unrelated comment\n{}",
            original.to_canonical_text().expect("canonical config")
        ))
        .expect("reformatted config");
        assert_eq!(
            original.state_fingerprint().expect("original fingerprint"),
            reformatted
                .state_fingerprint()
                .expect("reformatted fingerprint")
        );
        let mut changed = original.clone();
        changed.name = "different-task".to_owned();
        assert_ne!(
            original.state_fingerprint().expect("original fingerprint"),
            changed.state_fingerprint().expect("changed fingerprint")
        );
    }

    #[test]
    fn state_fingerprint_has_a_documented_known_vector() {
        let config = Config::new(
            "fingerprint-vector",
            "/usr/bin/true",
            "/tmp/idlepilot/fingerprint.state",
        )
        .expect("configuration");
        assert_eq!(
            config.state_fingerprint().expect("fingerprint"),
            "52e8bc395ec1ef8f622936e9fa371bf39bdd53f9748e9e8936bfdb1175982eb5"
        );
    }
}
