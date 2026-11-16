#![cfg(feature = "test-fixtures")]
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn temporary_root() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        // Short names also keep Unix socket paths below the platform limit.
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("ep-{:x}-{id:x}", std::process::id()));
        match std::fs::create_dir(&root) {
            Ok(()) => return root,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("temporary probe directory: {error}"),
        }
    }
}

fn run(args: &[&std::ffi::OsStr]) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-python-bundle-probe"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("developer harness refusal blocked");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn explicit_developer_opt_in_is_required() {
    assert_eq!(run(&[])["code"], "explicit_developer_arguments_required");
}
#[test]
fn relative_manifest_is_refused_without_opening_it() {
    let root = std::env::temp_dir();
    assert_eq!(
        run(&[
            "--trusted-development-probe".as_ref(),
            root.as_os_str(),
            "relative-manifest".as_ref(),
            "invalid".as_ref()
        ])["code"],
        "manifest_unavailable"
    );
}
#[test]
fn incorrect_independent_pin_cannot_launch_even_a_synthetic_file() {
    let root = temporary_root();
    let manifest = root.join("manifest.json");
    std::fs::write(&manifest, b"{}").unwrap();
    let result = run(&[
        "--trusted-development-probe".as_ref(),
        root.as_os_str(),
        manifest.as_os_str(),
        "invalid".as_ref(),
    ]);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(result["status"], "refused");
    assert!(matches!(
        result["code"].as_str(),
        Some("bundle_observation_failed" | "manifest_unavailable")
    ));
}
#[cfg(unix)]
#[test]
fn socket_manifest_is_rejected_before_content_read() {
    let root = temporary_root();
    let manifest: PathBuf = root.join("m");
    let socket = std::os::unix::net::UnixListener::bind(&manifest).unwrap();
    let result = run(&[
        "--trusted-development-probe".as_ref(),
        root.as_os_str(),
        manifest.as_os_str(),
        "invalid".as_ref(),
    ]);
    drop(socket);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(result["code"], "manifest_unavailable");
}
