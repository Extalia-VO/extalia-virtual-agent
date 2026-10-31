use super::*;
use serde_json::{Value, json};
fn manifest() -> Value {
    json!({"schema_version":1,"target":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH},"runtime_version":"3.13.0","worker_version":"0.0.0-reference","operations":["health"],"interpreter":"python/bin/python3","entry_script":"worker/main.py","files":[{"path":"python/bin/python3","role":"interpreter","bytes":3,"sha256":sha256_hex(b"abc")},{"path":"worker/main.py","role":"entry_script","bytes":3,"sha256":sha256_hex(b"def")}]})
}
#[test]
fn shared_manifest_verdicts_match_typescript_and_schema_contract() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/test/fixtures/worker/bundles.json");
    let fixture: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let bytes = serde_json::to_vec(&case["value"]).unwrap();
        assert_eq!(
            parse_manifest(&bytes).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn exact_manifest_pin_precedes_parsing_and_filesystem_access() {
    let bytes = serde_json::to_vec(&manifest()).unwrap();
    let missing = std::env::temp_dir().join("extalia-nonexistent-bundle");
    assert_eq!(
        observe_bundle(&missing, &bytes, "invalid"),
        Err(BundleRefusal::InvalidPin)
    );
    assert_eq!(
        observe_bundle(&missing, &bytes, &"0".repeat(64)),
        Err(BundleRefusal::ManifestDigestMismatch)
    );
    let large = vec![b' '; MAX_MANIFEST_BYTES + 1];
    assert_eq!(
        observe_bundle(&missing, &large, &"0".repeat(64)),
        Err(BundleRefusal::ManifestLimit)
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
#[cfg(not(unix))]
#[test]
fn unsupported_filesystem_observer_never_uses_unix_identity_fallbacks() {
    let bytes = serde_json::to_vec(&manifest()).unwrap();
    let missing = std::env::temp_dir().join("extalia-nonexistent-bundle");
    assert_eq!(
        observe_bundle(&missing, &bytes, &sha256_hex(&bytes)),
        Err(BundleRefusal::UnsupportedPlatform)
    );
}
#[test]
fn raw_json_duplicates_unknown_fields_and_numeric_forms_are_strict() {
    let raw = serde_json::to_string(&manifest()).unwrap();
    assert!(
        parse_manifest(
            raw.replace("\"schema_version\":1", "\"schema_version\":1e0")
                .as_bytes()
        )
        .is_ok()
    );
    for invalid in [
        raw.replace(
            "\"schema_version\":1",
            "\"schema_version\":1,\"schema_version\":1",
        ),
        raw.replace(
            "\"schema_version\":1",
            "\"schema_version\":1,\"schema_\\u0076ersion\":1",
        ),
        raw.replace("\"bytes\":3", "\"bytes\":3,\"bytes\":3"),
        raw.replace("\"schema_version\":1", "\"schema_version\":true"),
        raw.replace("\"schema_version\":1", "\"schema_version\":1,\"argv\":[]"),
    ] {
        assert_eq!(
            parse_manifest(invalid.as_bytes()),
            Err(BundleRefusal::InvalidManifest)
        );
    }
}
#[cfg(unix)]
mod filesystem {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            // Keep Unix-domain socket test paths below the OS pathname limit.
            let path = std::env::temp_dir().join(format!("eb-{stamp:x}"));
            std::fs::create_dir(&path).unwrap();
            std::fs::create_dir_all(path.join("python/bin")).unwrap();
            std::fs::create_dir(path.join("worker")).unwrap();
            std::fs::write(path.join("python/bin/python3"), b"abc").unwrap();
            std::fs::write(path.join("worker/main.py"), b"def").unwrap();
            Self(path)
        }
        fn observe(&self) -> Result<BundleObservation, BundleRefusal> {
            let bytes = serde_json::to_vec(&manifest()).unwrap();
            observe_bundle(&self.0, &bytes, &sha256_hex(&bytes))
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn exact_inventory_is_observed_without_executable_permission_or_launch_authority() {
        let tree = Tree::new();
        let observation = tree.observe().unwrap();
        assert_eq!(observation.file_count, 2);
        assert_eq!(observation.total_bytes, 6);
        assert!(!observation.launch_eligible());
        assert_eq!(
            std::fs::read(tree.0.join("python/bin/python3")).unwrap(),
            b"abc"
        );
        assert_eq!(tree.observe().unwrap(), observation);
    }
    #[test]
    fn tampering_missing_files_and_extra_directories_are_refused() {
        for mode in ["tamper", "size", "missing", "extra", "empty-directory"] {
            let tree = Tree::new();
            match mode {
                "tamper" => std::fs::write(tree.0.join("worker/main.py"), b"xxx").unwrap(),
                "size" => std::fs::write(tree.0.join("worker/main.py"), b"short").unwrap(),
                "missing" => std::fs::remove_file(tree.0.join("worker/main.py")).unwrap(),
                "extra" => std::fs::write(tree.0.join("extra"), b"unlisted").unwrap(),
                _ => std::fs::create_dir(tree.0.join("unused")).unwrap(),
            }
            assert_eq!(
                tree.observe().unwrap_err(),
                match mode {
                    "tamper" => BundleRefusal::DigestMismatch,
                    "size" => BundleRefusal::SizeMismatch,
                    _ => BundleRefusal::TreeMismatch,
                }
            );
        }
    }
    #[test]
    fn links_and_non_regular_entries_are_never_followed_or_read() {
        use std::os::unix::fs::symlink;
        for mode in ["file-link", "dir-link", "hard-link", "socket"] {
            let tree = Tree::new();
            let file = tree.0.join("worker/main.py");
            match mode {
                "file-link" => {
                    std::fs::remove_file(&file).unwrap();
                    symlink(tree.0.join("python/bin/python3"), &file).unwrap();
                }
                "dir-link" => {
                    std::fs::remove_dir_all(tree.0.join("worker")).unwrap();
                    symlink(tree.0.join("python"), tree.0.join("worker")).unwrap();
                }
                "hard-link" => {
                    std::fs::remove_file(&file).unwrap();
                    std::fs::hard_link(tree.0.join("python/bin/python3"), &file).unwrap();
                }
                _ => {
                    std::fs::remove_file(&file).unwrap();
                    let _socket = std::os::unix::net::UnixListener::bind(&file).unwrap();
                }
            }
            assert_eq!(tree.observe().unwrap_err(), BundleRefusal::UnsafeEntry);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn fifo_entries_are_refused_before_a_content_read() {
        let tree = Tree::new();
        let file = tree.0.join("worker/main.py");
        std::fs::remove_file(&file).unwrap();
        rustix::fs::mkfifoat(
            rustix::fs::CWD,
            &file,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .unwrap();
        assert_eq!(tree.observe().unwrap_err(), BundleRefusal::UnsafeEntry);
    }
    #[test]
    fn root_links_and_foreign_target_are_refused() {
        let tree = Tree::new();
        let alias = tree.0.join("alias");
        std::os::unix::fs::symlink(&tree.0, &alias).unwrap();
        let bytes = serde_json::to_vec(&manifest()).unwrap();
        assert_eq!(
            observe_bundle(&alias, &bytes, &sha256_hex(&bytes)),
            Err(BundleRefusal::InvalidRoot)
        );
        let mut foreign = manifest();
        foreign["target"]["os"] = json!(if std::env::consts::OS == "linux" {
            "macos"
        } else {
            "linux"
        });
        let bytes = serde_json::to_vec(&foreign).unwrap();
        assert_eq!(
            observe_bundle(&tree.0, &bytes, &sha256_hex(&bytes)),
            Err(BundleRefusal::TargetMismatch)
        );
    }
}
