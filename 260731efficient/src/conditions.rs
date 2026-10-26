use crate::clock::{Clock, LocalDateTime, SystemClock};
use crate::config::{Config, IdleMode, PowerPolicy, WifiPolicy};
use crate::error::{Error, ErrorKind, Result};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Three-state condition result. Unknown always fails closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionState {
    /// The requirement is proven true.
    Met,
    /// The requirement is proven false.
    NotMet,
    /// The provider could not prove either state.
    Unknown,
}

impl ConditionState {
    /// Stable machine representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Met => "met",
            Self::NotMet => "not_met",
            Self::Unknown => "unknown",
        }
    }
}

/// One condition and a bounded, non-secret reason code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionStatus {
    /// Tri-state outcome.
    pub state: ConditionState,
    /// Stable snake-case reason.
    pub reason: &'static str,
}

impl ConditionStatus {
    const fn met(reason: &'static str) -> Self {
        Self {
            state: ConditionState::Met,
            reason,
        }
    }

    const fn not_met(reason: &'static str) -> Self {
        Self {
            state: ConditionState::NotMet,
            reason,
        }
    }

    const fn unknown(reason: &'static str) -> Self {
        Self {
            state: ConditionState::Unknown,
            reason,
        }
    }
}

/// Atomic view of all gating inputs.
#[derive(Debug, Clone)]
pub struct ConditionSnapshot {
    /// Wi-Fi link condition.
    pub wifi: ConditionStatus,
    /// External power condition.
    pub power: ConditionStatus,
    /// User-idle condition.
    pub idle: ConditionStatus,
    /// Local-time window condition.
    pub window: ConditionStatus,
    /// Local time used for this evaluation.
    pub local_time: Option<LocalDateTime>,
    /// Monotonic observation time.
    pub observed_monotonic: Duration,
}

impl ConditionSnapshot {
    /// True only when every provider proves its requirement.
    #[must_use]
    pub fn all_met(&self) -> bool {
        [&self.wifi, &self.power, &self.idle, &self.window]
            .iter()
            .all(|status| status.state == ConditionState::Met)
    }

    /// First fail-closed reason, in safety-priority order.
    #[must_use]
    pub fn first_blocker(&self) -> Option<&'static str> {
        [&self.window, &self.idle, &self.power, &self.wifi]
            .iter()
            .find(|status| status.state != ConditionState::Met)
            .map(|status| status.reason)
    }
}

/// Injected source of complete condition snapshots.
pub trait Probe {
    /// Evaluate all conditions.
    fn snapshot(&mut self) -> ConditionSnapshot;
}

/// Linux sysfs/logind condition provider.
pub struct LinuxProbe<C: Clock = SystemClock> {
    config: Config,
    clock: C,
    sys_root: PathBuf,
    proc_root: PathBuf,
    loginctl: Option<PathBuf>,
}

impl LinuxProbe<SystemClock> {
    /// Construct a provider using real Linux paths and the system clock.
    #[must_use]
    pub fn system(config: Config) -> Self {
        Self::new(
            config,
            SystemClock::new(),
            PathBuf::from("/sys"),
            PathBuf::from("/proc"),
        )
    }
}

impl<C: Clock> LinuxProbe<C> {
    /// Construct a provider with injectable filesystem roots for tests.
    #[must_use]
    pub fn new(config: Config, clock: C, sys_root: PathBuf, proc_root: PathBuf) -> Self {
        let loginctl = ["/usr/bin/loginctl", "/bin/loginctl"]
            .iter()
            .map(PathBuf::from)
            .find(|path| path.is_file());
        Self {
            config,
            clock,
            sys_root,
            proc_root,
            loginctl,
        }
    }

    fn wifi(&self) -> ConditionStatus {
        match &self.config.wifi {
            WifiPolicy::Disabled => ConditionStatus::met("wifi_disabled"),
            WifiPolicy::Any => inspect_wifi(&self.sys_root, None),
            WifiPolicy::Interface(interface) => {
                inspect_wifi(&self.sys_root, Some(interface.as_str()))
            }
        }
    }

    fn power(&self) -> ConditionStatus {
        inspect_power(&self.sys_root, self.config.power)
    }

    fn idle(&self) -> ConditionStatus {
        match &self.config.idle {
            IdleMode::Disabled => ConditionStatus::met("idle_disabled"),
            IdleMode::LogindSeat(seat) => self.logind_idle("show-seat", seat),
            IdleMode::LogindUser => {
                let uid = crate::security::current_euid().to_string();
                self.logind_idle("show-user", &uid)
            }
        }
    }

    fn logind_idle(&self, operation: &str, target: &str) -> ConditionStatus {
        let Some(loginctl) = self.loginctl.as_ref() else {
            return ConditionStatus::unknown("logind_unavailable");
        };
        let arguments = [
            operation,
            target,
            "--property=IdleHint",
            "--property=IdleSinceHintMonotonic",
            "--no-pager",
        ];
        let Ok(output) = run_bounded(loginctl, &arguments, Duration::from_millis(250), 8192) else {
            return ConditionStatus::unknown("logind_query_failed");
        };
        let Ok(text) = std::str::from_utf8(&output) else {
            return ConditionStatus::unknown("logind_invalid_output");
        };
        let mut hint = None;
        let mut since = None;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("IdleHint=") {
                if hint.replace(value).is_some() {
                    return ConditionStatus::unknown("logind_duplicate_property");
                }
            } else if let Some(value) = line.strip_prefix("IdleSinceHintMonotonic=") {
                if since.replace(value).is_some() {
                    return ConditionStatus::unknown("logind_duplicate_property");
                }
            }
        }
        match hint {
            Some("no" | "false") => ConditionStatus::not_met("user_active"),
            Some("yes" | "true") => {
                if self.config.idle_minimum.is_zero() {
                    return ConditionStatus::met("user_idle");
                }
                let Some(since) = since.and_then(|value| value.parse::<u64>().ok()) else {
                    return ConditionStatus::unknown("idle_since_unavailable");
                };
                if since == 0 {
                    return ConditionStatus::unknown("idle_since_unavailable");
                }
                let Some(now) = proc_uptime_microseconds(&self.proc_root) else {
                    return ConditionStatus::unknown("monotonic_uptime_unavailable");
                };
                let elapsed = now.saturating_sub(since);
                let required =
                    u64::try_from(self.config.idle_minimum.as_micros()).unwrap_or(u64::MAX);
                if elapsed >= required {
                    ConditionStatus::met("idle_minimum_met")
                } else {
                    ConditionStatus::not_met("idle_minimum_not_met")
                }
            }
            _ => ConditionStatus::unknown("logind_idle_hint_missing"),
        }
    }
}

impl<C: Clock> Probe for LinuxProbe<C> {
    fn snapshot(&mut self) -> ConditionSnapshot {
        let local_time = self.clock.local_now();
        let window = match local_time {
            Ok(local) if self.config.window.contains(local.minute_of_day()) => {
                ConditionStatus::met("inside_window")
            }
            Ok(_) => ConditionStatus::not_met("outside_window"),
            Err(_) => ConditionStatus::unknown("local_time_unavailable"),
        };
        ConditionSnapshot {
            wifi: self.wifi(),
            power: self.power(),
            idle: self.idle(),
            window,
            local_time: local_time.ok(),
            observed_monotonic: self.clock.monotonic(),
        }
    }
}

fn inspect_wifi(sys_root: &Path, selected: Option<&str>) -> ConditionStatus {
    let net = sys_root.join("class/net");
    let Ok(entries) = fs::read_dir(net) else {
        return ConditionStatus::unknown("network_sysfs_unavailable");
    };
    let mut found_wireless = false;
    let mut unreadable = false;
    for entry in entries {
        let Ok(entry) = entry else {
            unreadable = true;
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            unreadable = true;
            continue;
        };
        if selected.is_some_and(|wanted| wanted != name) {
            continue;
        }
        let path = entry.path();
        let wireless = path.join("wireless").exists()
            || path.join("phy80211").exists()
            || read_small(path.join("uevent"), 4096)
                .is_some_and(|value| value.lines().any(|line| line == "DEVTYPE=wlan"));
        if !wireless {
            continue;
        }
        found_wireless = true;
        let carrier = read_trimmed(path.join("carrier"));
        let dormant = read_trimmed(path.join("dormant"));
        let operstate = read_trimmed(path.join("operstate"));
        match (carrier.as_deref(), dormant.as_deref(), operstate.as_deref()) {
            (Some("1"), Some("0") | None, Some("up" | "unknown")) => {
                return ConditionStatus::met("wifi_carrier_online");
            }
            (Some("0"), _, _) | (_, Some("1"), _) | (Some("1"), _, Some(_)) => {}
            _ => unreadable = true,
        }
    }
    if !found_wireless {
        if selected.is_some() {
            ConditionStatus::not_met("selected_wifi_missing")
        } else {
            ConditionStatus::not_met("no_wireless_interface")
        }
    } else if unreadable {
        ConditionStatus::unknown("wifi_state_incomplete")
    } else {
        ConditionStatus::not_met("wifi_disconnected")
    }
}

fn inspect_power(sys_root: &Path, policy: PowerPolicy) -> ConditionStatus {
    if policy == PowerPolicy::Ignore {
        return ConditionStatus::met("power_ignored");
    }
    let root = sys_root.join("class/power_supply");
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) if policy == PowerPolicy::Auto => {
            return ConditionStatus::unknown("power_sysfs_unavailable");
        }
        Err(_) => return ConditionStatus::unknown("power_sysfs_unavailable"),
    };
    let mut system_battery = false;
    let mut external_online = false;
    let mut unreadable = false;
    for entry in entries {
        let Ok(entry) = entry else {
            unreadable = true;
            continue;
        };
        let path = entry.path();
        let Some(kind) = read_trimmed(path.join("type")) else {
            unreadable = true;
            continue;
        };
        if kind == "Battery" {
            let scope = read_trimmed(path.join("scope"));
            if scope.as_deref() != Some("Device") {
                system_battery = true;
            }
            continue;
        }
        if !is_external_power_type(&kind) {
            // An unrecognized kernel/driver value cannot prove that this is a
            // stationary system with no battery. Treat future or malformed
            // inventory types as incomplete instead of silently ignoring
            // them under the auto policy.
            unreadable = true;
            continue;
        }
        let present = read_trimmed(path.join("present"));
        let online = read_trimmed(path.join("online"));
        match (present.as_deref(), online.as_deref()) {
            (Some("0"), _) | (_, Some("0")) => {}
            (_, Some("1")) => external_online = true,
            _ => unreadable = true,
        }
    }
    if external_online {
        return ConditionStatus::met("external_power_online");
    }
    match policy {
        PowerPolicy::Required if unreadable => {
            ConditionStatus::unknown("external_power_state_incomplete")
        }
        PowerPolicy::Required => ConditionStatus::not_met("external_power_offline"),
        PowerPolicy::Auto if unreadable => {
            ConditionStatus::unknown("power_supply_inventory_incomplete")
        }
        PowerPolicy::Auto if system_battery => {
            ConditionStatus::not_met("portable_without_external_power")
        }
        PowerPolicy::Auto => match inspect_chassis_mobility(sys_root) {
            ChassisMobility::Stationary => ConditionStatus::met("stationary_system_no_battery"),
            ChassisMobility::Portable => {
                ConditionStatus::not_met("portable_without_external_power")
            }
            ChassisMobility::Unknown => ConditionStatus::unknown("chassis_mobility_unknown"),
        },
        PowerPolicy::Ignore => ConditionStatus::met("power_ignored"),
    }
}

#[derive(Clone, Copy)]
enum ChassisMobility {
    Portable,
    Stationary,
    Unknown,
}

fn inspect_chassis_mobility(sys_root: &Path) -> ChassisMobility {
    let value = [
        sys_root.join("class/dmi/id/chassis_type"),
        sys_root.join("devices/virtual/dmi/id/chassis_type"),
    ]
    .into_iter()
    .find_map(read_trimmed)
    .and_then(|value| value.parse::<u8>().ok());
    match value {
        // SMBIOS portable, laptop, notebook, handheld, sub-notebook, tablet,
        // convertible, and detachable chassis types.
        Some(8..=11 | 14 | 30..=32) => ChassisMobility::Portable,
        // Explicitly enumerated stationary SMBIOS chassis types. New values
        // remain unknown until reviewed so a future portable type cannot pass.
        Some(3..=7 | 12..=13 | 15..=29 | 33..=36) => ChassisMobility::Stationary,
        _ => ChassisMobility::Unknown,
    }
}

fn is_external_power_type(kind: &str) -> bool {
    matches!(
        kind,
        "UPS"
            | "Mains"
            | "USB"
            | "USB_DCP"
            | "USB_CDP"
            | "USB_ACA"
            | "USB_C"
            | "USB_PD"
            | "USB_PD_DRP"
            | "BrickID"
            | "Wireless"
    )
}

fn read_trimmed(path: PathBuf) -> Option<String> {
    read_small(path, 4096).map(|value| value.trim().to_owned())
}

fn read_small(path: PathBuf, maximum: u64) -> Option<String> {
    let metadata = fs::metadata(&path).ok()?;
    if metadata.len() > maximum {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn proc_uptime_microseconds(proc_root: &Path) -> Option<u64> {
    let uptime = fs::read_to_string(proc_root.join("uptime")).ok()?;
    let first = uptime.split_whitespace().next()?;
    let (whole, fractional) = first.split_once('.').unwrap_or((first, ""));
    let seconds = whole.parse::<u64>().ok()?;
    let mut micros = 0u64;
    for (index, byte) in fractional.bytes().take(6).enumerate() {
        if !byte.is_ascii_digit() {
            return None;
        }
        let position = u32::try_from(index).expect("fraction is limited to six digits");
        micros += u64::from(byte - b'0') * 10u64.pow(5 - position);
    }
    Some(seconds.saturating_mul(1_000_000).saturating_add(micros))
}

fn run_bounded(
    executable: &Path,
    arguments: &[&str],
    timeout: Duration,
    output_limit: usize,
) -> Result<Vec<u8>> {
    let mut child = Command::new(executable)
        .args(arguments)
        .env_clear()
        .env("LANG", "C")
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| Error::io(ErrorKind::Probe, "cannot start condition adapter", error))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(Error::new(
                        ErrorKind::Probe,
                        "condition adapter exited unsuccessfully",
                    ));
                }
                let mut output = Vec::new();
                let mut stdout = child.stdout.take().ok_or_else(|| {
                    Error::new(ErrorKind::Probe, "condition adapter stdout is missing")
                })?;
                stdout
                    .by_ref()
                    .take((output_limit + 1) as u64)
                    .read_to_end(&mut output)
                    .map_err(|error| {
                        Error::io(ErrorKind::Probe, "cannot read condition adapter", error)
                    })?;
                if output.len() > output_limit {
                    return Err(Error::new(
                        ErrorKind::Probe,
                        "condition adapter output exceeds limit",
                    ));
                }
                return Ok(output);
            }
            Ok(None) if started.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(ErrorKind::Probe, "condition adapter timed out"));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::io(
                    ErrorKind::Probe,
                    "cannot wait for condition adapter",
                    error,
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::LocalDateTime;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    struct FakeClock {
        local: LocalDateTime,
    }

    impl Clock for FakeClock {
        fn local_now(&self) -> Result<LocalDateTime> {
            Ok(self.local)
        }

        fn monotonic(&self) -> Duration {
            Duration::from_secs(10)
        }
    }

    fn temporary_root() -> PathBuf {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("idlepilot-conditions-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).expect("temp root");
        path
    }

    fn base_config(root: &Path) -> Config {
        Config::parse(&format!(
            r"
schema_version = 1
name = test
executable = /usr/bin/true
working_directory = {}
window = 01:00-06:00
poll_seconds = 600
guard_milliseconds = 250
start_stability_seconds = 0
idle_seconds = 0
wifi = any
power = auto
idle = disabled
stop_grace_seconds = 1
max_attempts_per_window = 1
retry_on_failure = false
retry_after_guard_loss = true
state_file = {}/state
",
            root.display(),
            root.display()
        ))
        .expect("config")
    }

    #[test]
    fn detects_connected_wireless_interface() {
        let root = temporary_root();
        let sys = root.join("sys");
        let proc = root.join("proc");
        let device = sys.join("devices/wlan0");
        fs::create_dir_all(device.join("wireless")).expect("wireless");
        fs::write(device.join("carrier"), "1\n").expect("carrier");
        fs::write(device.join("dormant"), "0\n").expect("dormant");
        fs::write(device.join("operstate"), "up\n").expect("operstate");
        fs::create_dir_all(sys.join("class/net")).expect("class");
        symlink(&device, sys.join("class/net/wlan0")).expect("link");
        fs::create_dir_all(sys.join("class/power_supply")).expect("power");
        fs::create_dir_all(sys.join("class/dmi/id")).expect("dmi");
        fs::write(sys.join("class/dmi/id/chassis_type"), "3\n").expect("desktop chassis");
        fs::create_dir_all(&proc).expect("proc");
        fs::write(proc.join("uptime"), "100.00 50.00\n").expect("uptime");
        let mut probe = LinuxProbe::new(
            base_config(&root),
            FakeClock {
                local: LocalDateTime {
                    year: 2026,
                    year_day: 1,
                    hour: 2,
                    minute: 0,
                    second: 0,
                },
            },
            sys,
            proc,
        );
        let snapshot = probe.snapshot();
        assert_eq!(snapshot.wifi.state, ConditionState::Met);
        assert_eq!(snapshot.power.state, ConditionState::Met);
        assert!(snapshot.all_met());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn portable_without_ac_fails_closed() {
        let root = temporary_root();
        let power = root.join("sys/class/power_supply/BAT0");
        fs::create_dir_all(&power).expect("battery");
        fs::write(power.join("type"), "Battery\n").expect("type");
        fs::write(power.join("scope"), "System\n").expect("scope");
        let status = inspect_power(&root.join("sys"), PowerPolicy::Auto);
        assert_eq!(status.state, ConditionState::NotMet);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn portable_chassis_without_a_battery_driver_still_requires_power() {
        let root = temporary_root();
        fs::create_dir_all(root.join("sys/class/power_supply")).expect("power inventory");
        let dmi = root.join("sys/class/dmi/id");
        fs::create_dir_all(&dmi).expect("dmi");
        fs::write(dmi.join("chassis_type"), "10\n").expect("notebook chassis");
        let status = inspect_power(&root.join("sys"), PowerPolicy::Auto);
        assert_eq!(status.state, ConditionState::NotMet);
        assert_eq!(status.reason, "portable_without_external_power");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_chassis_and_battery_inventory_is_unknown() {
        let root = temporary_root();
        fs::create_dir_all(root.join("sys/class/power_supply")).expect("power inventory");
        let status = inspect_power(&root.join("sys"), PowerPolicy::Auto);
        assert_eq!(status.state, ConditionState::Unknown);
        assert_eq!(status.reason, "chassis_mobility_unknown");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unreadable_power_supply_type_does_not_become_a_desktop() {
        let root = temporary_root();
        fs::create_dir_all(root.join("sys/class/power_supply/BAT0")).expect("unknown power supply");
        let status = inspect_power(&root.join("sys"), PowerPolicy::Auto);
        assert_eq!(status.state, ConditionState::Unknown);
        assert_eq!(status.reason, "power_supply_inventory_incomplete");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_power_supply_type_does_not_become_a_desktop() {
        let root = temporary_root();
        let supply = root.join("sys/class/power_supply/mystery");
        fs::create_dir_all(&supply).expect("unknown power supply");
        fs::write(supply.join("type"), "Unknown\n").expect("unknown type");
        let status = inspect_power(&root.join("sys"), PowerPolicy::Auto);
        assert_eq!(status.state, ConditionState::Unknown);
        assert_eq!(status.reason, "power_supply_inventory_incomplete");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uptime_parser_handles_fraction() {
        let root = temporary_root();
        fs::write(root.join("uptime"), "123.45 90.00\n").expect("uptime");
        assert_eq!(proc_uptime_microseconds(&root), Some(123_450_000));
        let _ = fs::remove_dir_all(root);
    }
}
