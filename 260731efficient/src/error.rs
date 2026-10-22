use std::fmt::{Display, Formatter};
use std::io;

/// Coarse, stable error classification used by the library and JSON CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorKind {
    /// Invalid command-line input.
    Usage,
    /// A configuration file is malformed or unsafe.
    Config,
    /// A required condition could not be observed.
    Probe,
    /// A process could not be started or supervised.
    Process,
    /// A state or lock file operation failed.
    State,
    /// A security invariant was not met.
    Security,
    /// An operating-system operation failed.
    Os,
    /// An internal invariant was violated.
    Internal,
}

impl ErrorKind {
    /// Stable snake-case representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Usage => "usage",
            Self::Config => "config",
            Self::Probe => "probe",
            Self::Process => "process",
            Self::State => "state",
            Self::Security => "security",
            Self::Os => "os",
            Self::Internal => "internal",
        }
    }
}

/// Library error carrying a stable kind and a human-readable message.
#[derive(Debug)]
pub struct Error {
    kind: ErrorKind,
    message: String,
    source: Option<io::Error>,
    process_exit_required: bool,
}

impl Error {
    /// Construct an error without an I/O source.
    #[must_use]
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            source: None,
            process_exit_required: false,
        }
    }

    /// Construct an error backed by an I/O error.
    #[must_use]
    pub fn io(kind: ErrorKind, context: impl AsRef<str>, source: io::Error) -> Self {
        Self {
            kind,
            message: format!("{}: {source}", context.as_ref()),
            source: Some(source),
            process_exit_required: false,
        }
    }

    /// Stable classification.
    #[must_use]
    pub const fn kind(&self) -> ErrorKind {
        self.kind
    }

    /// Human-readable detail without secrets added by the library.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Whether the caller must terminate the current process without doing
    /// potentially blocking output or cleanup.
    ///
    /// This is set only after the supervisor can no longer prove that its
    /// action group or background state writer is safely quiescent.
    #[must_use]
    pub const fn requires_process_exit(&self) -> bool {
        self.process_exit_required
    }

    /// Mark a fail-closed error as requiring immediate process termination.
    #[must_use]
    pub(crate) fn requiring_process_exit(mut self) -> Self {
        self.process_exit_required = true;
        self
    }
}

impl Display for Error {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

/// Library result alias.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_exit_requirement_is_explicit_and_sticky() {
        let ordinary = Error::new(ErrorKind::State, "ordinary");
        assert!(!ordinary.requires_process_exit());

        let terminal = ordinary.requiring_process_exit();
        assert!(terminal.requires_process_exit());
        assert_eq!(terminal.kind(), ErrorKind::State);
        assert_eq!(terminal.message(), "ordinary");
    }
}
