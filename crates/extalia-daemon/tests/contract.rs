//! Contract parity: the shared TypeScript fixtures must get the same verdict here. Every
//! operation of contract v1 is validated, so every fixture is compared; none is skipped.

use std::path::PathBuf;

use extalia_daemon::wire::{
    self, Frame, FrameReader, HEADER_BYTES, MAX_FRAME_BYTES, Op, parse_frame,
};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/test/fixtures/daemon")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect()
}

#[test]
fn frame_verdicts_match_the_typescript_contract() {
    let fixtures = fixture("frames.json");
    assert_eq!(fixtures["contract"], "daemonFrame");
    let mut compared = Vec::new();
    for case in fixtures["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let valid = case["valid"].as_bool().unwrap();
        let value = &case["value"];
        match parse_frame(value) {
            Ok(frame) => {
                assert!(frame.fully_validated(), "{name}: parameters not inspected");
                assert!(valid, "{name}: accepted here, rejected by TypeScript");
                assert_eq!(&frame.to_value(), value, "{name}: round trip");
                let bytes = wire::encode(&frame).unwrap();
                assert_eq!(
                    wire::decode_payload(&bytes[HEADER_BYTES..]),
                    Ok(frame),
                    "{name}"
                );
                compared.push(name);
            }
            Err(rejection) => {
                assert!(
                    !valid,
                    "{name}: rejected here ({:?}), accepted by TypeScript",
                    rejection.errors
                );
                assert_eq!(
                    rejection.code.as_str(),
                    case["code"].as_str().unwrap(),
                    "{name}: {:?}",
                    rejection.errors
                );
                assert!(!rejection.fatal, "{name}");
                if let Some(id) = &rejection.request_id {
                    assert_eq!(Some(id.as_str()), value["requestId"].as_str(), "{name}");
                }
                compared.push(name);
            }
        }
    }
    let cases = fixtures["cases"].as_array().unwrap();
    assert_eq!(compared.len(), cases.len(), "every fixture is compared");
    // The slice A and skill operations are compared in both directions, valid and rejected.
    let skill_rejected = [
        "skill.import",
        "skill.list",
        "skill.review",
        "skill.approve",
        "skill.activate",
        "skill.read",
    ];
    for op in Op::ALL
        .iter()
        .map(|op| op.as_str())
        .filter(|op| op.starts_with("skill."))
    {
        for kind in ["request", "response"] {
            assert!(
                cases.iter().any(|case| case["value"]["op"] == op
                    && case["value"]["kind"] == kind
                    && case["valid"] == true),
                "{op}: no valid {kind} fixture"
            );
        }
    }
    // The knowledge operations too: a valid request and response and a rejected request each.
    for op in Op::ALL
        .iter()
        .map(|op| op.as_str())
        .filter(|op| op.starts_with("knowledge."))
    {
        for (kind, valid) in [("request", true), ("response", true), ("request", false)] {
            assert!(
                cases.iter().any(|case| case["value"]["op"] == op
                    && case["value"]["kind"] == kind
                    && case["valid"] == valid),
                "{op}: no {kind} fixture with valid = {valid}"
            );
        }
    }
    for op in skill_rejected {
        assert!(
            cases
                .iter()
                .any(|case| case["value"]["op"] == op && case["valid"] == false),
            "{op}: no rejected fixture"
        );
    }
    for op in [
        "mission.create",
        "mission.snapshot",
        "task.transition",
        "event.commit",
    ] {
        for (kind, valid) in [("request", true), ("response", true), ("request", false)] {
            assert!(
                cases.iter().any(|case| case["value"]["op"] == op
                    && case["value"]["kind"] == kind
                    && case["valid"] == valid),
                "{op}: no {kind} fixture with valid = {valid}"
            );
        }
    }
}

#[test]
fn framing_matches_the_typescript_reader() {
    let fixtures = fixture("framing.json");
    assert_eq!(fixtures["maxFrameBytes"], MAX_FRAME_BYTES);
    assert_eq!(fixtures["headerBytes"], HEADER_BYTES);
    for case in fixtures["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = hex(case["hex"].as_str().unwrap());
        let expected = case["results"].as_array().unwrap();
        for chunked in [false, true] {
            let mut reader = FrameReader::new(fixtures["maxFrameBytes"].as_u64().unwrap() as usize);
            let results: Vec<_> = if chunked {
                // Byte by byte, stopping at a fatal error (a latched reader repeats it).
                let mut results = Vec::new();
                for byte in &bytes {
                    if reader.failed() {
                        break;
                    }
                    results.extend(reader.push(&[*byte]));
                }
                results
            } else {
                reader.push(&bytes)
            };
            assert_eq!(results.len(), expected.len(), "{name} (chunked: {chunked})");
            for (result, expected) in results.iter().zip(expected) {
                assert_eq!(result.is_ok(), expected["ok"].as_bool().unwrap(), "{name}");
                if let Err(rejection) = result {
                    assert_eq!(
                        rejection.code.as_str(),
                        expected["code"].as_str().unwrap(),
                        "{name}"
                    );
                    assert_eq!(
                        rejection.fatal,
                        expected["fatal"].as_bool().unwrap(),
                        "{name}"
                    );
                    assert_eq!(
                        rejection.request_id.as_deref(),
                        expected["requestId"].as_str(),
                        "{name}"
                    );
                }
            }
        }
    }
}

#[test]
fn fatal_oversize_latches_and_drops_later_input() {
    let mut reader = FrameReader::new(64);
    let [failure] = <[_; 1]>::try_from(reader.push(&65u32.to_be_bytes())).unwrap();
    assert!(failure.as_ref().is_err_and(|rejection| rejection.fatal));
    assert!(reader.failed());
    let health: Value = serde_json::json!({
        "schemaVersion": 1, "kind": "request", "requestId": "00000000-0000-4000-8000-000000000100",
        "op": "health", "params": {}
    });
    let frame = parse_frame(&health).unwrap();
    assert_eq!(reader.push(&wire::encode(&frame).unwrap()), vec![failure]);
    assert_eq!(reader.pending(), 0);
}

#[test]
fn javascript_number_and_text_semantics() {
    let base = |params: Value| {
        serde_json::json!({
            "schemaVersion": 1.0, "kind": "request", "requestId": "00000000-0000-4000-8000-000000000100",
            "op": "hello", "deadlineMs": 5e3, "params": params
        })
    };
    let accepted = parse_frame(&base(
        serde_json::json!({ "clientVersion": " 0.0.78\u{a0}", "capabilities": ["health"] }),
    ));
    assert!(accepted.is_ok(), "{accepted:?}");
    for params in [
        serde_json::json!({ "clientVersion": "\u{feff}\u{3000}", "capabilities": ["health"] }),
        serde_json::json!({ "clientVersion": "a\u{7f}", "capabilities": ["health"] }),
        serde_json::json!({ "clientVersion": "x".repeat(65), "capabilities": ["health"] }),
        serde_json::json!({ "clientVersion": "1", "capabilities": ["health", "health"] }),
        serde_json::json!({ "clientVersion": "1", "capabilities": Op::ALL.iter().chain([Op::Hello].iter()).map(|op| op.as_str()).collect::<Vec<_>>() }),
    ] {
        let rejection = parse_frame(&base(params.clone())).unwrap_err();
        assert_eq!(rejection.code.as_str(), "invalid_request", "{params}");
    }
    // 64 UTF-16 code units, counted like JavaScript's `length` (an astral character is two).
    let astral = "\u{1f600}".repeat(32);
    assert!(
        parse_frame(&base(
            serde_json::json!({ "clientVersion": astral, "capabilities": ["hello"] })
        ))
        .is_ok()
    );
    let over = format!("{astral}x");
    assert!(
        parse_frame(&base(
            serde_json::json!({ "clientVersion": over, "capabilities": ["hello"] })
        ))
        .is_err()
    );
    let mut fractional =
        base(serde_json::json!({ "clientVersion": "1", "capabilities": ["hello"] }));
    fractional["deadlineMs"] = serde_json::json!(1.5);
    assert_eq!(
        parse_frame(&fractional).unwrap_err().code.as_str(),
        "invalid_frame"
    );
}

#[test]
fn encoding_refuses_invalid_frames() {
    let error = Frame::Error(wire::ErrorFrame {
        request_id: None,
        code: wire::ErrorCode::Internal,
        message: Some("SQLITE_BUSY\n at core.sqlite".into()),
        reason: None,
    });
    assert_eq!(
        wire::encode(&error),
        Err(wire::EncodeError::Invalid(wire::ErrorCode::InvalidFrame))
    );
}

#[test]
fn maximum_mission_snapshot_fits_the_wire_but_obeys_a_smaller_frame_limit() {
    let fixtures = fixture("frames.json");
    let mut value = fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "mission.snapshot running response")
        .unwrap()["value"]
        .clone();
    let uuid = |n: u32| format!("00000000-0000-4000-8000-{n:012x}");
    let tasks: Vec<_> = (0..64).map(|n| serde_json::json!({
        "taskId": uuid(n + 1), "assignedAgentId": uuid(n + 1000), "state": "running", "attempt": 9_007_199_254_740_991_u64,
    })).collect();
    let leases: Vec<_> = (0..64)
        .map(|n| {
            serde_json::json!({
                "leaseId": uuid(n + 2000), "taskId": uuid(n + 1), "holderAgentId": uuid(n + 1000),
                "acquiredAt": "2026-10-22T12:00:00.000Z", "expiresAt": "2026-10-22T12:10:00.000Z",
            })
        })
        .collect();
    value["result"]["tasks"] = tasks.into();
    value["result"]["leases"] = leases.into();
    let frame = parse_frame(&value).unwrap();
    let encoded = wire::encode(&frame).unwrap();
    assert!(encoded.len() < MAX_FRAME_BYTES);
    let mut reader = FrameReader::new(MAX_FRAME_BYTES);
    assert_eq!(reader.push(&encoded), vec![Ok(frame)]);
    let mut smaller = FrameReader::new(encoded.len() - HEADER_BYTES - 1);
    let failures = smaller.push(&encoded);
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[0].as_ref().unwrap_err().code,
        wire::ErrorCode::FrameTooLarge
    );
    assert!(smaller.failed());
}
