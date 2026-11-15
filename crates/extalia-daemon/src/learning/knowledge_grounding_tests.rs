use super::*;

fn scope() -> Value {
    json!({"profileId":"default","workspaceId":"workspace"})
}
fn read(path: &str, body: &str, sha: &str) -> Value {
    json!({"profileId":"default","workspaceId":"workspace","path":path,"status":"found","sha256":sha,
        "offset":0,"units":"unicode-code-points","body":body,"truncated":false,"nativeTruncated":false})
}
fn remember(reads: &mut Reads, path: &str, body: &str) {
    reads.observe(
        &json!({"path":path}),
        &read(path, body, &"a".repeat(64)).to_string(),
        &scope(),
    );
}
fn submission(lesson: &str) -> Value {
    json!({"title":"A reusable finding","lesson":lesson,"evidenceIds":["e"]})
}

#[test]
fn canonical_paths_unicode_aliases_headings_blocks_and_embeds_are_grounded() {
    let mut reads = Reads::default();
    remember(
        &mut reads,
        "Guides/日本語.md",
        "# 基本手順\n\n## Detail\nKnown block. ^confirmed\n",
    );
    let mut value = submission(
        "Read [[日本語#基本手順|手順]], [[Guides/日本語#Detail]] and ![[日本語#^confirmed]].",
    );
    let proof = reads.normalize(&mut value).unwrap();
    assert_eq!(
        value["lesson"],
        "Read [[Guides/日本語.md#基本手順|手順]], [[Guides/日本語.md#Detail]] and ![[Guides/日本語.md#^confirmed]]."
    );
    assert_eq!(
        proof,
        json!([{"path":"Guides/日本語.md","sha256":"a".repeat(64)}])
            .as_array()
            .unwrap()
            .clone()
    );
}

#[test]
fn code_fences_inline_code_and_escaped_examples_do_not_become_links() {
    let reads = Reads::default();
    let body = "```md\n[[Unknown]]\n```\n~~~\n[[Also unknown]]\n~~~\n`[[Inline]]` \\[[Escaped]]\n";
    let mut value = submission(body);
    assert!(reads.normalize(&mut value).unwrap().is_empty());
    assert_eq!(value["lesson"], body);
    let mut unclosed = submission("```\n[[Literal]]");
    assert_eq!(
        reads.normalize(&mut unclosed).unwrap_err().1,
        Some("unclosed_knowledge_code_fence")
    );
}

#[test]
fn unresolved_ambiguous_traversal_absolute_and_malformed_links_are_refused() {
    let mut reads = Reads::default();
    remember(&mut reads, "One/Target.md", "Known body");
    remember(&mut reads, "Two/Target.md", "Other body");
    assert_eq!(
        reads
            .normalize(&mut submission("[[Target]]"))
            .unwrap_err()
            .1,
        Some("ambiguous_knowledge_link")
    );
    assert!(
        reads
            .normalize(&mut submission("[[One/Target.md]]"))
            .is_ok()
    );
    for raw in [
        "[[Unknown]]",
        "[[../One/Target]]",
        "[[/One/Target]]",
        "[[C:/Target]]",
        "[[One\\Target]]",
        "[[One/%2e%2e/Target]]",
        "[[#Heading]]",
        "[[One/Target#Missing]]",
        "[[One/Target",
        "[[One/Target|x|y]]",
    ] {
        assert!(
            reads.normalize(&mut submission(raw)).is_err(),
            "accepted {raw}"
        );
    }
}

#[test]
fn search_missing_failed_foreign_and_path_mismatched_results_never_authorize() {
    for mut value in [
        read("Known.md", "Body", &"a".repeat(64)),
        read("Known.md", "Body", &"a".repeat(64)),
        read("Known.md", "Body", &"a".repeat(64)),
        json!({"hits":[{"path":"Known.md"}]}),
    ]
    .into_iter()
    .enumerate()
    {
        match value.0 {
            0 => value.1["profileId"] = "vp-other".into(),
            1 => value.1["workspaceId"] = "elsewhere".into(),
            2 => value.1["status"] = "missing".into(),
            _ => {}
        }
        let mut reads = Reads::default();
        reads.observe(&json!({"path":"Known.md"}), &value.1.to_string(), &scope());
        assert!(reads.normalize(&mut submission("[[Known.md]]")).is_err());
    }
    let mut reads = Reads::default();
    reads.observe(
        &json!({"path":"Other.md"}),
        &read("Known.md", "Body", &"a".repeat(64)).to_string(),
        &scope(),
    );
    assert!(reads.normalize(&mut submission("[[Known.md]]")).is_err());
}

#[test]
fn anchors_require_contiguous_seen_pages_and_ignore_code() {
    let mut reads = Reads::default();
    let mut first = read("Known.md", "# Visible\n```md\n", &"a".repeat(64));
    first["truncated"] = true.into();
    reads.observe(&json!({"path":"Known.md"}), &first.to_string(), &scope());
    let offset = s(&first, "body").chars().count();
    let mut second = read(
        "Known.md",
        "# In code\n```\n## Later\nText ^block\n",
        &"a".repeat(64),
    );
    second["offset"] = offset.into();
    reads.observe(
        &json!({"path":"Known.md","offset":offset}),
        &second.to_string(),
        &scope(),
    );
    assert!(
        reads
            .normalize(&mut submission("[[Known#Later]] [[Known#^block]]"))
            .is_ok()
    );
    assert_eq!(
        reads
            .normalize(&mut submission("[[Known#In code]]"))
            .unwrap_err()
            .1,
        Some("unread_knowledge_anchor")
    );
    let mut incomplete = Reads::default();
    incomplete.observe(
        &json!({"path":"Known.md","offset":offset}),
        &second.to_string(),
        &scope(),
    );
    assert!(
        incomplete
            .normalize(&mut submission("[[Known#Later]]"))
            .is_err()
    );
}

#[test]
fn changed_read_discards_old_anchor_proof() {
    let mut reads = Reads::default();
    remember(&mut reads, "Known.md", "# Old heading");
    reads.observe(
        &json!({"path":"Known.md"}),
        &read("Known.md", "# New heading", &"b".repeat(64)).to_string(),
        &scope(),
    );
    assert!(
        reads
            .normalize(&mut submission("[[Known#Old heading]]"))
            .is_err()
    );
    let proof = reads
        .normalize(&mut submission("[[Known#New heading]]"))
        .unwrap();
    assert_eq!(proof[0]["sha256"], "b".repeat(64));
}

#[test]
fn structured_relationship_is_canonical_evidence_bound_and_not_model_hashed() {
    let mut reads = Reads::default();
    remember(&mut reads, "Guides/Procedure.md", "Known prior procedure");
    let mut value = submission("The user corrected the sequence; verify it before reuse.");
    value["relatedNotes"] = json!([{"path":"Procedure","relation":"updates","reason":"The user supplied a revised sequence.","evidenceIds":["e"]}]);
    let proof = reads.normalize(&mut value).unwrap();
    assert_eq!(value["relatedNotes"][0]["path"], "Guides/Procedure.md");
    assert_eq!(value["relatedNotes"][0]["sourceSha256"], "a".repeat(64));
    let mut record = value.clone();
    record["knowledgeReads"] = json!(proof);
    record["evidence"] = json!([{"id":"e"}]);
    let markdown = relation_markdown(&record).unwrap().join("\n");
    assert!(
        markdown
            .contains("Updates: [[Guides/Procedure.md]] — The user supplied a revised sequence.")
    );
    assert!(markdown.contains("do not verify facts"));
    let mut forged = submission("Grounded lesson");
    forged["relatedNotes"] = json!([{"path":"Procedure","relation":"updates","reason":"Correction","evidenceIds":["e"],"sourceSha256":"b".repeat(64)}]);
    assert!(reads.normalize(&mut forged).is_err());
    for relation in [
        json!({"path":"Procedure","relation":"supersedes","reason":"Claim","evidenceIds":["e"]}),
        json!({"path":"Procedure","relation":"contradicts","reason":"Claim","evidenceIds":["not-current"]}),
        json!({"path":"Procedure","relation":"related","reason":"See [[Hidden]]","evidenceIds":["e"]}),
    ] {
        let mut invalid = submission("A claim");
        invalid["relatedNotes"] = json!([relation]);
        assert!(reads.normalize(&mut invalid).is_err());
    }
}

#[test]
fn revalidation_requires_exact_scope_set_and_current_hash() {
    let expected = vec![json!({"path":"Known.md","sha256":"a".repeat(64)})];
    let current = read("Known.md", "B", &"a".repeat(64));
    let valid = json!([{"path":"Known.md","ok":true,"output":current.to_string()}]);
    revalidate(&expected, &valid, &scope()).unwrap();
    for mutated in [
        json!([]),
        json!([valid[0], valid[0]]),
        json!([{"path":"Other.md","ok":true,"output":current.to_string()}]),
        json!([{"path":"Known.md","ok":false,"output":"missing"}]),
        json!([{"path":"Known.md","ok":true,"output":read("Known.md","Changed",&"b".repeat(64)).to_string()}]),
    ] {
        assert!(revalidate(&expected, &mutated, &scope()).is_err());
    }
}

#[test]
fn bounded_projection_keeps_valid_metadata_and_correction_hints() {
    let mut value = read(
        "Guides/Original.md",
        &"🧭 long body ".repeat(1000),
        &"a".repeat(64),
    );
    value["relatedUpdates"] = json!([{"path":"Learning/workspace/correction.md","relation":"contradicts","sourceSha256":"b".repeat(64),"excerpt":"Unverified correction"}]);
    let serialized = presentation(&value.to_string());
    assert!(serialized.encode_utf16().count() <= 2000);
    let visible: Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(visible["sha256"], value["sha256"]);
    assert_eq!(
        visible["relatedUpdates"][0]["path"],
        "Learning/workspace/correction.md"
    );
    assert_eq!(visible["truncated"], true);
    assert_eq!(
        visible["nextOffset"].as_u64().unwrap(),
        s(&visible, "body").chars().count() as u64
    );
}

#[test]
fn redaction_happens_before_json_encoding_without_changing_source_offsets() {
    let value = read(
        "Known.md",
        "password=syntheticvalue\" after\npassword: \"anothersecret\"\n# Later\n",
        &"a".repeat(64),
    );
    let encoded = presentation(&value.to_string());
    let visible: Value = serde_json::from_str(&encoded).unwrap();
    assert!(!s(&visible, "body").contains("syntheticvalue"));
    assert!(!s(&visible, "body").contains("anothersecret"));
    assert_eq!(
        visible["sourceCharacters"].as_u64().unwrap(),
        s(&value, "body").chars().count() as u64
    );
    assert_eq!(visible["sha256"], value["sha256"]);
    let mut reads = Reads::default();
    reads.observe(&json!({"path":"Known.md"}), &encoded, &scope());
    assert!(reads.normalize(&mut submission("[[Known.md]]")).is_ok());
    assert!(
        reads
            .normalize(&mut submission("[[Known.md#Later]]"))
            .is_err()
    );
}

#[test]
fn canonical_title_expansion_is_bounded_and_relationship_evidence_order_is_stable() {
    let mut reads = Reads::default();
    let long = format!("{}/Note.md", "n".repeat(210));
    remember(&mut reads, &long, "Known body");
    let mut value = submission("Known lesson");
    value["title"] = "[[Note]]".into();
    assert_eq!(
        reads.normalize(&mut value).unwrap_err().1,
        Some("invalid_submission")
    );
    let mut first = submission("Known lesson");
    first["evidenceIds"] = json!(["a", "b"]);
    first["relatedNotes"] = json!([{"path":long,"relation":"related","reason":"The same prior context applies.","evidenceIds":["b","a"]}]);
    let mut second = first.clone();
    second["relatedNotes"][0]["evidenceIds"] = json!(["a", "b"]);
    reads.normalize(&mut first).unwrap();
    reads.normalize(&mut second).unwrap();
    assert_eq!(text::content_hash(&first), text::content_hash(&second));
}
