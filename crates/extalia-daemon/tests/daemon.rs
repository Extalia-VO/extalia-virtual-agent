//! Spawns the built daemon binary and talks to it over stdio. Temporary directories only.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use extalia_core::CoreStore;
use extalia_core::security::permissions::Decision;
use extalia_daemon::wire::{self, ErrorCode, Frame, HealthStatus, Op, ResponseResult};
use serde_json::{Value, json};

const ID: &str = "00000000-0000-4000-8000-000000000100";
const OTHER_ID: &str = "00000000-0000-4000-8000-000000000101";

struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Daemon {
    fn spawn(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("daemon starts");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn send_bytes(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, value: &Value) {
        let payload = serde_json::to_vec(value).unwrap();
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&payload);
        self.send_bytes(&bytes);
    }

    /// The next frame, validated against the contract.
    fn receive(&mut self) -> Frame {
        let mut header = [0; 4];
        self.stdout.read_exact(&mut header).unwrap();
        let mut payload = vec![0; u32::from_be_bytes(header) as usize];
        self.stdout.read_exact(&mut payload).unwrap();
        wire::decode_payload(&payload).expect("daemon output follows the contract")
    }

    fn expect_error(&mut self, request_id: Option<&str>, code: ErrorCode) {
        match self.receive() {
            Frame::Error(error) => {
                assert_eq!(error.code, code);
                assert_eq!(error.request_id.as_deref(), request_id);
            }
            other => panic!("expected {code:?}, got {other:?}"),
        }
    }

    /// Close stdin and return the exit code; stdout must have nothing left.
    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        let mut rest = Vec::new();
        self.stdout.read_to_end(&mut rest).unwrap();
        assert!(rest.is_empty(), "unexpected output after the last frame");
        self.child.wait().unwrap().code().expect("exited normally")
    }
}

fn request(id: &str, op: &str, params: Value) -> Value {
    json!({ "schemaVersion": 1, "kind": "request", "requestId": id, "op": op, "params": params })
}

fn hello() -> Value {
    request(
        ID,
        "hello",
        json!({ "clientVersion": "0.0.0-test", "capabilities": ["hello", "health"] }),
    )
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-daemon-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Self(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn handshake_health_unknown_op_and_clean_eof() {
    let mut daemon = Daemon::spawn(&[]);

    daemon.send(&request(OTHER_ID, "health", json!({})));
    daemon.expect_error(Some(OTHER_ID), ErrorCode::HandshakeRequired);

    daemon.send(&hello());
    match daemon.receive() {
        Frame::Response(response) => {
            assert_eq!(response.request_id, ID);
            assert_eq!(
                response.result,
                ResponseResult::Hello {
                    daemon_version: env!("CARGO_PKG_VERSION").into(),
                    capabilities: vec![Op::Hello, Op::PermissionCheck, Op::Health],
                    max_frame_bytes: 1024 * 1024,
                }
            );
        }
        other => panic!("expected the hello response, got {other:?}"),
    }

    daemon.send(&request(OTHER_ID, "health", json!({})));
    match daemon.receive() {
        Frame::Response(response) => {
            assert_eq!(response.request_id, OTHER_ID);
            assert!(matches!(
                response.result,
                ResponseResult::Health {
                    status: HealthStatus::Ok,
                    ..
                }
            ));
        }
        other => panic!("expected the health response, got {other:?}"),
    }

    daemon.send(&request(ID, "mission.delete", json!({})));
    daemon.expect_error(Some(ID), ErrorCode::UnknownOp);

    // The daemon decides permissions (the full matrix is in tests/permissions.rs).
    let check = json!({
        "access": "write", "mode": "plan",
        "workspacePermissions": { "fileWrite": "allow", "commands": "allow" }, "sessionGrants": ["write"]
    });
    daemon.send(&request(ID, "permission.check", check));
    match daemon.receive() {
        Frame::Response(response) => {
            assert_eq!(response.request_id, ID);
            assert_eq!(
                response.result,
                ResponseResult::PermissionCheck {
                    decision: Decision::Deny
                }
            );
        }
        other => panic!("expected the permission.check response, got {other:?}"),
    }

    // Malformed frames are answered and skipped; the connection continues.
    daemon.send_bytes(&[0, 0, 0, 3, b'{', b'x', b'}']);
    daemon.expect_error(None, ErrorCode::InvalidFrame);
    daemon.send(&request(ID, "health", json!({ "verbose": true })));
    daemon.expect_error(Some(ID), ErrorCode::InvalidRequest);
    daemon.send(&request(OTHER_ID, "health", json!({})));
    assert!(matches!(daemon.receive(), Frame::Response(_)));

    assert_eq!(daemon.finish(), 0);
}

#[test]
fn newer_schema_version_ends_the_connection() {
    let mut daemon = Daemon::spawn(&[]);
    daemon.send(&json!({ "schemaVersion": 2, "kind": "request", "requestId": ID, "op": "health", "params": {} }));
    daemon.expect_error(Some(ID), ErrorCode::UnsupportedSchemaVersion);
    assert_eq!(daemon.finish(), 1);
}

#[test]
fn oversize_frame_ends_the_connection() {
    let mut daemon = Daemon::spawn(&[]);
    daemon.send_bytes(&(1024 * 1024 + 1u32).to_be_bytes());
    daemon.expect_error(None, ErrorCode::FrameTooLarge);
    assert_eq!(daemon.finish(), 1);
}

#[test]
fn truncated_frame_at_eof_is_an_error() {
    let mut daemon = Daemon::spawn(&[]);
    daemon.send_bytes(&[0, 0, 0, 10, b'{']);
    assert_eq!(daemon.finish(), 1);
}

#[test]
fn data_dir_opens_and_migrates_the_core_store() {
    let dir = TempDir::new();
    let data_dir = dir.path().to_str().unwrap().to_owned();
    let mut daemon = Daemon::spawn(&["--data-dir", &data_dir]);
    daemon.send(&hello());
    assert!(matches!(daemon.receive(), Frame::Response(_)));
    assert_eq!(daemon.finish(), 0);
    let store = dir.path().join("state").join("core.sqlite");
    assert!(store.is_file());
    assert!(!dir.path().join("state").join("missions.sqlite").exists());
    let reopened = CoreStore::open(&store).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), CoreStore::LATEST);
}

#[test]
fn unreadable_store_fails_closed_before_serving() {
    let dir = TempDir::new();
    std::fs::create_dir_all(dir.path().join("state")).unwrap();
    std::fs::write(
        dir.path().join("state").join("core.sqlite"),
        vec![0x55; 4096],
    )
    .unwrap();
    let data_dir = dir.path().to_str().unwrap().to_owned();
    let daemon = Daemon::spawn(&[&format!("--data-dir={data_dir}")]);
    assert_eq!(daemon.finish(), 3);
}

#[test]
fn invalid_arguments_are_rejected() {
    for args in [
        &["--data-dir", "relative/dir"][..],
        &["--verbose"],
        &["--data-dir"],
    ] {
        assert_eq!(Daemon::spawn(args).finish(), 2, "{args:?}");
    }
}
