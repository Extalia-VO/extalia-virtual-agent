use extalia_daemon::wire;
use serde_json::Value;
#[test]
fn shared_routing_fixtures_match_typescript_and_roundtrip() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/daemon/skill-routing.json"
    ))
    .unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let result = wire::parse_frame(&case["value"]);
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        match result {
            Ok(frame) => {
                assert!(frame.fully_validated());
                assert_eq!(frame.to_value(), case["value"], "{}", case["name"]);
                wire::encode(&frame).unwrap();
            }
            Err(error) => assert_eq!(
                error.code.as_str(),
                case["code"].as_str().unwrap(),
                "{}",
                case["name"]
            ),
        }
    }
}
