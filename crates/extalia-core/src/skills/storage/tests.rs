use super::*;
#[cfg(unix)]
const SKILL_MD: &str = "---\nname: demo\ndescription: Demo skill\n---\nDo the thing.\n";
fn profile(name: &str) -> ProfileId {
    ProfileId::parse(name).unwrap()
}
pub(super) struct TempDir(PathBuf);
impl TempDir {
    pub(super) fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "extalia-skill-layout-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    pub(super) fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    #[cfg(unix)]
    fn package(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = self.0.join(name);
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        root
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        fn writable(path: &Path) {
            if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
                }
                if let Ok(entries) = std::fs::read_dir(path) {
                    for entry in entries.flatten() {
                        writable(&entry.path());
                    }
                }
            }
        }
        writable(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[cfg(unix)]
use crate::skills::tree::{ObjectStore, StagingLimits};
#[cfg(unix)]
use std::fs;

#[test]
fn explicit_nondefault_keeps_separate_legacy_namespace() {
    let temp = TempDir::new();
    let id = profile("other");
    assert_eq!(
        root(&temp.data(), &id),
        temp.data().join("profiles/other/skills")
    );
    assert_eq!(
        inbox(&temp.data(), &id),
        temp.data().join("profiles/other/skill-imports")
    );
    assert_eq!(
        market(&temp.data(), &id),
        temp.data().join("profiles/other/skill-market")
    );
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    // Build old immutable objects using the unchanged explicit CLI namespace, then
    // move that namespace into the former default location. No real data is accessed.
    fn legacy(temp: &TempDir) -> (String, Vec<u8>) {
        let package = temp.package(
            "source",
            &[("SKILL.md", SKILL_MD), ("bin/task.sh", "#!/bin/sh\ntrue\n")],
        );
        fs::set_permissions(
            package.join("bin/task.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let old = ObjectStore::new(&temp.data(), &profile("old"));
        let tree = old.stage(&package, &StagingLimits::default()).unwrap();
        fs::rename(
            temp.data().join("profiles/old"),
            temp.data().join("profiles/default"),
        )
        .unwrap();
        (tree.sha256, fs::read(package.join("SKILL.md")).unwrap())
    }

    #[test]
    fn relocation_preserves_bytes_modes_and_legacy_and_is_idempotent() {
        let temp = TempDir::new();
        let (hash, bytes) = legacy(&temp);
        fs::create_dir_all(temp.data().join("skills/custom-w0")).unwrap();
        fs::write(
            temp.data().join("skills/custom-w0/SKILL.md"),
            "old inventory",
        )
        .unwrap();
        fs::create_dir_all(temp.data().join("skills/staging")).unwrap();
        let stale_dir = temp
            .data()
            .join(format!("skills/staging/relocate-{}-0", std::process::id()));
        fs::create_dir(&stale_dir).unwrap();
        fs::write(
            temp.data()
                .join(format!("skills/layout-pending-{}-0", std::process::id())),
            "incomplete old marker",
        )
        .unwrap();
        let id = profile("default");
        assert!(is_global(&id));
        let started = std::time::Instant::now();
        drop(initialize(&temp.data(), &id).unwrap());
        eprintln!("fixture migration: {:?}", started.elapsed());
        let store = ObjectStore::new(&temp.data(), &id);
        assert_eq!(
            fs::read(store.object_dir(&hash).join("SKILL.md")).unwrap(),
            bytes
        );
        assert_eq!(
            fs::metadata(store.object_dir(&hash).join("bin/task.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o500
        );
        assert_eq!(
            fs::metadata(store.object_dir(&hash))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o500
        );
        assert!(
            temp.data()
                .join("profiles/default/skills/objects")
                .join(&hash)
                .exists()
        );
        assert_eq!(
            fs::read(temp.data().join("skills/custom-w0/SKILL.md")).unwrap(),
            b"old inventory"
        );
        drop(initialize(&temp.data(), &id).unwrap());
        store.verify(&hash, &StagingLimits::default()).unwrap();
        assert_eq!(inbox(&temp.data(), &id), temp.data().join("skills/imports"));
        assert_eq!(market(&temp.data(), &id), temp.data().join("skills/market"));
    }

    #[test]
    fn refuses_reserved_w0_and_symlink_without_touching_external_bytes() {
        for reserved in ["objects", "staging", "imports", "market"] {
            let temp = TempDir::new();
            let collision = temp.data().join("skills").join(reserved);
            fs::create_dir_all(&collision).unwrap();
            fs::write(collision.join("SKILL.md"), "keep").unwrap();
            assert!(initialize(&temp.data(), &profile("default")).is_err());
            assert_eq!(fs::read(collision.join("SKILL.md")).unwrap(), b"keep");
            assert!(!temp.data().join("skills/layout-v1").exists());
        }
        let temp = TempDir::new();
        let outside = temp.package("outside", &[("SKILL.md", "untouched")]);
        fs::create_dir_all(temp.data()).unwrap();
        symlink(&outside, temp.data().join("skills")).unwrap();
        assert!(initialize(&temp.data(), &profile("default")).is_err());
        assert!(!outside.join("layout.lock").exists());
    }

    #[test]
    fn conflict_then_restart_reuses_only_verified_published_objects() {
        let temp = TempDir::new();
        let (hash, _) = legacy(&temp);
        let destination = temp.data().join("skills/objects").join(&hash);
        fs::create_dir_all(&destination).unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(initialize(&temp.data(), &profile("default")).is_err());
        assert!(!temp.data().join("skills/layout-v1").exists());
        fs::remove_dir(&destination).unwrap();
        drop(initialize(&temp.data(), &profile("default")).unwrap());
        // A missing marker simulates restart after all object publications but before commit.
        fs::remove_file(temp.data().join("skills/layout-v1")).unwrap();
        drop(initialize(&temp.data(), &profile("default")).unwrap());
        // Post-commit corruption never falls back to the retained old copy.
        let skill = destination.join("SKILL.md");
        fs::set_permissions(&skill, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(skill, "changed").unwrap();
        assert!(
            ObjectStore::new(&temp.data(), &profile("default"))
                .verify(&hash, &StagingLimits::default())
                .is_err()
        );
    }

    #[test]
    fn lock_fences_writers_and_marker_is_strict() {
        let temp = TempDir::new();
        let id = profile("default");
        let guard = initialize(&temp.data(), &id).unwrap();
        assert!(matches!(
            prepare(&temp.data(), &id),
            Err(SkillError::Denied("skill_layout_busy"))
        ));
        drop(guard);
        let marker = temp.data().join("skills/layout-v1");
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(marker, "not a committed migration").unwrap();
        assert!(initialize(&temp.data(), &id).is_err());
    }
    #[test]
    fn independent_writers_never_migrate_and_legacy_symlinks_fail_closed() {
        let temp = TempDir::new();
        let (hash, _) = legacy(&temp);
        assert!(prepare(&temp.data(), &profile("default")).is_err());
        assert!(!temp.data().join("skills").exists());
        let old = temp
            .data()
            .join("profiles/default/skills/objects")
            .join(hash);
        let file = old.join("SKILL.md");
        fs::set_permissions(&old, fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_file(&file).unwrap();
        let outside = temp.package("outside", &[("SKILL.md", "untouched")]);
        symlink(outside.join("SKILL.md"), &file).unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(initialize(&temp.data(), &profile("default")).is_err());
        assert!(!temp.data().join("skills/layout-v1").exists());
        assert_eq!(fs::read(outside.join("SKILL.md")).unwrap(), b"untouched");
    }

    #[test]
    fn committed_layout_is_not_recreated_when_managed_directory_disappears() {
        let temp = TempDir::new();
        let id = profile("default");
        drop(initialize(&temp.data(), &id).unwrap());
        fs::remove_dir(temp.data().join("skills/objects")).unwrap();
        assert!(initialize(&temp.data(), &id).is_err());
        assert!(!temp.data().join("skills/objects").exists());
    }
}
