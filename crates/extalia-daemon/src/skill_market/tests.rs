use super::*;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
static SERIAL: AtomicUsize = AtomicUsize::new(0);
const ID: &str = "01234567-89ab-4cde-8fab-0123456789ab";
const NEXT: &str = "01234567-89ab-4cde-8fab-0123456789ac";
const NOW: i64 = 1_780_000_000_000;
const COMMIT: &str = "1111111111111111111111111111111111111111";
const TREE: &str = "2222222222222222222222222222222222222222";
const SKILL: &[u8] = b"---\nname: sample-skill\ndescription: A useful sample\n---\nFollow the reviewed instructions.\n";
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "extalia-market-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn profile(&self) -> PathBuf {
        self.0.join("profiles/default")
    }
    fn request(&self, operation: &str) -> Request {
        Request {
            schema: SCHEMA.into(),
            request_id: ID.into(),
            client_version: "0.0.0-test".into(),
            operation: operation.into(),
            directory: self.profile().join("skill-market"),
            timeout_ms: 1000,
            query: (operation == "search").then(|| "sample".into()),
            refresh: None,
            repository: (operation == "preview").then(|| "example/skills".into()),
            skill: (operation == "preview").then(|| "sample-skill".into()),
            review_id: matches!(operation, "stage" | "discard").then(|| ID.into()),
        }
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct Mock {
    values: BTreeMap<String, Vec<u8>>,
    calls: Vec<String>,
    error: Option<&'static str>,
}
impl Http for Mock {
    fn get(&mut self, url: &str, limit: usize) -> Result<Vec<u8>> {
        self.calls.push(url.into());
        if let Some(code) = self.error {
            return Err(fail(code));
        }
        let bytes = self
            .values
            .get(url)
            .cloned()
            .ok_or_else(|| fail("not_found"))?;
        if bytes.len() > limit {
            return Err(fail("too_large"));
        }
        Ok(bytes)
    }
}
impl Mock {
    fn json(&mut self, url: &str, value: Value) {
        self.values
            .insert(url.into(), serde_json::to_vec(&value).unwrap());
    }
    fn repository(rows: Vec<Value>) -> Self {
        let mut http = Self::default();
        http.json(
            "https://api.github.com/repos/example/skills/commits/HEAD",
            json!({"sha":COMMIT,"commit":{"tree":{"sha":TREE}}}),
        );
        http.json(
            &format!("https://api.github.com/repos/example/skills/git/trees/{TREE}?recursive=1"),
            json!({"sha":TREE,"truncated":false,"tree":rows}),
        );
        http
    }
    fn package() -> Self {
        let mut http = Self::repository(vec![
            blob("skills/sample/SKILL.md", SKILL.len()),
            blob("skills/sample/data.txt", 4),
            blob("LICENSE", 3),
        ]);
        http.values.insert(
            format!(
                "https://raw.githubusercontent.com/example/skills/{COMMIT}/skills/sample/SKILL.md"
            ),
            SKILL.into(),
        );
        http.values.insert(
            format!(
                "https://raw.githubusercontent.com/example/skills/{COMMIT}/skills/sample/data.txt"
            ),
            b"data".into(),
        );
        http.values.insert(
            format!("https://raw.githubusercontent.com/example/skills/{COMMIT}/LICENSE"),
            b"MIT".into(),
        );
        http
    }
    fn root_skill(manifest: Option<&[u8]>) -> Self {
        let mut files = vec![(SKILL_FILE, SKILL)];
        if let Some(manifest) = manifest {
            files.push((MANIFEST_FILE, manifest));
        }
        let mut http = Self::repository(
            files
                .iter()
                .map(|(name, bytes)| blob(name, bytes.len()))
                .collect(),
        );
        for (name, bytes) in files {
            http.values.insert(
                format!("https://raw.githubusercontent.com/example/skills/{COMMIT}/{name}"),
                bytes.into(),
            );
        }
        http
    }
}
fn blob(path: &str, size: usize) -> Value {
    json!({"path":path,"type":"blob","mode":"100644","size":size,"sha":COMMIT})
}
fn error(result: Result<Value>, code: &str) {
    assert_eq!(result.unwrap_err().code, code);
}
#[test]
fn immutable_preview_stage_hash_and_discard_roundtrip() {
    let temp = Temp::new();
    let mut http = Mock::package();
    let preview = execute(&temp.request("preview"), &mut http, NOW).unwrap();
    assert_eq!(preview["directory"], "skills/sample");
    assert_eq!(preview["commit"], COMMIT);
    assert_eq!(
        preview["sourceRef"],
        format!("github:example/skills@{COMMIT}#skills/sample")
    );
    assert_eq!(preview["files"].as_array().unwrap().len(), 3);
    assert!(
        preview["license"]
            .as_str()
            .unwrap()
            .contains("LICENSE.upstream")
    );
    assert!(
        http.calls
            .iter()
            .filter(|url| url.contains("raw.githubusercontent.com"))
            .all(|url| url.contains(COMMIT))
    );
    let staged = execute(&temp.request("stage"), &mut Mock::default(), NOW + 10).unwrap();
    assert_eq!(staged["treeSha256"], preview["treeSha256"]);
    assert_eq!(staged.as_object().unwrap().len(), 3);
    let path = temp
        .profile()
        .join("skill-imports")
        .join(format!("market-{ID}"));
    assert_eq!(fs::read(path.join("SKILL.md")).unwrap(), SKILL);
    let observed = extalia_core::skills::tree::scan(&path, &Default::default());
    // Production import recomputes the same public canonical hash; local files stay non-executable.
    assert_eq!(
        observed.unwrap().sha256,
        staged["treeSha256"].as_str().unwrap()
    );
    assert_eq!(
        execute(&temp.request("stage"), &mut Mock::default(), NOW + 11).unwrap(),
        staged
    );
    assert_eq!(
        execute(&temp.request("discard"), &mut Mock::default(), NOW).unwrap(),
        json!({"discarded":true})
    );
    assert!(!path.exists());
    assert_eq!(
        execute(&temp.request("discard"), &mut Mock::default(), NOW).unwrap(),
        json!({"discarded":false})
    );
}

#[test]
fn preview_projects_bounded_declarations_from_the_same_bytes_that_are_staged() {
    let temp = Temp::new();
    let permissions: Vec<_> = (0..31)
        .map(|index| format!("docs/file-{index:02}"))
        .collect();
    let compatibility: BTreeMap<_, _> = (0..18)
        .map(|index| (format!("fixture-{index:02}"), ">=1.2.0\n\t<2.0.0"))
        .collect();
    let manifest = serde_json::to_vec(&json!({
        "schema": manifest::MANIFEST_SCHEMA,
        "id": "sample-skill",
        "version": "1.2.3",
        "risk_class": "tool_using",
        "compatibility": compatibility,
        "permissions": {
            "filesystem_read": permissions,
            "network": ["c.example", "a.example", "b.example"],
        },
    }))
    .unwrap();
    let preview = execute(
        &temp.request("preview"),
        &mut Mock::root_skill(Some(&manifest)),
        NOW,
    )
    .unwrap();
    let declarations = &preview["manifest"];
    assert_eq!(declarations["id"], "sample-skill");
    assert_eq!(declarations["version"], "1.2.3");
    assert_eq!(declarations["riskClass"], "tool_using");
    assert_eq!(declarations["inferred"], false);
    assert_eq!(declarations["permissionsTotal"], 34);
    let permissions = declarations["permissions"].as_array().unwrap();
    assert_eq!(permissions.len(), 32);
    assert_eq!(
        permissions.last().unwrap(),
        &json!({"capability":"network","scope":"a.example"})
    );
    assert_eq!(declarations["compatibilityTotal"], 18);
    let compatibility = declarations["compatibility"].as_array().unwrap();
    assert_eq!(compatibility.len(), 16);
    assert_eq!(
        compatibility.first().unwrap(),
        &json!({"id":"fixture-00","range":">=1.2.0 <2.0.0"})
    );
    let staged = execute(&temp.request("stage"), &mut Mock::default(), NOW + 1).unwrap();
    assert_eq!(staged["treeSha256"], preview["treeSha256"]);
    let path = temp
        .profile()
        .join("skill-imports")
        .join(format!("market-{ID}"));
    assert_eq!(fs::read(path.join(MANIFEST_FILE)).unwrap(), manifest);
}

#[test]
fn preview_refuses_manifest_that_disagrees_with_the_skill_before_saving_review() {
    let temp = Temp::new();
    let manifest = serde_json::to_vec(&json!({
        "schema": manifest::MANIFEST_SCHEMA,
        "id": "different-skill",
        "version": "1.0.0",
        "risk_class": "declarative",
    }))
    .unwrap();
    error(
        execute(
            &temp.request("preview"),
            &mut Mock::root_skill(Some(&manifest)),
            NOW,
        ),
        "invalid_manifest",
    );
    assert!(!temp.profile().join("skill-market").join(ID).exists());
    assert!(!temp.profile().join("skill-imports").exists());
}

#[test]
fn manifestless_markdown_preview_reports_an_inferred_version_and_no_declarations() {
    let temp = Temp::new();
    let preview = execute(&temp.request("preview"), &mut Mock::root_skill(None), NOW).unwrap();
    let hash = preview["treeSha256"].as_str().unwrap();
    assert_eq!(
        preview["manifest"],
        json!({
            "id": "sample-skill",
            "version": format!("0.0.0+tree.{}", &hash[..16]),
            "inferred": true,
            "riskClass": "declarative",
            "permissions": [],
            "permissionsTotal": 0,
            "compatibility": [],
            "compatibilityTotal": 0,
        })
    );
}

#[test]
fn malicious_paths_and_modes_are_refused() {
    for path in [
        "../outside",
        "a/../b",
        "/absolute",
        "C:/escape",
        "a\\b",
        "NUL.txt",
        "dir/COM1",
        ".hidden",
        "trailing.",
    ] {
        assert!(!skill_path(path));
        let rows = vec![
            blob("skills/sample/SKILL.md", SKILL.len()),
            blob(&format!("skills/sample/{path}"), 1),
        ];
        assert!(selected_blobs(&rows, "skills/sample").is_err());
    }
    for (kind, mode) in [("blob", "120000"), ("commit", "160000"), ("blob", "100600")] {
        let rows = vec![
            blob("skills/sample/SKILL.md", SKILL.len()),
            json!({"path":"skills/sample/link","type":kind,"mode":mode,"size":1}),
        ];
        assert_eq!(
            selected_blobs(&rows, "skills/sample").unwrap_err().code,
            "invalid_tree"
        );
    }
    assert!(validate_paths(["A/x", "a/y"]).is_err());
    assert!(validate_paths(["a", "a/x"]).is_err());
    assert!(validate_paths(["same", "same"]).is_err());
}
#[test]
fn truncated_or_unpinned_trees_are_never_downloaded() {
    let temp = Temp::new();
    let mut http = Mock::package();
    let tree_url =
        format!("https://api.github.com/repos/example/skills/git/trees/{TREE}?recursive=1");
    http.json(&tree_url, json!({"sha":TREE,"truncated":true,"tree":[]}));
    error(
        execute(&temp.request("preview"), &mut http, NOW),
        "invalid_tree",
    );
    assert!(
        !http
            .calls
            .iter()
            .any(|url| url.contains("raw.githubusercontent.com"))
    );
    http.json(&tree_url, json!({"sha":COMMIT,"truncated":false,"tree":[]}));
    error(
        execute(&temp.request("preview"), &mut http, NOW),
        "invalid_tree",
    );
}
#[test]
fn bounded_file_count_per_file_total_and_lookup() {
    let mut rows = vec![blob("SKILL.md", SKILL.len())];
    rows.extend((0..128).map(|n| blob(&format!("f{n}"), 1)));
    assert_eq!(selected_blobs(&rows, "").unwrap_err().code, "too_large");
    assert_eq!(
        selected_blobs(&[blob("SKILL.md", FILE_LIMIT + 1)], "")
            .unwrap_err()
            .code,
        "too_large"
    );
    let rows: Vec<_> = (0..5)
        .map(|n| blob(&format!("f{n}"), FILE_LIMIT))
        .chain([blob("SKILL.md", SKILL.len())])
        .collect();
    assert_eq!(selected_blobs(&rows, "").unwrap_err().code, "too_large");
    let temp = Temp::new();
    let rows: Vec<_> = (0..33)
        .map(|n| blob(&format!("skill{n}/SKILL.md"), SKILL.len()))
        .collect();
    let mut http = Mock::repository(rows);
    error(
        execute(&temp.request("preview"), &mut http, NOW),
        "too_large",
    );
}
#[test]
fn payload_and_manifest_drift_refuse_stage_without_copying() {
    let temp = Temp::new();
    execute(&temp.request("preview"), &mut Mock::package(), NOW).unwrap();
    let payload = temp
        .profile()
        .join("skill-market")
        .join(ID)
        .join("payload-000.bin");
    fs::write(payload, "changed").unwrap();
    error(
        execute(&temp.request("stage"), &mut Mock::default(), NOW),
        "integrity",
    );
    assert!(!temp.profile().join("skill-imports").exists());
    error(
        execute(
            &temp.request("stage"),
            &mut Mock::default(),
            NOW + REVIEW_TTL,
        ),
        "review_expired",
    );
}
#[test]
fn stale_cache_is_explicit_and_queries_do_not_cross_contaminate() {
    let temp = Temp::new();
    let mut http = Mock::default();
    http.json("https://skills.sh/api/search?q=sample&limit=50", json!({"skills":[{"source":"example/skills","skillId":"sample-skill","name":"Sample skill","installs":12}]}));
    let first = execute(&temp.request("search"), &mut http, NOW).unwrap();
    assert_eq!(first["cached"], false);
    let mut offline = Mock {
        error: Some("network"),
        ..Default::default()
    };
    let cached = execute(&temp.request("search"), &mut offline, NOW + 100).unwrap();
    assert_eq!(cached["cached"], true);
    assert_eq!(cached["stale"], false);
    assert!(offline.calls.is_empty());
    let stale = execute(&temp.request("search"), &mut offline, NOW + CACHE_TTL + 1).unwrap();
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["problem"], "network");
    assert_eq!(stale["fetchedAt"], first["fetchedAt"]);
    let mut other = temp.request("search");
    other.query = Some("other".into());
    error(execute(&other, &mut offline, NOW), "network");
    let mut refresh = temp.request("search");
    refresh.refresh = Some(true);
    let stale = execute(&refresh, &mut offline, NOW + 1).unwrap();
    assert_eq!(stale["stale"], true);
}
#[test]
fn search_rows_are_bounded_validated_and_urls_never_follow_upstream_urls() {
    let mut rows: Vec<Value> = (0..70).map(|n| json!({"source":"example/skills","skillId":format!("skill-{n}"),"name":"Skill","installs":1,"url":"https://untrusted.example/redirect"})).collect();
    rows.insert(0, json!({"source":"../escape","skillId":"bad"}));
    let entries = search_rows(&json!({"skills":rows})).unwrap();
    assert_eq!(entries.len(), 50);
    assert_eq!(entries[0].id, "skill-0");
    assert_eq!(entries[0].url, "https://skills.sh/example/skills/skill-0");
}
#[test]
fn review_collisions_ambiguous_names_and_unowned_stage_are_refused() {
    let temp = Temp::new();
    execute(&temp.request("preview"), &mut Mock::package(), NOW).unwrap();
    error(
        execute(&temp.request("preview"), &mut Mock::package(), NOW),
        "review_conflict",
    );
    let inbox = temp.profile().join("skill-imports");
    fs::create_dir(&inbox).unwrap();
    let stage = inbox.join(format!("market-{ID}"));
    fs::create_dir(&stage).unwrap();
    fs::write(stage.join("user.txt"), b"preserve").unwrap();
    error(
        execute(&temp.request("stage"), &mut Mock::default(), NOW),
        "review_conflict",
    );
    execute(&temp.request("discard"), &mut Mock::default(), NOW).unwrap();
    assert_eq!(fs::read(stage.join("user.txt")).unwrap(), b"preserve");
    let mut second = temp.request("preview");
    second.request_id = NEXT.into();
    let mut http = Mock::package();
    http.json(&format!("https://api.github.com/repos/example/skills/git/trees/{TREE}?recursive=1"), json!({"sha":TREE,"truncated":false,"tree":[blob("one/SKILL.md",SKILL.len()),blob("two/SKILL.md",SKILL.len())]}));
    for dir in ["one", "two"] {
        http.values.insert(
            format!("https://raw.githubusercontent.com/example/skills/{COMMIT}/{dir}/SKILL.md"),
            SKILL.into(),
        );
    }
    error(execute(&second, &mut http, NOW), "invalid_tree");
}
#[test]
fn invalid_wire_is_bounded_and_has_no_filesystem_side_effect() {
    let mut output = Vec::new();
    assert_eq!(serve("{}".as_bytes(), &mut output), 2);
    assert!(output.is_empty());
    let input = format!(
        r#"{{"schema":"extalia.skill-market.v1","requestId":"{ID}","clientVersion":"test","operation":"search","directory":"relative","timeoutMs":1000,"query":"x"}}"#
    );
    assert_eq!(serve(input.as_bytes(), &mut output), 0);
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["code"], "invalid_request");
    output.clear();
    let duplicate = input.replace(
        "\"timeoutMs\":1000",
        "\"timeoutMs\":1000,\"timeoutMs\":2000",
    );
    assert_eq!(serve(duplicate.as_bytes(), &mut output), 0);
    assert!(
        String::from_utf8(output)
            .unwrap()
            .contains("invalid_request")
    );
}
#[cfg(unix)]
#[test]
fn local_symlinks_hardlinks_and_inbox_redirection_are_refused() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    let outside = Temp::new();
    fs::create_dir_all(temp.profile()).unwrap();
    symlink(&outside.0, temp.profile().join("skill-market")).unwrap();
    error(
        execute(&temp.request("preview"), &mut Mock::package(), NOW),
        "storage",
    );
    fs::remove_file(temp.profile().join("skill-market")).unwrap();
    execute(&temp.request("preview"), &mut Mock::package(), NOW).unwrap();
    symlink(&outside.0, temp.profile().join("skill-imports")).unwrap();
    error(
        execute(&temp.request("stage"), &mut Mock::default(), NOW),
        "storage",
    );
    assert!(fs::read_dir(&outside.0).unwrap().next().is_none());
    fs::remove_file(temp.profile().join("skill-imports")).unwrap();
    let payload = temp
        .profile()
        .join("skill-market")
        .join(ID)
        .join("payload-000.bin");
    fs::hard_link(&payload, outside.0.join("hardlink")).unwrap();
    error(
        execute(&temp.request("stage"), &mut Mock::default(), NOW),
        "integrity",
    );
}
#[test]
fn fresh_profile_is_created_privately_and_operations_hold_exclusive_ownership() {
    let temp = Temp::new();
    let mut request = temp.request("search");
    request.directory = temp.0.join("profiles/default/skill-market");
    let mut http = Mock::default();
    http.json(
        "https://skills.sh/api/search?q=sample&limit=50",
        json!({"skills":[]}),
    );
    execute(&request, &mut http, NOW).unwrap();
    let profile = Directory::trusted_root(&temp.0.join("profiles/default")).unwrap();
    let market = profile.child("skill-market", false).unwrap();
    let held = market.lock().unwrap();
    error(execute(&request, &mut http, NOW), "review_conflict");
    drop(held);
    execute(&request, &mut http, NOW).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&request.directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
#[test]
fn cache_evicts_oldest_query_and_keeps_only_sixty_four_owned_entries() {
    let temp = Temp::new();
    let mut http = Mock::default();
    for n in 0..66 {
        let mut request = temp.request("search");
        request.query = Some(format!("query{n}"));
        http.json(
            &format!("https://skills.sh/api/search?q=query{n}&limit=50"),
            json!({"skills":[]}),
        );
        execute(&request, &mut http, NOW + n).unwrap();
    }
    let cache = temp.profile().join("skill-market/cache");
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 64);
    assert!(!cache.join(format!("{}.json", digest(b"query0"))).exists());
    assert!(cache.join(format!("{}.json", digest(b"query65"))).exists());
}
#[test]
fn expires_owned_reviews_stages_and_interrupted_preview_folders() {
    let temp = Temp::new();
    execute(&temp.request("preview"), &mut Mock::package(), NOW).unwrap();
    execute(&temp.request("stage"), &mut Mock::default(), NOW + 1).unwrap();
    let abandoned = temp
        .profile()
        .join("skill-market")
        .join("01234567-89ab-4cde-8fab-0123456789ad");
    fs::create_dir(&abandoned).unwrap();
    fs::write(abandoned.join("payload-000.bin"), b"partial").unwrap();
    let mut next = temp.request("preview");
    next.request_id = NEXT.into();
    execute(&next, &mut Mock::package(), now_millis() + REVIEW_TTL + 1).unwrap();
    assert!(!temp.profile().join("skill-market").join(ID).exists());
    assert!(!abandoned.exists());
    assert!(
        !temp
            .profile()
            .join("skill-imports")
            .join(format!("market-{ID}"))
            .exists()
    );
    assert!(
        !temp
            .profile()
            .join("skill-market")
            .join(format!("stage-{ID}.json"))
            .exists()
    );
}
#[test]
fn staged_hash_drift_and_overflowing_review_metadata_fail_closed() {
    let temp = Temp::new();
    execute(&temp.request("preview"), &mut Mock::package(), NOW).unwrap();
    execute(&temp.request("stage"), &mut Mock::default(), NOW).unwrap();
    fs::write(
        temp.profile()
            .join("skill-imports")
            .join(format!("market-{ID}"))
            .join("SKILL.md"),
        b"drift",
    )
    .unwrap();
    error(
        execute(&temp.request("stage"), &mut Mock::default(), NOW),
        "integrity",
    );
    let file = temp
        .profile()
        .join("skill-market")
        .join(ID)
        .join("review.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value["createdAt"] = json!(i64::MIN);
    value["expiresAt"] = json!(i64::MAX);
    fs::write(file, serde_json::to_vec(&value).unwrap()).unwrap();
    error(
        execute(&temp.request("stage"), &mut Mock::default(), NOW),
        "integrity",
    );
}
#[cfg(unix)]
#[test]
fn internal_profile_links_cannot_redirect_but_configured_data_root_alias_is_supported() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    let outside = Temp::new();
    fs::create_dir(outside.0.join("default")).unwrap();
    symlink(&outside.0, temp.0.join("profiles")).unwrap();
    error(
        execute(&temp.request("preview"), &mut Mock::package(), NOW),
        "storage",
    );
    assert!(
        fs::read_dir(outside.0.join("default"))
            .unwrap()
            .next()
            .is_none()
    );
    fs::remove_file(temp.0.join("profiles")).unwrap();
    fs::create_dir(temp.0.join("profiles")).unwrap();
    symlink(&outside.0, temp.profile()).unwrap();
    error(
        execute(&temp.request("preview"), &mut Mock::package(), NOW),
        "storage",
    );
    assert!(!outside.0.join("skill-market").exists());
    fs::remove_file(temp.profile()).unwrap();
    let alias = outside.0.join("data-alias");
    symlink(&temp.0, &alias).unwrap();
    let mut request = temp.request("preview");
    request.directory = alias.join("profiles/default/skill-market");
    execute(&request, &mut Mock::package(), NOW).unwrap();
    assert!(
        temp.profile()
            .join("skill-market")
            .join(ID)
            .join("review.json")
            .exists()
    );
}
#[test]
fn upstream_prefix_does_not_reduce_package_relative_depth_budget() {
    let temp = Temp::new();
    let mut request = temp.request("preview");
    let directory = "a/b/c/d/e/f/g/h";
    request.skill = Some(directory.into());
    let relative = "refs/a/b/c/d/e/f/note.txt";
    let mut http = Mock::repository(vec![
        blob(&format!("{directory}/SKILL.md"), SKILL.len()),
        blob(&format!("{directory}/{relative}"), 4),
    ]);
    http.values.insert(
        format!("https://raw.githubusercontent.com/example/skills/{COMMIT}/{directory}/SKILL.md"),
        SKILL.into(),
    );
    http.values.insert(
        format!("https://raw.githubusercontent.com/example/skills/{COMMIT}/{directory}/{relative}"),
        b"note".into(),
    );
    let preview = execute(&request, &mut http, NOW).unwrap();
    assert_eq!(preview["directory"], directory);
    assert_eq!(preview["files"].as_array().unwrap().len(), 2);
    execute(&temp.request("stage"), &mut Mock::default(), NOW).unwrap();
}

#[test]
fn source_reference_exceeding_registry_bound_never_creates_review() {
    let temp = Temp::new();
    let mut request = temp.request("preview");
    let directory = vec!["a".repeat(120); 4].join("/");
    request.skill = Some(directory.clone());
    let mut http = Mock::repository(vec![blob(&format!("{directory}/SKILL.md"), SKILL.len())]);
    http.values.insert(
        format!("https://raw.githubusercontent.com/example/skills/{COMMIT}/{directory}/SKILL.md"),
        SKILL.into(),
    );
    assert!(skill_path(&directory));
    assert!(format!("github:example/skills@{COMMIT}#{directory}").len() > 512);
    assert_eq!(
        execute(&request, &mut http, NOW).unwrap_err().code,
        "integrity"
    );
    assert!(!temp.profile().join("skill-market").join(ID).exists());
}
