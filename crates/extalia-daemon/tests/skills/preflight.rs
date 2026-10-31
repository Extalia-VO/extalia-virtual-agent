use super::*;

pub(super) fn snapshot(dir: &TempDir) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    let conn = rusqlite::Connection::open_with_flags(
        store_path(&dir.data()),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'skill_%' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
                .unwrap();
            let count = stmt.column_count();
            let rows = stmt
                .query_map([], |row| {
                    (0..count)
                        .map(|i| row.get(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (table, rows)
        })
        .collect()
}

#[test]
fn diagnostic_wire_preserves_tables_on_success_blockers_and_refusal() {
    let dir = TempDir::new();
    let mut session = start(
        &dir,
        open(&dir),
        "default",
        Some(FakeInspector(Severity::None)),
    );
    dir.inbox_package(
        "default",
        "demo",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest("1.0.0")),
        ],
    );
    let imported = op(
        &mut session,
        "skill.import",
        json!({"origin":"user","path":"demo"}),
    )
    .unwrap();
    let root = imported["revisionId"].as_str().unwrap();
    assert!(
        hello(&mut session)
            .iter()
            .any(|name| name == "skill.preflight")
    );
    let before = snapshot(&dir);
    let result = op(
        &mut session,
        "skill.preflight",
        json!({"rootRevisionId":root,"pins":{}}),
    )
    .unwrap();
    assert_eq!(result["status"], "consistent");
    assert_eq!(result["dispatchEligible"], false);
    assert_eq!(result["plan"][0]["revisionId"], root);
    assert_eq!(snapshot(&dir), before);
    assert!(
        op(
            &mut session,
            "skill.preflight",
            json!({"rootRevisionId":root,"pins":{"wrong-package":root}})
        )
        .is_err()
    );
    assert_eq!(snapshot(&dir), before);
    assert!(
        op(
            &mut session,
            "skill.preflight",
            json!({"rootRevisionId":root,"pins":{},"profile":"foreign"})
        )
        .is_err()
    );
    assert_eq!(snapshot(&dir), before);
    assert!(
        op(
            &mut session,
            "skill.preflight",
            json!({"rootRevisionId":format!("skr_{}", "f".repeat(64)),"pins":{}})
        )
        .is_err()
    );
    assert_eq!(snapshot(&dir), before);
}

#[test]
fn unavailable_scanner_and_missing_pins_are_blockers_without_inspect_or_activation() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    let mut value: Value = serde_json::from_str(&manifest("1.0.0")).unwrap();
    value["dependencies"] = json!([{"id":"dependency","range":"^1"}]);
    dir.inbox_package(
        "default",
        "demo",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &value.to_string()),
        ],
    );
    let imported = op(
        &mut session,
        "skill.import",
        json!({"origin":"user","path":"demo"}),
    )
    .unwrap();
    let before = snapshot(&dir);
    let result = op(
        &mut session,
        "skill.preflight",
        json!({"rootRevisionId":imported["revisionId"],"pins":{}}),
    )
    .unwrap();
    let issues = result["issues"].as_array().unwrap();
    assert!(issues.iter().any(|item| item["code"] == "root_unavailable"));
    assert!(
        issues
            .iter()
            .any(|item| item["code"] == "missing_pin" && item["relatedPackageId"] == "dependency")
    );
    assert_eq!(result["status"], "blocked");
    assert!(result.get("plan").is_none());
    assert_eq!(snapshot(&dir), before);
}

#[test]
fn diagnostic_projection_truncates_findings_without_exposing_scopes_or_claiming_success() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    let mut value: Value = serde_json::from_str(&manifest("1.0.0")).unwrap();
    let scopes: Vec<String> = (0..64).map(|i| format!("scope-{i}")).collect();
    let hosts: Vec<String> = (0..64).map(|i| format!("host-{i}.example.com")).collect();
    value["permissions"] = json!({"filesystem_read":scopes,"filesystem_write":scopes,"network":hosts,"secrets":scopes,"terminal":true});
    dir.inbox_package(
        "default",
        "demo",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &value.to_string()),
        ],
    );
    let imported = op(
        &mut session,
        "skill.import",
        json!({"origin":"user","path":"demo"}),
    )
    .unwrap();
    let before = snapshot(&dir);
    let result = op(
        &mut session,
        "skill.preflight",
        json!({"rootRevisionId":imported["revisionId"],"pins":{}}),
    )
    .unwrap();
    assert_eq!(result["status"], "blocked");
    assert_eq!(result["truncated"], true);
    assert_eq!(result["dispatchEligible"], false);
    assert_eq!(result["issues"].as_array().unwrap().len(), 256);
    assert!(result.get("plan").is_none());
    let bytes = serde_json::to_vec(&result).unwrap();
    assert!(bytes.len() < 256 * 1024);
    assert!(!String::from_utf8(bytes).unwrap().contains("scope-"));
    assert_eq!(snapshot(&dir), before);
}

#[test]
fn diagnostic_wire_does_not_read_other_profiles() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let source = dir.inbox_package("other", "demo", &[("SKILL.md", SKILL_MD)]);
    let foreign = SkillRegistry::new(&mut store, &dir.data(), ProfileId::parse("other").unwrap())
        .import(&source, Origin::User, "test", 1_800_000_000_000)
        .unwrap()
        .revision_id;
    let mut session = start(&dir, store, "default", None);
    let before = snapshot(&dir);
    let refused = op(
        &mut session,
        "skill.preflight",
        json!({"rootRevisionId":foreign,"pins":{}}),
    );
    assert_eq!(
        refused,
        super::refused("denied", "preflight_revision_unavailable")
    );
    assert_eq!(snapshot(&dir), before);
}
