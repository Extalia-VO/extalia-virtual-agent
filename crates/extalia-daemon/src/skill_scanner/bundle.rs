use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const MAX_FILES: usize = 32_768;
const MAX_MANIFEST: usize = 8 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const MAX_FILE: u64 = 128 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    os: String,
    arch: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    bytes: u64,
    sha256: String,
    #[cfg(unix)]
    executable: bool,
    // Non-Unix targets still validate the manifest schema, but cannot verify
    // Unix execute permissions or admit this scanner bundle.
    #[cfg(not(unix))]
    #[serde(rename = "executable")]
    _executable: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u64,
    target: Target,
    runtime_version: String,
    scanner_version: String,
    source_commit: String,
    normalizer_version: String,
    interpreter: String,
    entry_script: String,
    files: Vec<Entry>,
}
#[derive(Clone, Debug)]
pub struct Bundle {
    pub root: PathBuf,
    pub interpreter: PathBuf,
    pub script: PathBuf,
    pub manifest_pin: String,
}
fn digest(bytes: &[u8]) -> String {
    super::hex(&Sha256::digest(bytes))
}
fn regular_file(path: &Path) -> Option<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let before = fs::symlink_metadata(path).ok()?;
        if !before.is_file() || before.nlink() != 1 {
            return None;
        }
        let flags = (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .ok()?;
        let after = file.metadata().ok()?;
        if !after.is_file() || before.dev() != after.dev() || before.ino() != after.ino() {
            return None;
        }
        Some(file)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}
fn file_bytes(file: &Path, limit: usize) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    regular_file(file)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= limit).then_some(bytes)
}
fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.contains('\\')
        && !value.contains('\0')
        && value.split('/').count() <= 32
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && value
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn inventory(
    root: &Path,
    current: &Path,
    names: &mut BTreeSet<String>,
    directories: &mut usize,
    depth: usize,
) -> Option<()> {
    if depth > 32 || *directories >= MAX_FILES {
        return None;
    }
    *directories += 1;
    for entry in fs::read_dir(current).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).ok()?;
        if metadata.is_symlink() {
            return None;
        }
        if metadata.is_dir() {
            inventory(root, &path, names, directories, depth + 1)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).ok()?.to_str()?.replace('\\', "/");
            if !safe_relative(&relative) || names.len() >= MAX_FILES {
                return None;
            }
            names.insert(relative);
        } else {
            return None;
        }
    }
    Some(())
}
impl Bundle {
    pub fn observe(root: &Path, expected: &str) -> Option<Self> {
        if expected.len() != 64 {
            return None;
        }
        let root = fs::canonicalize(root).ok()?;
        let manifest_bytes = file_bytes(&root.join("bundle-manifest.json"), MAX_MANIFEST)?;
        if digest(&manifest_bytes) != expected {
            return None;
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes).ok()?;
        if manifest.schema_version != 1
            || manifest.target.os != std::env::consts::OS
            || manifest.target.arch != std::env::consts::ARCH
            || manifest.runtime_version != "3.13.18"
            || manifest.scanner_version != super::VERSION
            || manifest.source_commit != super::SOURCE
            || manifest.normalizer_version != super::NORMALIZER
            || manifest.interpreter != "python/bin/python3.13"
            || manifest.entry_script != "worker/scan.py"
            || manifest.files.is_empty()
            || manifest.files.len() > MAX_FILES
        {
            return None;
        }
        let payload = root.join("payload");
        if fs::symlink_metadata(&payload).ok()?.is_symlink() {
            return None;
        }
        let mut actual = BTreeSet::new();
        inventory(&payload, &payload, &mut actual, &mut 0, 0)?;
        let mut expected_files = BTreeMap::new();
        let mut total = 0_u64;
        for entry in manifest.files {
            if !safe_relative(&entry.path)
                || entry.bytes > MAX_FILE
                || entry.sha256.len() != 64
                || expected_files.contains_key(&entry.path)
            {
                return None;
            }
            total = total.checked_add(entry.bytes)?;
            if total > MAX_TOTAL {
                return None;
            }
            expected_files.insert(entry.path.clone(), entry);
        }
        if actual != expected_files.keys().cloned().collect() {
            return None;
        }
        for (name, entry) in expected_files {
            let path = payload.join(name);
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.is_file() || metadata.len() != entry.bytes {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if (metadata.permissions().mode() & 0o111 != 0) != entry.executable {
                    return None;
                }
            }
            let mut file = regular_file(&path)?;
            #[cfg(unix)]
            let before = file.metadata().ok()?;
            let mut hash = Sha256::new();
            let mut bytes = 0_u64;
            let mut buffer = [0_u8; 65536];
            loop {
                let count = file.read(&mut buffer).ok()?;
                if count == 0 {
                    break;
                }
                bytes = bytes.checked_add(count as u64)?;
                if bytes > entry.bytes {
                    return None;
                }
                hash.update(&buffer[..count]);
            }
            if bytes != entry.bytes || super::hex(&hash.finalize()) != entry.sha256 {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let after = file.metadata().ok()?;
                if before.dev() != after.dev()
                    || before.ino() != after.ino()
                    || before.ctime() != after.ctime()
                    || before.ctime_nsec() != after.ctime_nsec()
                    || before.mtime() != after.mtime()
                    || before.mtime_nsec() != after.mtime_nsec()
                    || before.len() != after.len()
                {
                    return None;
                }
            }
        }
        Some(Self {
            interpreter: payload.join(manifest.interpreter),
            script: payload.join(manifest.entry_script),
            root,
            manifest_pin: expected.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Entry;

    #[test]
    fn execute_permission_remains_a_required_boolean_on_every_platform() {
        for executable in ["true", "false"] {
            let json = format!(
                r#"{{"path":"worker/scan.py","bytes":1,"sha256":"digest","executable":{executable}}}"#
            );
            assert!(serde_json::from_str::<Entry>(&json).is_ok());
        }
        for json in [
            r#"{"path":"worker/scan.py","bytes":1,"sha256":"digest"}"#,
            r#"{"path":"worker/scan.py","bytes":1,"sha256":"digest","executable":1}"#,
            r#"{"path":"worker/scan.py","bytes":1,"sha256":"digest","_executable":true}"#,
        ] {
            assert!(serde_json::from_str::<Entry>(json).is_err());
        }
    }
}
