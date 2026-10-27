//! `permission.check` parity (audit PR 7, ADR 0026): every case of the matrix generated
//! from the TypeScript `decide()` must get the identical decision from the Rust port and
//! from the daemon's `permission.check` dispatch. Regenerate the matrix with
//! `node tooling/generate-permission-matrix.mjs`.

use std::collections::HashSet;
use std::path::PathBuf;

use extalia_core::security::permissions::{
    self, Decision, PermissionMode, SessionPermissionMode, ToolAccess, WorkspacePermissions,
};
use extalia_daemon::session::Session;
use extalia_daemon::wire::{self, Frame, ResponseResult, parse_frame};
use serde_json::{Value, json};

const ID: &str = "00000000-0000-4000-8000-000000000100";

fn matrix() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/runtime/test/fixtures/permission/decide-matrix.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn request(op: &str, params: Value) -> Frame {
    parse_frame(&json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": op, "params": params }))
        .unwrap()
}

#[test]
fn every_matrix_case_matches_the_typescript_decision() {
    let matrix = matrix();
    assert_eq!(matrix["contract"], "permission.check");
    assert_eq!(
        matrix["columns"],
        json!([
            "mode",
            "access",
            "fileWrite",
            "commands",
            "sessionGrants",
            "decision"
        ])
    );
    let cases = matrix["cases"].as_array().unwrap();
    let expected_len = SessionPermissionMode::ALL.len()
        * ToolAccess::ALL.len()
        * PermissionMode::ALL.len().pow(2)
        * (1 << ToolAccess::ALL.len());
    assert_eq!(cases.len(), expected_len, "the matrix covers every input");

    let mut session = Session::new();
    let hello = request(
        "hello",
        json!({ "clientVersion": "test", "capabilities": ["hello", "permission.check"] }),
    );
    assert!(session.handle(Ok(hello)).frame.is_some());

    let mut seen = HashSet::new();
    for case in cases {
        let row = case.as_array().unwrap();
        let [mode, access, file_write, commands, grants, decision] = row.as_slice() else {
            panic!("{case}: expected six columns");
        };
        let grants: Vec<ToolAccess> = grants
            .as_array()
            .unwrap()
            .iter()
            .map(|grant| ToolAccess::parse(grant.as_str().unwrap()).unwrap())
            .collect();
        let mode = SessionPermissionMode::parse(mode.as_str().unwrap()).unwrap();
        let access = ToolAccess::parse(access.as_str().unwrap()).unwrap();
        let workspace = WorkspacePermissions {
            file_write: PermissionMode::parse(file_write.as_str().unwrap()).unwrap(),
            commands: PermissionMode::parse(commands.as_str().unwrap()).unwrap(),
        };
        let expected = Decision::parse(decision.as_str().unwrap()).unwrap();
        let mut grant_set: Vec<_> = grants.iter().map(|grant| grant.as_str()).collect();
        grant_set.sort_unstable();
        assert!(
            seen.insert((mode, access, workspace, grant_set)),
            "{case}: duplicate inputs"
        );

        // The pure port.
        assert_eq!(
            permissions::decide(access, workspace, &grants, mode),
            expected,
            "{case}"
        );

        // The wire round trip and the daemon dispatch.
        let params = json!({
            "access": access.as_str(), "mode": mode.as_str(),
            "workspacePermissions": { "fileWrite": workspace.file_write.as_str(), "commands": workspace.commands.as_str() },
            "sessionGrants": grants.iter().map(|grant| grant.as_str()).collect::<Vec<_>>(),
        });
        let frame = request("permission.check", params);
        assert!(frame.fully_validated(), "{case}");
        let reply = session.handle(Ok(frame));
        assert!(!reply.end, "{case}");
        match reply.frame {
            Some(Frame::Response(response)) => {
                assert_eq!(
                    response.result,
                    ResponseResult::PermissionCheck { decision: expected },
                    "{case}"
                );
                wire::encode(&Frame::Response(response)).unwrap();
            }
            other => panic!("{case}: expected a response, got {other:?}"),
        }
    }
}

#[test]
fn permission_check_requires_the_handshake_and_valid_params() {
    let params = json!({
        "access": "write", "mode": "workspace",
        "workspacePermissions": { "fileWrite": "allow", "commands": "ask" }, "sessionGrants": []
    });
    let mut session = Session::new();
    let reply = session.handle(Ok(request("permission.check", params.clone())));
    assert!(matches!(
        reply.frame,
        Some(Frame::Error(wire::ErrorFrame {
            code: wire::ErrorCode::HandshakeRequired,
            ..
        }))
    ));

    let mut invalid = Vec::new();
    for (pointer, value) in [
        ("/access", json!("network")),
        ("/mode", json!("Plan")),
        ("/workspacePermissions/fileWrite", json!("deny")),
        ("/sessionGrants", json!(["write", "write"])),
        (
            "/sessionGrants",
            json!(["read", "write", "execute", "memory", "meta", "read"]),
        ),
        ("/sessionGrants", json!("write")),
    ] {
        let mut changed = params.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        invalid.push(changed);
    }
    let mut extra = params.clone();
    extra["actor"] = json!("agent");
    invalid.push(extra);
    let mut missing = params.clone();
    missing.as_object_mut().unwrap().remove("sessionGrants");
    invalid.push(missing);
    for params in invalid {
        let rejection = parse_frame(
            &json!({ "schemaVersion": 1, "kind": "request", "requestId": ID,
            "op": "permission.check", "params": params }),
        )
        .unwrap_err();
        assert_eq!(rejection.code.as_str(), "invalid_request", "{params}");
    }
}
