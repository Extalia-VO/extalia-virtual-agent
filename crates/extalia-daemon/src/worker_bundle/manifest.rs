use super::{
    BundleRefusal, MAX_FILE_BYTES, MAX_FILES, MAX_MANIFEST_BYTES, MAX_TOTAL_BYTES, valid_digest,
};
use crate::worker_protocol::valid_version;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleTarget {
    pub os: String,
    pub arch: String,
}
impl BundleTarget {
    pub fn is_current(&self) -> bool {
        self.os == std::env::consts::OS && self.arch == std::env::consts::ARCH
    }
    fn valid(&self) -> bool {
        matches!(self.os.as_str(), "macos" | "linux" | "windows")
            && matches!(self.arch.as_str(), "x86_64" | "aarch64")
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BundleRole {
    Interpreter,
    EntryScript,
    Support,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleFile {
    pub path: String,
    pub role: BundleRole,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleManifest {
    pub target: BundleTarget,
    pub runtime_version: String,
    pub worker_version: String,
    pub interpreter: String,
    pub entry_script: String,
    pub files: Vec<BundleFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    path: String,
    role: BundleRole,
    bytes: f64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    schema_version: f64,
    target: BundleTarget,
    runtime_version: String,
    worker_version: String,
    operations: Vec<String>,
    interpreter: String,
    entry_script: String,
    files: Vec<RawFile>,
}

pub(super) fn portable_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 512 || !path.is_ascii() {
        return false;
    }
    let mut depth = 0;
    for part in path.split('/') {
        depth += 1;
        if depth > 16
            || part.is_empty()
            || part.len() > 64
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return false;
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return false;
        }
    }
    true
}

/// Strict bounded JSON bytes. Serde struct visitors reject duplicate and unknown
/// members, including escaped aliases; numeric integer spellings remain semantic.
pub fn parse_manifest(bytes: &[u8]) -> Result<BundleManifest, BundleRefusal> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(BundleRefusal::ManifestLimit);
    }
    let raw: RawManifest =
        serde_json::from_slice(bytes).map_err(|_| BundleRefusal::InvalidManifest)?;
    if raw.schema_version != 1.0
        || !raw.target.valid()
        || !valid_version(&raw.runtime_version)
        || !valid_version(&raw.worker_version)
        || raw.operations != ["health"]
        || !portable_path(&raw.interpreter)
        || !portable_path(&raw.entry_script)
        || raw.interpreter == raw.entry_script
        || !(2..=MAX_FILES).contains(&raw.files.len())
    {
        return Err(BundleRefusal::InvalidManifest);
    }
    let mut previous: Option<&str> = None;
    let mut paths = BTreeSet::new();
    let mut directory_spellings = BTreeMap::new();
    let mut files = Vec::with_capacity(raw.files.len());
    let mut total = 0u64;
    let mut interpreter = 0;
    let mut entry = 0;
    for file in &raw.files {
        if !portable_path(&file.path)
            || !valid_digest(&file.sha256)
            || !file.bytes.is_finite()
            || file.bytes.fract() != 0.0
            || file.bytes < 0.0
            || file.bytes > MAX_FILE_BYTES as f64
            || previous.is_some_and(|value| value >= file.path.as_str())
        {
            return Err(BundleRefusal::InvalidManifest);
        }
        previous = Some(&file.path);
        if !paths.insert(file.path.to_ascii_lowercase()) {
            return Err(BundleRefusal::InvalidManifest);
        }
        for (position, _) in file.path.match_indices('/') {
            let prefix = &file.path[..position];
            if directory_spellings
                .insert(prefix.to_ascii_lowercase(), prefix)
                .is_some_and(|previous| previous != prefix)
            {
                return Err(BundleRefusal::InvalidManifest);
            }
        }
        let size = file.bytes as u64;
        total = total
            .checked_add(size)
            .ok_or(BundleRefusal::InvalidManifest)?;
        if total > MAX_TOTAL_BYTES {
            return Err(BundleRefusal::InvalidManifest);
        }
        match file.role {
            BundleRole::Interpreter => {
                interpreter += 1;
                if file.path != raw.interpreter || size == 0 {
                    return Err(BundleRefusal::InvalidManifest);
                }
            }
            BundleRole::EntryScript => {
                entry += 1;
                if file.path != raw.entry_script || size == 0 {
                    return Err(BundleRefusal::InvalidManifest);
                }
            }
            BundleRole::Support => {}
        }
    }
    if interpreter != 1 || entry != 1 {
        return Err(BundleRefusal::InvalidManifest);
    }
    for path in &paths {
        for (position, _) in path.match_indices('/') {
            if paths.contains(&path[..position]) {
                return Err(BundleRefusal::InvalidManifest);
            }
        }
    }
    for file in raw.files {
        files.push(BundleFile {
            path: file.path,
            role: file.role,
            bytes: file.bytes as u64,
            sha256: file.sha256,
        });
    }
    Ok(BundleManifest {
        target: raw.target,
        runtime_version: raw.runtime_version,
        worker_version: raw.worker_version,
        interpreter: raw.interpreter,
        entry_script: raw.entry_script,
        files,
    })
}
