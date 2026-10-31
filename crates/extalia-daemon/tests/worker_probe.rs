#![cfg(feature = "test-fixtures")]
//! Genuine subprocess regressions; all files remain under an owned temporary cwd.
use extalia_daemon::worker_probe::{
    AdmissionState, ChildExit, ProbeConfig, ProbeOutcome, ProbeReport, StartError, admission_state,
    start_probe,
};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static SERIAL: Mutex<()> = Mutex::new(());
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("extalia-probe-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|error| error.into_inner())
}
fn config(directory: &TempDir, mode: &str) -> ProbeConfig {
    ProbeConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_extalia-worker-fixture")),
        args: vec![OsString::from(mode)],
        cwd: directory.0.clone(),
        expected_version: "0.0.0-reference".into(),
        request_id: "00000000-0000-4000-8000-000000000001".into(),
        handshake_timeout_ms: 1500,
        request_timeout_ms: 1500,
        exit_timeout_ms: 100,
        cancel_grace_ms: 80,
        reap_timeout_ms: 1500,
    }
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
async fn probe(config: ProbeConfig) -> ProbeReport {
    tokio::time::timeout(Duration::from_secs(8), start_probe(config).unwrap().wait())
        .await
        .expect("owner did not finish")
}
fn reaped(report: &ProbeReport) {
    assert!(
        matches!(report.exit, ChildExit::Reaped { .. }),
        "{report:?}"
    );
    assert!(!report.physical_settlement_verified());
    assert_eq!(admission_state(), AdmissionState::Idle);
}
async fn marker(directory: &TempDir, name: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.0.join(name).exists() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("fixture marker missing");
}
async fn idle() {
    tokio::time::timeout(Duration::from_secs(3), async {
        while admission_state() == AdmissionState::Busy {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("abandoned owner did not clean up");
    assert_eq!(admission_state(), AdmissionState::Idle);
}

#[test]
fn health_requires_matching_protocol_clean_eof_and_reaped_successful_child() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "healthy")).await;
        assert_eq!(report.outcome, ProbeOutcome::Healthy);
        assert!(matches!(
            report.exit,
            ChildExit::Reaped {
                code: Some(0),
                success: true
            }
        ));
        assert!(!report.kill_requested);
        assert!(!report.cancel_sent);
        reaped(&report);
        assert!(report.stdout_bytes > 0);
        assert_eq!(report.stderr_bytes, 0);
    });
}
#[test]
fn launch_does_not_inherit_home_path_or_provider_credentials() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "environment")).await;
        assert_eq!(report.outcome, ProbeOutcome::Healthy);
        reaped(&report);
        let keys: Vec<String> =
            serde_json::from_slice(&std::fs::read(directory.0.join("environment.json")).unwrap())
                .unwrap();
        assert!(
            keys.iter()
                .all(|key| cfg!(windows) && key.eq_ignore_ascii_case("SystemRoot")),
            "unexpected environment keys"
        );
    });
}
#[test]
fn silent_startup_hits_independent_handshake_watchdog() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let mut launch = config(&directory, "silent");
        launch.handshake_timeout_ms = 100;
        let report = probe(launch).await;
        assert_eq!(report.outcome, ProbeOutcome::HandshakeTimeout);
        assert!(report.kill_requested);
        reaped(&report);
    });
}
#[test]
fn ignored_request_timeout_is_cancelled_then_killed_and_reaped() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let mut launch = config(&directory, "ignore-cancel");
        launch.request_timeout_ms = 100;
        let report = probe(launch).await;
        assert_eq!(report.outcome, ProbeOutcome::RequestTimeout);
        assert!(report.cancel_sent);
        assert!(report.kill_requested);
        reaped(&report);
    });
}
#[test]
fn explicit_cancellation_can_complete_cooperatively_but_is_never_health_success() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let handle = start_probe(config(&directory, "cooperative-cancel")).unwrap();
        marker(&directory, "request-observed").await;
        handle.cancel();
        let report = handle.wait().await;
        assert_eq!(report.outcome, ProbeOutcome::Cancelled);
        assert!(report.cancel_sent);
        reaped(&report);
        assert!(directory.0.join("cancel-observed").exists());
    });
}
#[test]
fn dropping_handle_retains_owner_until_cleanup_then_reopens_capacity() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let handle = start_probe(config(&directory, "ignore-cancel")).unwrap();
        marker(&directory, "request-observed").await;
        drop(handle);
        idle().await;
        assert_eq!(
            probe(config(&directory, "healthy")).await.outcome,
            ProbeOutcome::Healthy
        );
    });
}
#[test]
fn dropping_wait_future_requests_cancellation_without_aborting_owner() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let handle = start_probe(config(&directory, "ignore-cancel")).unwrap();
        marker(&directory, "request-observed").await;
        let future = handle.wait();
        drop(future);
        idle().await;
        assert_eq!(
            probe(config(&directory, "healthy")).await.outcome,
            ProbeOutcome::Healthy
        );
    });
}
#[test]
fn concurrency_is_fail_fast_without_a_waiting_queue() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let handle = start_probe(config(&directory, "ignore-cancel")).unwrap();
        assert!(matches!(
            start_probe(config(&directory, "healthy")),
            Err(StartError::Busy)
        ));
        marker(&directory, "request-observed").await;
        handle.cancel();
        reaped(&handle.wait().await);
        assert_eq!(
            probe(config(&directory, "healthy")).await.outcome,
            ProbeOutcome::Healthy
        );
    });
}
#[test]
fn cancellation_before_owner_poll_avoids_spawning_a_process() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let handle = start_probe(config(&directory, "healthy")).unwrap();
        handle.cancel();
        let report = handle.wait().await;
        assert_eq!(report.outcome, ProbeOutcome::Cancelled);
        assert_eq!(report.exit, ChildExit::NotSpawned);
        assert_eq!(report.stdout_bytes, 0);
        assert!(!directory.0.join("request-observed").exists());
        assert_eq!(admission_state(), AdmissionState::Idle);
        assert!(!report.physical_settlement_verified());
    });
}
#[test]
fn protocol_violations_are_terminal_and_release_capacity_only_after_reaping() {
    let _guard = serial();
    runtime().block_on(async {
        for mode in [
            "malformed",
            "truncated",
            "wrong-version",
            "duplicate-hello",
            "wrong-id",
        ] {
            let directory = TempDir::new();
            let report = probe(config(&directory, mode)).await;
            assert_eq!(
                report.outcome,
                ProbeOutcome::ProtocolRejected,
                "{mode}: {report:?}"
            );
            reaped(&report);
        }
    });
}
#[test]
fn preemptive_responses_cannot_satisfy_an_unwritten_request() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "unsolicited")).await;
        assert_eq!(report.outcome, ProbeOutcome::ProtocolRejected);
        reaped(&report);
    });
}
#[test]
fn cumulative_stdout_and_stderr_overflow_close_the_owned_process() {
    let _guard = serial();
    runtime().block_on(async {
        for mode in ["stdout-flood", "stderr-flood", "oversize"] {
            let directory = TempDir::new();
            let report = probe(config(&directory, mode)).await;
            assert_eq!(
                report.outcome,
                ProbeOutcome::OutputLimit,
                "{mode}: {report:?}"
            );
            reaped(&report);
            let text = format!("{report:?}");
            assert!(!text.contains(&"x".repeat(80)));
        }
    });
}
#[test]
fn valid_response_followed_by_nonzero_exit_is_not_healthy() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "nonzero")).await;
        assert_eq!(report.outcome, ProbeOutcome::NonZeroExit);
        assert!(matches!(
            report.exit,
            ChildExit::Reaped {
                code: Some(17),
                success: false
            }
        ));
        reaped(&report);
    });
}
#[test]
fn worker_error_remains_data_without_health_or_settlement_authority() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "worker-error")).await;
        assert_eq!(report.outcome, ProbeOutcome::WorkerError);
        reaped(&report);
    });
}
#[test]
fn health_response_does_not_remove_exit_grace_watchdog() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "response-hang")).await;
        assert_eq!(report.outcome, ProbeOutcome::ExitTimeout);
        assert!(report.kill_requested);
        reaped(&report);
    });
}
#[test]
fn late_responses_cannot_restore_timed_out_health() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let mut launch = config(&directory, "late-response");
        launch.request_timeout_ms = 100;
        let report = probe(launch).await;
        assert_eq!(report.outcome, ProbeOutcome::RequestTimeout);
        reaped(&report);
    });
}
#[test]
fn descendant_held_pipes_do_not_block_return_or_claim_descendant_settlement() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let report = probe(config(&directory, "descendant")).await;
        assert_eq!(report.outcome, ProbeOutcome::ExitTimeout);
        assert!(matches!(
            report.exit,
            ChildExit::Reaped {
                code: Some(0),
                success: true
            }
        ));
        reaped(&report);
        // The controlled descendant exits naturally; it is never reported as killed.
        tokio::time::sleep(Duration::from_millis(650)).await;
    });
}
#[test]
fn invalid_configuration_never_launches_and_spawn_failure_releases_capacity() {
    let _guard = serial();
    let directory = TempDir::new();
    runtime().block_on(async {
        let mut launch = config(&directory, "healthy");
        launch.program = "relative-program".into();
        assert!(matches!(
            start_probe(launch),
            Err(StartError::InvalidConfiguration)
        ));
        let mut launch = config(&directory, "healthy");
        launch.args = vec![OsString::from("a"); 9];
        assert!(matches!(
            start_probe(launch),
            Err(StartError::InvalidConfiguration)
        ));
        let mut launch = config(&directory, "healthy");
        launch.expected_version = "a".repeat(129);
        assert!(matches!(
            start_probe(launch),
            Err(StartError::InvalidConfiguration)
        ));
        let mut launch = config(&directory, "healthy");
        launch.program = directory.0.join("missing-binary");
        let report = probe(launch).await;
        assert_eq!(report.outcome, ProbeOutcome::SpawnFailed);
        assert!(matches!(report.exit, ChildExit::NotSpawned));
        assert_eq!(admission_state(), AdmissionState::Idle);
    });
}
#[test]
fn no_async_runtime_is_reported_without_launching() {
    let _guard = serial();
    let directory = TempDir::new();
    assert!(matches!(
        start_probe(config(&directory, "healthy")),
        Err(StartError::Unavailable)
    ));
    assert_eq!(admission_state(), AdmissionState::Idle);
}
