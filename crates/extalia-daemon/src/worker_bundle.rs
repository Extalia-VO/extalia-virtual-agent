//! Bounded bundle observations, never execution authority or an atomic filesystem snapshot.
//! The independently supplied expected digest must come from trusted composition code.
mod manifest;
#[cfg(test)]
mod tests;
#[cfg(unix)]
mod unix;

pub use manifest::{BundleFile, BundleManifest, BundleRole, BundleTarget, parse_manifest};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const MAX_MANIFEST_BYTES: usize = 1_048_576;
pub const MAX_FILES: usize = 4096;
pub const MAX_FILE_BYTES: u64 = 134_217_728;
pub const MAX_TOTAL_BYTES: u64 = 536_870_912;
pub const MAX_DIRECTORIES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleRefusal {
    InvalidPin,
    ManifestLimit,
    ManifestDigestMismatch,
    InvalidManifest,
    TargetMismatch,
    UnsupportedPlatform,
    InvalidRoot,
    UnsafeEntry,
    TreeMismatch,
    TreeChanged,
    SizeMismatch,
    DigestMismatch,
    LimitExceeded,
    IoUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleObservation {
    pub manifest_sha256: String,
    pub target: BundleTarget,
    pub runtime_version: String,
    pub worker_version: String,
    pub file_count: usize,
    pub total_bytes: u64,
}
impl BundleObservation {
    pub fn launch_eligible(&self) -> bool {
        false
    }
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub(super) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Read only; no resolved launch path or ProbeConfig conversion is returned.
/// The root and its ancestors must be trusted and quiescent. Concurrent hostile
/// namespace writers are outside the side-effect-free observation boundary:
/// identity checks reject a replaced device before reading, not before open.
/// Unix checks use descriptor-relative, no-follow/nonblocking opens; unsupported
/// platforms refuse before opening the root. OS I/O itself is not time bounded.
pub fn observe_bundle(
    root: &Path,
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<BundleObservation, BundleRefusal> {
    if !valid_digest(expected_sha256) {
        return Err(BundleRefusal::InvalidPin);
    }
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(BundleRefusal::ManifestLimit);
    }
    if sha256_hex(bytes) != expected_sha256 {
        return Err(BundleRefusal::ManifestDigestMismatch);
    }
    let manifest = parse_manifest(bytes)?;
    if !manifest.target.is_current() {
        return Err(BundleRefusal::TargetMismatch);
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        Err(BundleRefusal::UnsupportedPlatform)
    }
    #[cfg(unix)]
    {
        let total_bytes = unix::observe(root, &manifest)?;
        Ok(BundleObservation {
            manifest_sha256: expected_sha256.to_owned(),
            target: manifest.target,
            runtime_version: manifest.runtime_version,
            worker_version: manifest.worker_version,
            file_count: manifest.files.len(),
            total_bytes,
        })
    }
}
