//! Linux local-time and monotonic-clock adapters.

#![allow(unsafe_code, reason = "small audited libc time adapter")]

use crate::config::TimeWindow;
use crate::error::{Error, ErrorKind, Result};
use std::os::raw::{c_char, c_int, c_long};
use std::time::{Duration, Instant};

#[cfg(not(target_pointer_width = "64"))]
compile_error!("idlepilot's localtime adapter currently requires a 64-bit Linux target");

#[repr(C)]
struct CTime {
    tm_sec: c_int,
    tm_min: c_int,
    tm_hour: c_int,
    tm_mday: c_int,
    tm_mon: c_int,
    tm_year: c_int,
    tm_wday: c_int,
    tm_yday: c_int,
    tm_isdst: c_int,
    tm_gmtoff: c_long,
    tm_zone: *const c_char,
}

unsafe extern "C" {
    fn time(timer: *mut c_long) -> c_long;
    fn localtime_r(timer: *const c_long, result: *mut CTime) -> *mut CTime;
}

/// Local civil time required by the scheduling policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalDateTime {
    /// Gregorian year.
    pub year: i32,
    /// Zero-based day of year.
    pub year_day: u16,
    /// Hour, 0-23.
    pub hour: u8,
    /// Minute, 0-59.
    pub minute: u8,
    /// Second, 0-60.
    pub second: u8,
}

impl LocalDateTime {
    /// Minute since local midnight.
    #[must_use]
    pub const fn minute_of_day(self) -> u16 {
        self.hour as u16 * 60 + self.minute as u16
    }

    /// Stable identifier for the current occurrence of a configured window.
    #[must_use]
    pub fn window_key(self, window: TimeWindow) -> Option<String> {
        if !window.contains(self.minute_of_day()) {
            return None;
        }
        let (mut year, mut year_day) = (self.year, self.year_day);
        if window.start_minute() > window.end_minute() && self.minute_of_day() < window.end_minute()
        {
            if year_day == 0 {
                year -= 1;
                year_day = if is_leap_year(year) { 365 } else { 364 };
            } else {
                year_day -= 1;
            }
        }
        Some(format!(
            "{year:04}-{day:03}@{}",
            window.canonical(),
            day = year_day + 1
        ))
    }
}

/// Injected local/monotonic clock seam.
pub trait Clock {
    /// Local civil time.
    fn local_now(&self) -> Result<LocalDateTime>;
    /// Monotonic time since this clock was created.
    fn monotonic(&self) -> Duration;
}

/// Linux/POSIX clock implementation.
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    /// Create a clock.
    #[must_use]
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn local_now(&self) -> Result<LocalDateTime> {
        let mut timestamp = 0;
        // SAFETY: `time` accepts a valid writable pointer.
        if unsafe { time(&raw mut timestamp) } == -1 {
            return Err(Error::new(ErrorKind::Os, "time() failed"));
        }
        let mut output = CTime {
            tm_sec: 0,
            tm_min: 0,
            tm_hour: 0,
            tm_mday: 0,
            tm_mon: 0,
            tm_year: 0,
            tm_wday: 0,
            tm_yday: 0,
            tm_isdst: 0,
            tm_gmtoff: 0,
            tm_zone: std::ptr::null(),
        };
        // SAFETY: both pointers are valid for the duration of the call.
        if unsafe { localtime_r(&raw const timestamp, &raw mut output) }.is_null() {
            return Err(Error::new(ErrorKind::Os, "localtime_r() failed"));
        }
        if !(0..=23).contains(&output.tm_hour)
            || !(0..=59).contains(&output.tm_min)
            || !(0..=60).contains(&output.tm_sec)
            || !(0..=365).contains(&output.tm_yday)
        {
            return Err(Error::new(
                ErrorKind::Os,
                "localtime_r returned invalid fields",
            ));
        }
        Ok(LocalDateTime {
            year: output.tm_year + 1900,
            year_day: u16::try_from(output.tm_yday)
                .map_err(|_| Error::new(ErrorKind::Os, "invalid local year day"))?,
            hour: u8::try_from(output.tm_hour)
                .map_err(|_| Error::new(ErrorKind::Os, "invalid local hour"))?,
            minute: u8::try_from(output.tm_min)
                .map_err(|_| Error::new(ErrorKind::Os, "invalid local minute"))?,
            second: u8::try_from(output.tm_sec)
                .map_err(|_| Error::new(ErrorKind::Os, "invalid local second"))?,
        })
    }

    fn monotonic(&self) -> Duration {
        self.origin.elapsed()
    }
}

const fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_midnight_uses_previous_day_key() {
        let window = TimeWindow::parse("23:00-03:00").expect("window");
        let before = LocalDateTime {
            year: 2026,
            year_day: 100,
            hour: 23,
            minute: 30,
            second: 0,
        };
        let after = LocalDateTime {
            year: 2026,
            year_day: 101,
            hour: 1,
            minute: 0,
            second: 0,
        };
        assert_eq!(before.window_key(window), after.window_key(window));
    }
}
