//! Minimal library client that inspects one configured household task.

use idlepilot::{Config, LaunchPlan, LinuxProbe, PersistentState, Probe, Result};
use std::path::Path;

fn main() -> Result<()> {
    let path = std::env::args_os().nth(1).ok_or_else(|| {
        idlepilot::Error::new(
            idlepilot::error::ErrorKind::Usage,
            "usage: readiness /absolute/task.conf",
        )
    })?;
    let config = Config::load_secure(Path::new(&path))?;
    let state = PersistentState::load_for_control(&config.state_file)?;
    let mut probe = LinuxProbe::system(config.clone());
    let plan = LaunchPlan::inspect(&config, probe.snapshot(), &state)?;
    println!(
        "{}: decision={} reason={} artifact={} attempts={}/{}",
        config.name,
        plan.decision.as_str(),
        plan.reason,
        plan.artifact.as_str(),
        plan.effective_attempts,
        plan.max_attempts
    );
    Ok(())
}
