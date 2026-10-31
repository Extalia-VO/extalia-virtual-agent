//! Explicit developer-only native bundle probe. Not a daemon operation or release target.
#[cfg(unix)]
use extalia_daemon::worker_bundle::MAX_MANIFEST_BYTES;
use extalia_daemon::worker_bundle::{observe_bundle, parse_manifest};
use extalia_daemon::worker_probe::{ChildExit, ProbeConfig, ProbeOutcome, start_probe};
use serde_json::json;
#[cfg(unix)]
use std::io::Read;
use std::path::PathBuf;

#[cfg(unix)]
fn read_manifest(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    if !path.is_absolute() || path.as_os_str().as_encoded_bytes().len() > 4096 {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    use rustix::fs::{Mode, OFlags};
    let file = std::fs::File::from(rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    if !file.metadata()?.is_file() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}
#[cfg(not(unix))]
fn read_manifest(_path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 || args[0] != "--trusted-development-probe" {
        println!(
            "{}",
            json!({"status":"refused","code":"explicit_developer_arguments_required"})
        );
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[1]);
    let manifest_path = PathBuf::from(&args[2]);
    let Some(expected) = args[3].to_str() else {
        std::process::exit(2);
    };
    let bytes = match read_manifest(&manifest_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            println!(
                "{}",
                json!({"status":"refused","code":"manifest_unavailable"})
            );
            std::process::exit(2);
        }
    };
    let observation = match observe_bundle(&root, &bytes, expected) {
        Ok(value) => value,
        Err(_) => {
            println!(
                "{}",
                json!({"status":"refused","code":"bundle_observation_failed"})
            );
            std::process::exit(2);
        }
    };
    let manifest = parse_manifest(&bytes).expect("observed manifest was parsed");
    let interpreter = if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3.13"
    };
    if manifest.interpreter != interpreter
        || manifest.entry_script != "worker/probe.py"
        || manifest.runtime_version != "3.13.18"
        || manifest.worker_version != "0.0.0-reference"
    {
        println!(
            "{}",
            json!({"status":"refused","code":"developer_recipe_mismatch"})
        );
        std::process::exit(2);
    }
    let launch = ProbeConfig {
        program: root.join(interpreter),
        args: vec![
            "-I".into(),
            "-S".into(),
            "-B".into(),
            root.join("worker/probe.py").into_os_string(),
        ],
        cwd: root,
        expected_version: manifest.worker_version,
        request_id: "00000000-0000-4000-8000-000000000001".into(),
        handshake_timeout_ms: 5000,
        request_timeout_ms: 5000,
        exit_timeout_ms: 1500,
        cancel_grace_ms: 100,
        reap_timeout_ms: 2000,
    };
    let handle = match start_probe(launch) {
        Ok(handle) => handle,
        Err(_) => {
            println!("{}", json!({"status":"refused","code":"probe_unavailable"}));
            std::process::exit(2);
        }
    };
    let report = handle.wait().await;
    let success = report.outcome == ProbeOutcome::Healthy
        && matches!(
            report.exit,
            ChildExit::Reaped {
                code: Some(0),
                success: true
            }
        );
    println!(
        "{}",
        json!({"status":if success {"healthy"} else {"refused"},"runtime_version":observation.runtime_version,"worker_version":observation.worker_version,"manifest_sha256":observation.manifest_sha256,"file_count":observation.file_count,"total_bytes":observation.total_bytes,"direct_child_reaped":matches!(report.exit,ChildExit::Reaped{..}),"physical_settlement_verified":report.physical_settlement_verified(),"launch_eligible":observation.launch_eligible(),"stdout_bytes":report.stdout_bytes,"stderr_bytes":report.stderr_bytes})
    );
    if !success {
        std::process::exit(2);
    }
}
