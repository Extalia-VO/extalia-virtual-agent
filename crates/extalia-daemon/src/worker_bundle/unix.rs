use super::manifest::portable_path;
use super::{BundleManifest, BundleRefusal, MAX_DIRECTORIES, MAX_FILES, MAX_TOTAL_BYTES, hex};
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, open, openat, statat};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, Metadata};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    dev: u64,
    ino: u64,
    mode: u32,
    links: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
fn fingerprint(meta: &Metadata) -> Fingerprint {
    Fingerprint {
        dev: meta.dev(),
        ino: meta.ino(),
        mode: meta.mode(),
        links: meta.nlink(),
        size: meta.len(),
        modified: (meta.mtime(), meta.mtime_nsec()),
        changed: (meta.ctime(), meta.ctime_nsec()),
    }
}
#[allow(clippy::unnecessary_cast)] // libc identifier widths differ across supported Unix targets.
fn same_stat(meta: &Metadata, stat: &rustix::fs::Stat) -> bool {
    meta.dev() == stat.st_dev as u64
        && meta.ino() == stat.st_ino as u64
        && meta.mode() == stat.st_mode as u32
        && meta.nlink() == stat.st_nlink as u64
        && meta.len() == stat.st_size as u64
}
fn flags() -> OFlags {
    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY
}
fn root_open(root: &Path) -> Result<File, BundleRefusal> {
    if !root.is_absolute() || root.as_os_str().as_encoded_bytes().len() > 4096 {
        return Err(BundleRefusal::InvalidRoot);
    }
    open(root, flags() | OFlags::DIRECTORY, Mode::empty())
        .map(File::from)
        .map_err(|_| BundleRefusal::InvalidRoot)
}
struct Walk<'a> {
    manifest: &'a BundleManifest,
    allowed_files: BTreeMap<&'a str, usize>,
    allowed_dirs: BTreeSet<String>,
    seen: BTreeMap<String, Fingerprint>,
    bytes: u64,
    directories: usize,
}
impl<'a> Walk<'a> {
    fn new(manifest: &'a BundleManifest) -> Result<Self, BundleRefusal> {
        let mut allowed_dirs = BTreeSet::new();
        let mut allowed_files = BTreeMap::new();
        for (index, file) in manifest.files.iter().enumerate() {
            allowed_files.insert(file.path.as_str(), index);
            for (position, _) in file.path.match_indices('/') {
                allowed_dirs.insert(file.path[..position].to_owned());
            }
        }
        if allowed_dirs.len() > MAX_DIRECTORIES {
            return Err(BundleRefusal::LimitExceeded);
        }
        Ok(Self {
            manifest,
            allowed_files,
            allowed_dirs,
            seen: BTreeMap::new(),
            bytes: 0,
            directories: 0,
        })
    }
    fn visit(
        &mut self,
        parent: &File,
        prefix: &str,
        hash_content: bool,
    ) -> Result<(), BundleRefusal> {
        let before = fingerprint(
            &parent
                .metadata()
                .map_err(|_| BundleRefusal::IoUnavailable)?,
        );
        let mut entries = Dir::read_from(parent).map_err(|_| BundleRefusal::IoUnavailable)?;
        while let Some(entry) = entries.read() {
            let entry = entry.map_err(|_| BundleRefusal::IoUnavailable)?;
            let name = entry.file_name();
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name_text = name.to_str().map_err(|_| BundleRefusal::UnsafeEntry)?;
            // Names come from this directory descriptor, never slash-separated paths.
            if !portable_path(name_text) || name_text.contains('/') {
                return Err(BundleRefusal::UnsafeEntry);
            }
            if self.seen.len() >= MAX_FILES + MAX_DIRECTORIES {
                return Err(BundleRefusal::LimitExceeded);
            }
            let relative = if prefix.is_empty() {
                name_text.to_owned()
            } else {
                format!("{prefix}/{name_text}")
            };
            let stat = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| BundleRefusal::TreeChanged)?;
            let kind = FileType::from_raw_mode(stat.st_mode);
            if !matches!(kind, FileType::RegularFile | FileType::Directory) {
                return Err(BundleRefusal::UnsafeEntry);
            }
            if kind == FileType::Directory && !self.allowed_dirs.contains(&relative)
                || kind == FileType::RegularFile
                    && !self.allowed_files.contains_key(relative.as_str())
            {
                return Err(BundleRefusal::TreeMismatch);
            }
            let open_flags = if kind == FileType::Directory {
                flags() | OFlags::DIRECTORY
            } else {
                flags()
            };
            let mut file = openat(parent, name, open_flags, Mode::empty())
                .map(File::from)
                .map_err(|_| BundleRefusal::UnsafeEntry)?;
            let meta = file.metadata().map_err(|_| BundleRefusal::IoUnavailable)?;
            if !same_stat(&meta, &stat) {
                return Err(BundleRefusal::TreeChanged);
            }
            let initial = fingerprint(&meta);
            if self
                .seen
                .insert(relative.clone(), initial.clone())
                .is_some()
            {
                return Err(BundleRefusal::TreeChanged);
            }
            if kind == FileType::Directory {
                if !meta.is_dir() {
                    return Err(BundleRefusal::UnsafeEntry);
                }
                self.directories += 1;
                if self.directories > MAX_DIRECTORIES {
                    return Err(BundleRefusal::LimitExceeded);
                }
                self.visit(&file, &relative, hash_content)?;
            } else {
                if !meta.is_file() || meta.nlink() != 1 {
                    return Err(BundleRefusal::UnsafeEntry);
                }
                let expected = &self.manifest.files[self.allowed_files[relative.as_str()]];
                if meta.len() != expected.bytes {
                    return Err(BundleRefusal::SizeMismatch);
                }
                self.bytes = self
                    .bytes
                    .checked_add(meta.len())
                    .ok_or(BundleRefusal::LimitExceeded)?;
                if self.bytes > MAX_TOTAL_BYTES {
                    return Err(BundleRefusal::LimitExceeded);
                }
                if hash_content {
                    let mut hasher = Sha256::new();
                    let mut remaining = expected.bytes;
                    let mut buffer = [0u8; 65_536];
                    while remaining != 0 {
                        let capacity = usize::try_from(remaining.min(buffer.len() as u64))
                            .map_err(|_| BundleRefusal::LimitExceeded)?;
                        let count = file
                            .read(&mut buffer[..capacity])
                            .map_err(|_| BundleRefusal::IoUnavailable)?;
                        if count == 0 {
                            return Err(BundleRefusal::TreeChanged);
                        }
                        remaining -= count as u64;
                        hasher.update(&buffer[..count]);
                    }
                    if file
                        .read(&mut buffer[..1])
                        .map_err(|_| BundleRefusal::IoUnavailable)?
                        != 0
                    {
                        return Err(BundleRefusal::TreeChanged);
                    }
                    if hex(&hasher.finalize()) != expected.sha256 {
                        return Err(BundleRefusal::DigestMismatch);
                    }
                }
            }
            if fingerprint(&file.metadata().map_err(|_| BundleRefusal::IoUnavailable)?) != initial {
                return Err(BundleRefusal::TreeChanged);
            }
            let after = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| BundleRefusal::TreeChanged)?;
            if !same_stat(&meta, &after) {
                return Err(BundleRefusal::TreeChanged);
            }
        }
        if fingerprint(
            &parent
                .metadata()
                .map_err(|_| BundleRefusal::IoUnavailable)?,
        ) != before
        {
            return Err(BundleRefusal::TreeChanged);
        }
        Ok(())
    }
    fn complete(&self) -> bool {
        self.seen.len() == self.allowed_files.len() + self.allowed_dirs.len()
    }
}
pub(super) fn observe(root: &Path, manifest: &BundleManifest) -> Result<u64, BundleRefusal> {
    observe_between(root, manifest, || {})
}

fn observe_between(
    root: &Path,
    manifest: &BundleManifest,
    after_hash: impl FnOnce(),
) -> Result<u64, BundleRefusal> {
    // The caller owns the root and its ancestor namespace. Once opened, children
    // are accessed only through pinned directory descriptors, never joined paths.
    let directory = root_open(root)?;
    let initial_root = fingerprint(
        &directory
            .metadata()
            .map_err(|_| BundleRefusal::IoUnavailable)?,
    );
    let mut first = Walk::new(manifest)?;
    first.visit(&directory, "", true)?;
    if !first.complete() {
        return Err(BundleRefusal::TreeMismatch);
    }
    after_hash();
    let mut second = Walk::new(manifest)?;
    second.visit(&directory, "", false)?;
    if !second.complete() || first.seen != second.seen || first.bytes != second.bytes {
        return Err(BundleRefusal::TreeChanged);
    }
    let current_root = root_open(root)?;
    if fingerprint(
        &current_root
            .metadata()
            .map_err(|_| BundleRefusal::IoUnavailable)?,
    ) != initial_root
    {
        return Err(BundleRefusal::TreeChanged);
    }
    Ok(first.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_change_between_hash_and_inventory_pass_is_not_cached_as_success() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("eb-race-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let first = root.join("interpreter");
        let second = root.join("worker.py");
        std::fs::write(&first, b"abc").unwrap();
        std::fs::write(&second, b"abc").unwrap();
        let digest = super::super::sha256_hex(b"abc");
        let value = serde_json::json!({"schema_version":1,"target":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH},"runtime_version":"3.13.0","worker_version":"0.0.0-reference","operations":["health"],"interpreter":"interpreter","entry_script":"worker.py","files":[{"path":"interpreter","role":"interpreter","bytes":3,"sha256":digest},{"path":"worker.py","role":"entry_script","bytes":3,"sha256":digest}]});
        let manifest = super::super::parse_manifest(&serde_json::to_vec(&value).unwrap()).unwrap();
        let mode = std::fs::metadata(&second).unwrap().mode();
        let result = observe_between(&root, &manifest, || {
            std::fs::set_permissions(&second, std::fs::Permissions::from_mode(mode ^ 0o100))
                .unwrap()
        });
        let _ = std::fs::remove_dir_all(root);
        assert_eq!(result, Err(BundleRefusal::TreeChanged));
    }
}
