use crate::worker_exchange::{CloseReason, Exchange, MAX_ISSUED_REQUESTS, Notice, Phase};
use crate::worker_protocol::{
    DecodeError, ErrorCode, Frame, FrameReader, MAX_FRAME_BYTES, encode, parse_frame,
};
use serde_json::{Value, json};

const VERSION: &str = "1.2.3-probe+1";
const ID: &str = "12345678-1234-4123-8123-123456789abc";

fn hello() -> Frame {
    Frame::Hello {
        worker_version: VERSION.into(),
    }
}
fn request() -> Frame {
    Frame::Request {
        request_id: ID.into(),
        deadline_ms: 50,
    }
}
fn response(id: &str) -> Frame {
    Frame::Response {
        request_id: id.into(),
        worker_version: VERSION.into(),
    }
}
fn ready(now: u64) -> Exchange {
    let mut exchange = Exchange::new(VERSION, now, 10).unwrap();
    assert_eq!(exchange.receive(hello(), now), Ok(Notice::Hello));
    exchange
}
fn pending() -> Exchange {
    let mut exchange = ready(0);
    assert_eq!(exchange.request(ID, 50, 1), Ok(request()));
    exchange
}
fn assert_terminal(mut exchange: Exchange) {
    assert_eq!(exchange.phase(), Phase::Retired);
    assert!(!exchange.physical_settlement_verified());
    assert_eq!(exchange.tick(1000), Err(CloseReason::Retired));
    assert_eq!(exchange.receive(hello(), 1000), Err(CloseReason::Retired));
    assert_eq!(exchange.request(ID, 1, 1000), Err(CloseReason::Retired));
    assert_eq!(exchange.cancel(1000), Err(CloseReason::Retired));
}
fn assert_invalid(value: Value) {
    assert_eq!(parse_frame(&value), Err(DecodeError::InvalidFrame));
}

#[test]
fn worker_shared_frame_fixtures_have_matching_verdicts_and_round_trips() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/worker/frames.json"
    ))
    .unwrap();
    assert_eq!(fixture["contract"], "pythonWorkerFrame");
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let valid = case["valid"].as_bool().unwrap();
        let value = &case["value"];
        let decoded = parse_frame(value);
        assert_eq!(decoded.is_ok(), valid, "fixture: {name}");
        let mut line = serde_json::to_vec(value).unwrap();
        line.push(b'\n');
        let streamed = FrameReader::new().push(&line);
        assert_eq!(streamed.is_ok(), valid, "stream fixture: {name}");
        if let Ok(frame) = decoded {
            assert_eq!(
                parse_frame(&frame.to_value()),
                Ok(frame.clone()),
                "fixture: {name}"
            );
            assert_eq!(
                FrameReader::new().push(&encode(&frame).unwrap()),
                Ok(vec![frame]),
                "fixture: {name}"
            );
        }
    }
}

#[test]
fn worker_shared_raw_frame_fixtures_have_matching_verdicts() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/worker/raw-frames.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let valid = case["valid"].as_bool().unwrap();
        let line = case["line"].as_str().unwrap();
        let mut wire = line.as_bytes().to_vec();
        wire.push(b'\n');
        let mut reader = FrameReader::new();
        let result = reader.push(&wire);
        assert_eq!(result.is_ok(), valid, "raw fixture: {name}");
        if valid {
            assert_eq!(result.unwrap().len(), 1, "raw fixture: {name}");
            assert_eq!(reader.finish(), Ok(()));
        } else {
            assert_eq!(
                result,
                Err(DecodeError::InvalidFrame),
                "raw fixture: {name}"
            );
            assert_eq!(reader.finish(), Err(DecodeError::Closed));
        }
    }
}

#[test]
fn worker_round_trips_all_fixed_frames() {
    for frame in [
        hello(),
        request(),
        Frame::Cancel {
            request_id: ID.into(),
        },
        response(ID),
        Frame::Error {
            request_id: ID.into(),
            code: ErrorCode::Cancelled,
        },
    ] {
        assert_eq!(parse_frame(&frame.to_value()), Ok(frame.clone()));
        let encoded = encode(&frame).unwrap();
        assert_eq!(encoded.last(), Some(&b'\n'));
        assert_eq!(FrameReader::new().push(&encoded), Ok(vec![frame]));
    }
    for code in [
        ErrorCode::InvalidRequest,
        ErrorCode::UnsupportedOperation,
        ErrorCode::Cancelled,
        ErrorCode::Unavailable,
        ErrorCode::InternalError,
    ] {
        let frame = Frame::Error {
            request_id: ID.into(),
            code,
        };
        assert_eq!(parse_frame(&frame.to_value()), Ok(frame));
    }
}

#[test]
fn worker_fields_are_exact_bounded_and_probe_only() {
    for frame in [
        hello(),
        request(),
        Frame::Cancel {
            request_id: ID.into(),
        },
        response(ID),
        Frame::Error {
            request_id: ID.into(),
            code: ErrorCode::InternalError,
        },
    ] {
        let original = frame.to_value();
        let keys: Vec<_> = original.as_object().unwrap().keys().cloned().collect();
        for key in keys {
            let mut missing = original.clone();
            missing.as_object_mut().unwrap().remove(&key);
            assert_invalid(missing);
        }
        let mut extra = original.clone();
        extra["message"] = json!("forbidden");
        assert_invalid(extra);
        for version in [json!(2), json!(1.5), json!("1"), json!(true)] {
            let mut value = original.clone();
            value["schema_version"] = version;
            assert_invalid(value);
        }
    }
    for value in [json!(null), json!([]), json!(false), json!("frame")] {
        assert_invalid(value);
    }
    let mut value = request().to_value();
    value["payload"]["path"] = json!("example");
    assert_invalid(value);
    let mut value = request().to_value();
    value["operation"] = json!("scan");
    assert_invalid(value);
    let mut value = hello().to_value();
    value["operations"] = json!(["health", "scan"]);
    assert_invalid(value);
    let mut value = hello().to_value();
    value["operations"] = json!([]);
    assert_invalid(value);
    let mut value = response(ID).to_value();
    value["result"]["ready"] = json!(true);
    assert_invalid(value);
    let mut value = response(ID).to_value();
    value["result"]["status"] = json!("ready");
    assert_invalid(value);
    let mut value = Frame::Error {
        request_id: ID.into(),
        code: ErrorCode::InternalError,
    }
    .to_value();
    value["error"]["message"] = json!("private text");
    assert_invalid(value);
    let mut value = Frame::Error {
        request_id: ID.into(),
        code: ErrorCode::InternalError,
    }
    .to_value();
    value["error"]["code"] = json!("other");
    assert_invalid(value);
    let mut value = hello().to_value();
    value["x".repeat(100_000)] = json!(null);
    assert_invalid(value);
    let mut value = request().to_value();
    value["payload"] = json!({"large": "x".repeat(100_000)});
    assert_invalid(value);
}

#[test]
fn worker_uuid_version_and_deadline_bounds_apply_to_constructed_frames_too() {
    for value in ["a", "0", "A", &"a".repeat(128), "1.+_-"] {
        let frame = Frame::Hello {
            worker_version: value.into(),
        };
        assert!(encode(&frame).is_ok());
        assert!(parse_frame(&frame.to_value()).is_ok());
    }
    for value in [
        "",
        ".1",
        "-1",
        "1 2",
        "1/2",
        "é",
        "1é",
        "1\n",
        &"a".repeat(129),
    ] {
        let frame = Frame::Hello {
            worker_version: value.into(),
        };
        assert_eq!(encode(&frame), Err(DecodeError::InvalidFrame));
        assert_invalid(frame.to_value());
    }
    for version in 1..=8 {
        let id = format!("12345678-1234-{version}123-b123-123456789abc");
        assert!(encode(&Frame::Cancel { request_id: id }).is_ok());
    }
    for id in [
        "12345678-1234-0123-8123-123456789abc",
        "12345678-1234-9123-8123-123456789abc",
        "12345678-1234-4123-7123-123456789abc",
        "12345678-1234-4123-8123-123456789abC",
        "12345678123441238123123456789abc",
        "",
    ] {
        let frame = Frame::Cancel {
            request_id: id.into(),
        };
        assert_eq!(encode(&frame), Err(DecodeError::InvalidFrame));
        assert_invalid(frame.to_value());
    }
    for deadline in [1, 300_000] {
        assert!(
            encode(&Frame::Request {
                request_id: ID.into(),
                deadline_ms: deadline
            })
            .is_ok()
        );
    }
    for deadline in [0, 300_001, u64::MAX] {
        let frame = Frame::Request {
            request_id: ID.into(),
            deadline_ms: deadline,
        };
        assert_eq!(encode(&frame), Err(DecodeError::InvalidFrame));
        assert_invalid(frame.to_value());
    }
    for deadline in [json!(-1), json!(1.5), json!("50"), json!(null)] {
        let mut value = request().to_value();
        value["deadline_ms"] = deadline;
        assert_invalid(value);
    }
}

#[test]
fn worker_reader_is_incremental_and_terminal_on_all_invalid_input() {
    let encoded = encode(&hello()).unwrap();
    let mut reader = FrameReader::new();
    for byte in &encoded[..encoded.len() - 1] {
        assert!(reader.push(&[*byte]).unwrap().is_empty());
    }
    assert_eq!(reader.push(b"\n"), Ok(vec![hello()]));
    assert_eq!(reader.finish(), Ok(()));
    assert_eq!(reader.push(&encoded), Err(DecodeError::Closed));
    assert_eq!(reader.finish(), Err(DecodeError::Closed));
    for bytes in [
        b"\n".as_slice(),
        b"\r\n",
        b" \n",
        b"{}\n",
        b"\xef\xbb\xbf{}\n",
        b"\xff\n",
        b"{\n",
        b"{\"schema_version\":1,\"kind\":\"hello\",\"worker_version\":\"\\ud800\",\"operations\":[\"health\"]}\n",
    ] {
        let mut reader = FrameReader::new();
        assert_eq!(reader.push(bytes), Err(DecodeError::InvalidFrame));
        assert_eq!(reader.push(&encoded), Err(DecodeError::Closed));
        assert_eq!(reader.finish(), Err(DecodeError::Closed));
    }
    let mut reader = FrameReader::new();
    assert!(reader.push(b"{\"worker_version\":\"").unwrap().is_empty());
    assert!(reader.push(&[0xc3]).unwrap().is_empty());
    assert_eq!(reader.push(b"x\"}\n"), Err(DecodeError::InvalidFrame));
    let mut reader = FrameReader::new();
    reader.push(b"{}").unwrap();
    assert_eq!(reader.finish(), Err(DecodeError::Truncated));
    assert_eq!(reader.finish(), Err(DecodeError::Closed));
    assert_eq!(FrameReader::new().finish(), Ok(()));
}

#[test]
fn worker_json_integers_are_semantic_across_float_and_exponent_literals() {
    for (schema, deadline) in [("1.0", "50.0"), ("1e0", "5e1")] {
        let line = format!(
            "{{\"schema_version\":{schema},\"kind\":\"request\",\"request_id\":\"{ID}\",\"operation\":\"health\",\"deadline_ms\":{deadline},\"payload\":{{}}}}\n"
        );
        assert_eq!(
            FrameReader::new().push(line.as_bytes()),
            Ok(vec![request()])
        );
    }
}

#[test]
fn worker_raw_json_guard_rejects_duplicates_even_when_overwritten_or_escaped() {
    for line in [
        format!(
            r#"{{"schema_version":1,"kind":"hello","worker_version":"bad","worker_version":"{VERSION}","operations":["health"]}}"#
        ),
        format!(
            r#"{{"schema_version":1,"schema_\u0076ersion":1,"kind":"hello","worker_version":"{VERSION}","operations":["health"]}}"#
        ),
        format!(
            r#"{{"schema_version":1,"kind":"hello","worker_version":"\ud800","worker_version":"{VERSION}","operations":["health"]}}"#
        ),
        format!(
            r#"{{"schema_version":1,"kind":"hello","worker_version":"é","worker_version":"{VERSION}","operations":["health"]}}"#
        ),
        format!(
            r#"{{"schema_version":1,"kind":"hello","worker_version":"{}","worker_version":"{VERSION}","operations":["health"]}}"#,
            "a".repeat(129)
        ),
        format!(
            r#"{{"schema_version":1,"kind":"response","request_id":"{ID}","result":{{"status":"bad","status":"ok","worker_version":"{VERSION}"}}}}"#
        ),
        format!(
            r#"{{"schema_version":1,"kind":"request","request_id":"{ID}","operation":"health","deadline_ms":50,"payload":{{"deep":[]}}}}"#
        ),
        "[[[".repeat(1000),
        "\u{000b}{}".into(),
        "\u{000c}{}".into(),
    ] {
        let mut wire = encode(&hello()).unwrap();
        wire.extend_from_slice(line.as_bytes());
        wire.push(b'\n');
        let mut reader = FrameReader::new();
        assert_eq!(reader.push(&wire), Err(DecodeError::InvalidFrame));
        assert_eq!(
            reader.push(&encode(&hello()).unwrap()),
            Err(DecodeError::Closed)
        );
    }
}

#[test]
fn worker_raw_json_guard_accepts_ascii_escapes_and_exact_string_bound() {
    for line in [
        format!(
            r#"{{"schema_version":1,"kind":"hello","worker_\u0076ersion":"{VERSION}","operations":["he\u0061lth"]}}"#
        ),
        format!(
            r#"{{"schema_version":1,"kind":"hello","worker_version":"{}","operations":["health"]}}"#,
            "\\u0061".repeat(128)
        ),
    ] {
        let frame = parse_frame(&serde_json::from_str(&line).unwrap()).unwrap();
        let mut wire = line.into_bytes();
        wire.push(b'\n');
        assert_eq!(FrameReader::new().push(&wire), Ok(vec![frame]));
    }
}

#[test]
fn worker_reader_enforces_exact_lf_and_crlf_byte_budget() {
    let mut base = encode(&hello()).unwrap();
    base.pop();
    for crlf in [false, true] {
        let mut exact = base.clone();
        exact.resize(MAX_FRAME_BYTES - if crlf { 2 } else { 1 }, b' ');
        if crlf {
            exact.push(b'\r');
        }
        exact.push(b'\n');
        assert_eq!(exact.len(), MAX_FRAME_BYTES);
        assert_eq!(FrameReader::new().push(&exact), Ok(vec![hello()]));
        let mut too_large = exact.clone();
        too_large.insert(base.len(), b' ');
        let mut reader = FrameReader::new();
        assert_eq!(reader.push(&too_large), Err(DecodeError::Oversize));
        assert_eq!(reader.push(b"\n"), Err(DecodeError::Closed));
    }
    let mut reader = FrameReader::new();
    assert!(
        reader
            .push(&vec![b' '; MAX_FRAME_BYTES - 1])
            .unwrap()
            .is_empty()
    );
    assert_eq!(reader.push(b" "), Err(DecodeError::Oversize));
    assert_eq!(
        FrameReader::new().push(&vec![b' '; 1_000_000]),
        Err(DecodeError::Oversize)
    );
}

#[test]
fn worker_push_is_atomic_and_batch_bound_is_per_push() {
    let encoded = encode(&hello()).unwrap();
    assert_eq!(
        FrameReader::new().push(&encoded.repeat(64)).unwrap().len(),
        64
    );
    let mut reader = FrameReader::new();
    assert_eq!(
        reader.push(&encoded.repeat(65)),
        Err(DecodeError::TooManyFrames)
    );
    assert_eq!(reader.push(&encoded), Err(DecodeError::Closed));
    let mut invalid = encoded.clone();
    invalid.extend_from_slice(b"invalid\n");
    assert_eq!(
        FrameReader::new().push(&invalid),
        Err(DecodeError::InvalidFrame)
    );
    let mut oversize = encoded.clone();
    oversize.resize(encoded.len() + MAX_FRAME_BYTES, b' ');
    assert_eq!(
        FrameReader::new().push(&oversize),
        Err(DecodeError::Oversize)
    );
    let mut reader = FrameReader::new();
    assert_eq!(reader.push(&encoded.repeat(64)).unwrap().len(), 64);
    assert_eq!(reader.push(&encoded.repeat(64)).unwrap().len(), 64);
}

#[test]
fn worker_exchange_accepts_health_data_without_physical_proof() {
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(exchange.phase(), Phase::AwaitingHello);
    assert!(!exchange.physical_settlement_verified());
    assert_eq!(exchange.receive(hello(), 1), Ok(Notice::Hello));
    assert_eq!(exchange.phase(), Phase::Ready);
    assert_eq!(exchange.request(ID, 50, 2), Ok(request()));
    assert_eq!(exchange.phase(), Phase::Pending);
    assert_eq!(exchange.receive(response(ID), 51), Ok(Notice::Response));
    assert_eq!(exchange.phase(), Phase::Ready);
    assert!(!exchange.physical_settlement_verified());
    for code in [
        ErrorCode::InvalidRequest,
        ErrorCode::UnsupportedOperation,
        ErrorCode::Cancelled,
        ErrorCode::Unavailable,
        ErrorCode::InternalError,
    ] {
        let mut exchange = pending();
        assert_eq!(
            exchange.receive(
                Frame::Error {
                    request_id: ID.into(),
                    code
                },
                2
            ),
            Ok(Notice::Error { code })
        );
        assert_terminal(exchange);
    }
}

#[test]
fn worker_exchange_rejects_unsolicited_duplicate_wrong_direction_and_correlation() {
    for frame in [
        request(),
        response(ID),
        Frame::Cancel {
            request_id: ID.into(),
        },
        Frame::Error {
            request_id: ID.into(),
            code: ErrorCode::InternalError,
        },
    ] {
        let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
        assert_eq!(
            exchange.receive(frame, 1),
            Err(CloseReason::ProtocolViolation)
        );
        assert_terminal(exchange);
    }
    for frame in [
        hello(),
        request(),
        response(ID),
        Frame::Cancel {
            request_id: ID.into(),
        },
    ] {
        let mut exchange = ready(0);
        assert_eq!(
            exchange.receive(frame, 1),
            Err(CloseReason::ProtocolViolation)
        );
        assert_terminal(exchange);
    }
    for frame in [
        hello(),
        request(),
        Frame::Cancel {
            request_id: ID.into(),
        },
    ] {
        let mut exchange = pending();
        assert_eq!(
            exchange.receive(frame, 2),
            Err(CloseReason::ProtocolViolation)
        );
        assert_terminal(exchange);
    }
    for frame in [
        response("12345678-1234-4123-8123-123456789abd"),
        Frame::Error {
            request_id: "12345678-1234-4123-8123-123456789abd".into(),
            code: ErrorCode::Cancelled,
        },
    ] {
        let mut exchange = pending();
        assert_eq!(
            exchange.receive(frame, 2),
            Err(CloseReason::CorrelationMismatch)
        );
        assert_terminal(exchange);
    }
    let mut exchange = pending();
    exchange.receive(response(ID), 2).unwrap();
    assert_eq!(
        exchange.receive(response(ID), 3),
        Err(CloseReason::ProtocolViolation)
    );
    assert_terminal(exchange);
}

#[test]
fn worker_exchange_version_configuration_and_frames_are_validated() {
    for version in ["", "é", &"x".repeat(129)] {
        assert!(matches!(
            Exchange::new(version, 0, 1),
            Err(CloseReason::InvalidConfiguration)
        ));
    }
    assert!(matches!(
        Exchange::new(VERSION, 0, 0),
        Err(CloseReason::InvalidConfiguration)
    ));
    assert!(matches!(
        Exchange::new(VERSION, 0, 300_001),
        Err(CloseReason::InvalidConfiguration)
    ));
    assert!(Exchange::new(VERSION, 0, 300_000).is_ok());
    assert!(matches!(
        Exchange::new(VERSION, u64::MAX, 1),
        Err(CloseReason::ClockOverflow)
    ));
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(
        exchange.receive(
            Frame::Hello {
                worker_version: "other".into()
            },
            1
        ),
        Err(CloseReason::VersionMismatch)
    );
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(
        exchange.receive(
            Frame::Response {
                request_id: ID.into(),
                worker_version: "other".into()
            },
            2
        ),
        Err(CloseReason::VersionMismatch)
    );
    assert_terminal(exchange);
    let mut exchange = ready(0);
    assert_eq!(
        exchange.receive(
            Frame::Hello {
                worker_version: "".into()
            },
            1
        ),
        Err(CloseReason::InvalidFrame)
    );
    assert_terminal(exchange);
    for (id, deadline) in [("bad", 1), (ID, 0), (ID, 300_001)] {
        let mut exchange = ready(0);
        assert_eq!(
            exchange.request(id, deadline, 1),
            Err(CloseReason::InvalidFrame)
        );
        assert_terminal(exchange);
    }
}

#[test]
fn worker_constructed_huge_fields_are_rejected_before_serialization() {
    let frame = Frame::Hello {
        worker_version: "x".repeat(1_000_000),
    };
    assert_eq!(encode(&frame), Err(DecodeError::InvalidFrame));
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(exchange.receive(frame, 1), Err(CloseReason::InvalidFrame));
    assert_terminal(exchange);
    let id = "x".repeat(1_000_000);
    let frame = Frame::Cancel {
        request_id: id.clone(),
    };
    assert_eq!(encode(&frame), Err(DecodeError::InvalidFrame));
    let mut exchange = ready(0);
    assert_eq!(exchange.request(&id, 1, 0), Err(CloseReason::InvalidFrame));
    assert_terminal(exchange);
}

#[test]
fn worker_exchange_retires_on_cancel_and_never_accepts_late_data() {
    for frame in [
        hello(),
        response(ID),
        Frame::Error {
            request_id: ID.into(),
            code: ErrorCode::Cancelled,
        },
    ] {
        let mut exchange = pending();
        assert_eq!(
            exchange.cancel(2),
            Ok(Frame::Cancel {
                request_id: ID.into()
            })
        );
        assert_eq!(exchange.receive(frame, 3), Err(CloseReason::Retired));
        assert_terminal(exchange);
    }
    for phase in [Phase::AwaitingHello, Phase::Ready] {
        let mut exchange = if phase == Phase::Ready {
            ready(0)
        } else {
            Exchange::new(VERSION, 0, 10).unwrap()
        };
        assert_eq!(exchange.cancel(1), Err(CloseReason::ProtocolViolation));
        assert_terminal(exchange);
    }
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(
        exchange.request(ID, 1, 1),
        Err(CloseReason::ProtocolViolation)
    );
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(
        exchange.request(ID, 1, 2),
        Err(CloseReason::ProtocolViolation)
    );
    assert_terminal(exchange);
}

#[test]
fn worker_exchange_deadlines_expire_at_equality_before_every_transition() {
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(
        exchange.receive(hello(), 10),
        Err(CloseReason::DeadlineExpired)
    );
    assert_terminal(exchange);
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(
        exchange.request(ID, 1, 10),
        Err(CloseReason::DeadlineExpired)
    );
    assert_terminal(exchange);
    let mut exchange = Exchange::new(VERSION, 0, 10).unwrap();
    assert_eq!(exchange.cancel(10), Err(CloseReason::DeadlineExpired));
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(
        exchange.receive(response(ID), 51),
        Err(CloseReason::DeadlineExpired)
    );
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(exchange.cancel(51), Err(CloseReason::DeadlineExpired));
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(
        exchange.request(ID, 1, 51),
        Err(CloseReason::DeadlineExpired)
    );
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(exchange.tick(51), Err(CloseReason::DeadlineExpired));
    assert_terminal(exchange);
}

#[test]
fn worker_exchange_monotonic_clock_and_checked_arithmetic() {
    let mut exchange = ready(10);
    assert_eq!(exchange.tick(9), Err(CloseReason::ClockRegression));
    assert_terminal(exchange);
    let mut exchange = pending();
    assert_eq!(
        exchange.receive(response(ID), 0),
        Err(CloseReason::ClockRegression)
    );
    assert_terminal(exchange);
    let mut exchange = ready(0);
    assert_eq!(
        exchange.request(ID, 1, u64::MAX),
        Err(CloseReason::ClockOverflow)
    );
    assert_terminal(exchange);
    let mut exchange = ready(0);
    assert!(exchange.tick(u64::MAX).is_ok());
    assert!(!exchange.physical_settlement_verified());
}

#[test]
fn worker_exchange_never_reuses_or_evicts_issued_ids() {
    let mut exchange = pending();
    exchange.receive(response(ID), 2).unwrap();
    assert_eq!(
        exchange.request(ID, 1, 3),
        Err(CloseReason::RequestIdReused)
    );
    assert_terminal(exchange);
    let mut exchange = ready(0);
    for index in 0..MAX_ISSUED_REQUESTS {
        let id = format!("12345678-1234-4123-8123-{index:012x}");
        exchange.request(&id, 1, 0).unwrap();
        exchange.receive(response(&id), 0).unwrap();
    }
    assert_eq!(exchange.request(ID, 1, 0), Err(CloseReason::RequestLimit));
    assert_terminal(exchange);
}

#[test]
fn worker_exchange_framing_failure_and_eof_retire_every_phase() {
    for phase in [Phase::AwaitingHello, Phase::Ready, Phase::Pending] {
        for framing in [false, true] {
            let mut exchange = match phase {
                Phase::AwaitingHello => Exchange::new(VERSION, 0, 10).unwrap(),
                Phase::Ready => ready(0),
                _ => pending(),
            };
            if framing {
                exchange.framing_failed();
            } else {
                exchange.eof();
            }
            assert_terminal(exchange);
        }
    }
}
