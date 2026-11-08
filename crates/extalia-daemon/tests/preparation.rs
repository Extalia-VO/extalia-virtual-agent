//! Optional preparation lifetime operations and shared TS/Rust contract parity.
use extalia_core::{CoreStore, adapters::sqlite::store_path};
use extalia_daemon::{
    missions::Missions,
    session::Session,
    wire::{self, Frame},
};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
mod support;

struct TempDir(PathBuf, #[allow(dead_code)] support::Isolation);
impl TempDir {
    fn new() -> Self {
        Self::with(support::Isolation::HoldsLocks(support::holds_locks()))
    }
    fn with(isolation: support::Isolation) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let path = std::env::temp_dir().join(format!(
                "extalia-preparation-wire-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => return Self(path, isolation),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("temporary directory: {error}"),
            }
        }
    }
}

#[test]
fn preparation_stdio_eof_never_synthesizes_a_settled_pipeline() {
    let dir = TempDir::with(support::Isolation::SpawnsDaemon(support::spawns_daemon()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
        .arg("--data-dir")
        .arg(&dir.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut send = |op: &str, params: Value| {
        let request=wire::parse_frame(&json!({"schemaVersion":1,"kind":"request","requestId":uuid(100),"op":op,"params":params})).unwrap();
        input.write_all(&wire::encode(&request).unwrap()).unwrap();
        input.flush().unwrap();
        let mut header = [0; 4];
        output.read_exact(&mut header).unwrap();
        let mut payload = vec![0; u32::from_be_bytes(header) as usize];
        output.read_exact(&mut payload).unwrap();
        wire::decode_payload(&payload).unwrap().to_value()
    };
    send(
        "hello",
        json!({"clientVersion":"test","capabilities":["hello"]}),
    );
    let admitted = send("preparation.begin", begin(1));
    assert_eq!(admitted["result"]["kind"], "native-mission-preparation");
    drop(input);
    assert!(child.wait().unwrap().success());
    let mut store = CoreStore::open(&store_path(&dir.0)).unwrap();
    let inspection = store.inspect_preparation("default", &uuid(1)).unwrap();
    assert!(inspection.observation.is_none());
    assert_eq!(inspection.admission.to_value(), admitted["result"]);
    let mut competing = crate::begin(2);
    competing["connectionIds"] = json!(["c_1"]);
    let competing = extalia_core::preparation::PreparationBegin::from_value(&competing).unwrap();
    assert!(matches!(
        store.begin_preparation("default", &competing, extalia_core::time::now_millis()),
        Err(extalia_core::mission::MissionError::Conflict(_))
    ));
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}
fn call(session: &mut Session, op: &str, params: Value) -> Value {
    let value =
        json!({"schemaVersion":1,"kind":"request","requestId":uuid(100),"op":op,"params":params});
    let frame = session.handle(wire::parse_frame(&value)).frame.unwrap();
    wire::encode(&frame).expect("daemon result is fully validated");
    frame.to_value()
}
fn hello(session: &mut Session) -> Value {
    call(
        session,
        "hello",
        json!({"clientVersion":"test","capabilities":["hello"]}),
    )
}
fn begin(n: u32) -> Value {
    json!({"invocationId":uuid(n),"missionId":uuid(80+n),"supervisorId":uuid(90),"canonicalWorkspaceId":uuid(70),"sessionId":format!("s_{n}"),"workspaceId":"w_example","connectionIds":[format!("c_{n}")]})
}
fn ready(dir: &TempDir, profile: &str) -> Session {
    let store = CoreStore::open(&store_path(&dir.0)).unwrap();
    Session::with_missions(Missions::new(store, profile.into()))
}

#[test]
fn preparation_shared_typescript_rust_fixture_verdicts_and_roundtrips_match() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/daemon/preparation.json"
    ))
    .unwrap();
    let cases = fixtures["cases"].as_array().unwrap();
    assert!(cases.len() >= 121);
    for case in cases {
        let parsed = wire::parse_frame(&case["value"]);
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {parsed:?}",
            case["name"]
        );
        if let Ok(frame) = parsed {
            assert!(frame.fully_validated());
            assert_eq!(frame.to_value(), case["value"], "{}", case["name"]);
            wire::encode(&frame).unwrap();
        } else if let Some(code) = case["code"].as_str() {
            assert_eq!(parsed.unwrap_err().code.as_str(), code, "{}", case["name"]);
        }
    }
}

#[test]
fn preparation_optional_ops_preserve_hello_and_require_store_and_handshake() {
    let mut bare = Session::new();
    assert_eq!(
        call(&mut bare, "preparation.begin", begin(1))["error"]["code"],
        "handshake_required"
    );
    let result = hello(&mut bare);
    assert_eq!(result["result"].as_object().unwrap().len(), 3);
    assert_eq!(
        result["result"]["capabilities"],
        json!(["hello", "permission.check", "health"])
    );
    for (op, params) in [
        ("preparation.begin", begin(1)),
        ("preparation.inspect", json!({"invocationId":uuid(1)})),
        (
            "preparation.observe",
            json!({"invocationId":uuid(1),"admissionDigest":"a".repeat(64),"kind":"local-preparation-settled"}),
        ),
    ] {
        assert_eq!(call(&mut bare, op, params)["error"]["code"], "unknown_op");
    }
    let dir = TempDir::new();
    let mut session = ready(&dir, "default");
    let response = hello(&mut session);
    for op in [
        "preparation.begin",
        "preparation.observe",
        "preparation.inspect",
    ] {
        assert!(
            response["result"]["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == op)
        );
    }
    assert_eq!(response["result"].as_object().unwrap().len(), 3);
}

#[test]
fn preparation_daemon_dispatch_keeps_pending_on_restart_and_only_observation_releases_resources() {
    let dir = TempDir::new();
    let mut session = ready(&dir, "default");
    hello(&mut session);
    let params = begin(1);
    let first = call(&mut session, "preparation.begin", params.clone())["result"].clone();
    assert_eq!(first["kind"], "native-mission-preparation");
    assert_eq!(
        call(&mut session, "preparation.begin", params.clone())["result"],
        first
    );
    let store = session.into_missions().unwrap().into_store();
    store.close().unwrap();
    let mut session = ready(&dir, "default");
    hello(&mut session);
    let inspect = call(
        &mut session,
        "preparation.inspect",
        json!({"invocationId":uuid(1)}),
    );
    assert_eq!(inspect["result"]["admission"], first);
    assert!(inspect["result"].get("observation").is_none());
    let mut competing = begin(2);
    competing["workspaceId"] = "w_other".into();
    competing["connectionIds"] = params["connectionIds"].clone();
    assert_eq!(
        call(&mut session, "preparation.begin", competing.clone())["error"]["code"],
        "conflict"
    );
    let mut observation = json!({"invocationId":uuid(1),"admissionDigest":first["admissionDigest"],"kind":"local-preparation-settled"});
    let settled = call(&mut session, "preparation.observe", observation.clone())["result"].clone();
    assert_eq!(settled["kind"], "local-preparation-settled");
    assert_eq!(
        call(&mut session, "preparation.observe", observation.clone())["result"],
        settled
    );
    observation["admissionDigest"] = "0".repeat(64).into();
    assert_eq!(
        call(&mut session, "preparation.observe", observation)["error"]["code"],
        "conflict"
    );
    assert!(
        call(&mut session, "preparation.begin", competing)
            .get("result")
            .is_some()
    );
    let store = session.into_missions().unwrap().into_store();
    store.close().unwrap();
    let mut other = ready(&dir, "other");
    hello(&mut other);
    assert_eq!(
        call(
            &mut other,
            "preparation.inspect",
            json!({"invocationId":uuid(1)})
        )["error"]["code"],
        "not_found"
    );
}

#[test]
fn preparation_wire_rejects_false_abort_observation_and_private_scope_payloads() {
    let mut session = Session::new();
    hello(&mut session);
    let mut params = begin(1);
    params["prompt"] = "example input".into();
    assert_eq!(
        call(&mut session, "preparation.begin", params)["error"]["code"],
        "invalid_request"
    );
    let params = json!({"invocationId":uuid(1),"admissionDigest":"a".repeat(64),"kind":"aborted"});
    assert_eq!(
        call(&mut session, "preparation.observe", params)["error"]["code"],
        "invalid_request"
    );
    // Invalid frames never become an unvalidated request and cannot release resources.
    let frame = wire::parse_frame(
        &json!({"schemaVersion":1,"kind":"request","requestId":uuid(100),"op":"preparation.inspect","params":{"invocationId":uuid(1),"profileId":"other"}}),
    );
    assert!(frame.is_err());
    assert!(matches!(session.handle(frame).frame, Some(Frame::Error(_))));
}

#[test]
fn preparation_daemon_uses_local_time_and_excludes_pending_planning_in_both_directions() {
    for preparation_first in [false, true] {
        let dir = TempDir::new();
        let mut session = ready(&dir, "default");
        hello(&mut session);
        let prep = begin(1);
        let mut planning = prep.clone();
        planning.as_object_mut().unwrap().remove("missionId");
        planning
            .as_object_mut()
            .unwrap()
            .remove("canonicalWorkspaceId");
        planning["invocationId"] = uuid(2).into();
        let (first_op, first_params, second_op, second_params, observe_op, settled_kind) =
            if preparation_first {
                (
                    "preparation.begin",
                    prep,
                    "planning.begin",
                    planning,
                    "preparation.observe",
                    "local-preparation-settled",
                )
            } else {
                (
                    "planning.begin",
                    planning,
                    "preparation.begin",
                    prep,
                    "planning.observe",
                    "local-pipeline-settled",
                )
            };
        let before = extalia_core::time::now_millis();
        let admission = call(&mut session, first_op, first_params)["result"].clone();
        let after = extalia_core::time::now_millis();
        let admitted =
            extalia_core::time::parse_utc(admission["admittedAt"].as_str().unwrap()).unwrap();
        assert!((before..=after).contains(&admitted));
        assert_eq!(
            call(&mut session, second_op, second_params.clone())["error"]["code"],
            "conflict"
        );
        let observed = call(
            &mut session,
            observe_op,
            json!({"invocationId":admission["invocationId"],"admissionDigest":admission["admissionDigest"],"kind":settled_kind}),
        );
        assert!(observed.get("result").is_some());
        let recorded =
            extalia_core::time::parse_utc(observed["result"]["recordedAt"].as_str().unwrap())
                .unwrap();
        assert!(recorded >= admitted);
        assert!(
            call(&mut session, second_op, second_params)
                .get("result")
                .is_some()
        );
    }
}
