//! Content-addressed import for reviewed macro artifacts.

use crate::error::{Error, ErrorKind, Result};
use crate::{security, sha256};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
static IMPORT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Result of importing one immutable executable artifact.
#[derive(Debug, Clone)]
pub struct ImportedArtifact {
    /// Lowercase SHA-256.
    pub sha256: String,
    /// Content-addressed absolute path.
    pub path: PathBuf,
    /// Imported byte count.
    pub size: u64,
    /// Whether an identical artifact already existed.
    pub already_present: bool,
}

/// Copy a reviewed file into a private, content-addressed directory.
#[allow(
    clippy::too_many_lines,
    reason = "security-sensitive cleanup remains explicit at each commit stage"
)]
pub fn import(source: &Path, artifact_directory: &Path) -> Result<ImportedArtifact> {
    security::require_unprivileged_user()?;
    ensure_private_directory(artifact_directory)?;
    let sequence = IMPORT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = artifact_directory.join(format!(".import.{}.{}", std::process::id(), sequence));
    let mut input = security::open_secure_input_file(source, MAX_ARTIFACT_BYTES)?;
    let source_before = input
        .metadata()
        .map_err(|error| Error::io(ErrorKind::Security, "cannot inspect source artifact", error))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o500)
        .open(&temporary)
        .map_err(|error| {
            Error::io(
                ErrorKind::Security,
                "cannot create imported artifact",
                error,
            )
        })?;
    let copied = sha256::copy_and_digest(&mut input, &mut output, MAX_ARTIFACT_BYTES);
    let (size, digest) = match copied {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    let source_after = input.metadata().map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::io(
            ErrorKind::Security,
            "cannot re-inspect source artifact",
            error,
        )
    })?;
    if size != source_before.len() || metadata_identity_changed(&source_before, &source_after) {
        let _ = fs::remove_file(&temporary);
        return Err(Error::new(
            ErrorKind::Security,
            "source artifact changed while it was imported",
        ));
    }
    if let Err(error) = output.set_permissions(fs::Permissions::from_mode(0o500)) {
        let _ = fs::remove_file(&temporary);
        return Err(Error::io(
            ErrorKind::Security,
            "cannot secure imported artifact",
            error,
        ));
    }
    if let Err(error) = output.sync_all() {
        let _ = fs::remove_file(&temporary);
        return Err(Error::io(
            ErrorKind::Security,
            "cannot sync imported artifact",
            error,
        ));
    }
    let temporary_metadata = output.metadata().map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::io(
            ErrorKind::Security,
            "cannot inspect imported artifact",
            error,
        )
    })?;
    if !secure_artifact_metadata(&temporary_metadata, size, 1) {
        let _ = fs::remove_file(&temporary);
        return Err(Error::new(
            ErrorKind::Security,
            "temporary imported artifact has unsafe metadata",
        ));
    }
    drop(output);
    let destination = artifact_directory.join(&digest);
    let already_present = match fs::hard_link(&temporary, &destination) {
        Ok(()) => false,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if let Err(error) = validate_existing_artifact(&destination, &digest, size) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            true
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(Error::io(
                ErrorKind::Security,
                "cannot commit imported artifact",
                error,
            ));
        }
    };
    if let Err(error) = fs::remove_file(&temporary) {
        if !already_present {
            let _ = fs::remove_file(&destination);
        }
        return Err(Error::io(
            ErrorKind::Security,
            "cannot remove import temp file",
            error,
        ));
    }
    let destination_metadata = fs::symlink_metadata(&destination).map_err(|error| {
        Error::io(
            ErrorKind::Security,
            "cannot inspect committed artifact",
            error,
        )
    })?;
    if !secure_artifact_metadata(&destination_metadata, size, 1) {
        return Err(Error::new(
            ErrorKind::Security,
            "committed artifact has unsafe metadata",
        ));
    }
    File::open(artifact_directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| Error::io(ErrorKind::Security, "cannot sync artifact directory", error))?;
    Ok(ImportedArtifact {
        sha256: digest,
        path: destination,
        size,
        already_present,
    })
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::new(
            ErrorKind::Security,
            "artifact directory must be absolute",
        ));
    }
    let marker = path.join(".idlepilot-artifacts");
    // This creates missing components with 0700 and rejects existing symlinks
    // or writable ancestors before we mutate anything at `path`.
    security::ensure_state_parent(&marker)?;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)
    {
        Ok(file) => {
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .and_then(|()| file.sync_all())
                .map_err(|error| {
                    Error::io(
                        ErrorKind::Security,
                        "cannot initialize artifact directory",
                        error,
                    )
                })?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let file = security::open_secure_input_file(&marker, 0)?;
            let metadata = file.metadata().map_err(|error| {
                Error::io(
                    ErrorKind::Security,
                    "cannot inspect artifact directory marker",
                    error,
                )
            })?;
            if metadata.uid() != security::current_euid()
                || metadata.nlink() != 1
                || metadata.permissions().mode() & 0o777 != 0o600
            {
                return Err(Error::new(
                    ErrorKind::Security,
                    "artifact directory marker has unsafe metadata",
                ));
            }
        }
        Err(error) => {
            return Err(Error::io(
                ErrorKind::Security,
                "cannot initialize artifact directory",
                error,
            ));
        }
    }
    Ok(())
}

fn validate_existing_artifact(path: &Path, expected_digest: &str, size: u64) -> Result<()> {
    let file = security::open_secure_input_file(path, MAX_ARTIFACT_BYTES)?;
    let metadata = file.metadata().map_err(|error| {
        Error::io(
            ErrorKind::Security,
            "cannot inspect existing imported artifact",
            error,
        )
    })?;
    if !secure_artifact_metadata(&metadata, size, 1) {
        return Err(Error::new(
            ErrorKind::Security,
            "content-addressed destination has unsafe metadata",
        ));
    }
    let (actual_size, actual_digest) =
        sha256::copy_and_digest(file, io::sink(), MAX_ARTIFACT_BYTES)?;
    if actual_size != size || actual_digest != expected_digest {
        return Err(Error::new(
            ErrorKind::Security,
            "content-addressed destination has unexpected content",
        ));
    }
    Ok(())
}

fn secure_artifact_metadata(metadata: &fs::Metadata, size: u64, links: u64) -> bool {
    metadata.file_type().is_file()
        && metadata.uid() == security::current_euid()
        && metadata.nlink() == links
        && metadata.len() == size
        && metadata.permissions().mode() & 0o777 == 0o500
}

fn metadata_identity_changed(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::symlink;

    fn test_directory(label: &str) -> PathBuf {
        let sequence = IMPORT_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::current_dir()
            .expect("current test directory")
            .join("target")
            .join(format!(
                "idlepilot-artifact-{label}-{}-{sequence}",
                std::process::id()
            ))
    }

    #[test]
    fn artifact_directory_symlink_is_rejected_without_chmod_target() {
        let root = test_directory("symlink");
        let target = root.join("target");
        fs::create_dir_all(&target).expect("create target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).expect("secure target");
        let link = root.join("artifacts");
        symlink(&target, &link).expect("create artifact directory symlink");

        assert!(ensure_private_directory(&link).is_err());
        let metadata = fs::symlink_metadata(&target).expect("inspect target");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);

        fs::remove_dir_all(&root).expect("remove artifact test directory");
    }

    #[test]
    fn import_is_content_addressed_private_and_idempotent() {
        if security::current_euid() == 0 {
            return;
        }
        let root = test_directory("round-trip");
        fs::create_dir_all(&root).expect("create test root");
        let source = root.join("reviewed-source");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&source)
            .expect("create source");
        file.write_all(b"reviewed artifact bytes\n")
            .expect("write source");
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .expect("secure source");
        file.sync_all().expect("sync source");
        drop(file);

        let directory = root.join("artifacts");
        let first = import(&source, &directory).expect("first import");
        assert!(!first.already_present);
        let second = import(&source, &directory).expect("second import");
        assert!(second.already_present);
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.path, second.path);
        let metadata = fs::symlink_metadata(&first.path).expect("artifact metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o500);
        assert_eq!(metadata.nlink(), 1);

        fs::remove_dir_all(&root).expect("remove artifact test directory");
    }
}
