use super::*;

struct Fixture {
    data: PathBuf,
    vault: PathBuf,
    owner: Learning,
    pin: Value,
    record: Value,
}
impl Fixture {
    fn new() -> Self {
        let data = std::env::temp_dir().join(format!("extalia-grounded-data-{}", uid()));
        let vault = std::env::temp_dir().join(format!("extalia-grounded-vault-{}", uid()));
        std::fs::create_dir(&data).unwrap();
        std::fs::create_dir(&vault).unwrap();
        extalia_core::skills::storage::initialize(
            &data,
            &extalia_core::skills::ProfileId::parse("default").unwrap(),
        )
        .unwrap();
        std::fs::create_dir(vault.join("Guides")).unwrap();
        std::fs::write(vault.join("Guides/Prior.md"), "# Prior\nPrior procedure.\n").unwrap();
        let mut owner = Learning::new(&data, "default");
        let pin = owner.pin(&json!({"root":vault,"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","purpose":"learning"})).unwrap();
        let sha256 = hash(std::fs::read(vault.join("Guides/Prior.md")).unwrap());
        let record = json!({"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),
            "title":"Correction","lesson":"Review [[Guides/Prior.md]] alongside the current claim.",
            "evidence":[{"id":"e","name":"conversation_user [[Injected]]","content":"The user reported a correction. [[UntrustedSource]]"}],
            "knowledgeReads":[{"path":"Guides/Prior.md","sha256":sha256}],
            "relatedNotes":[{"path":"Guides/Prior.md","relation":"updates","reason":"The user reported a revised procedure.","evidenceIds":["e"],"sourceSha256":sha256}]});
        Self {
            data,
            vault,
            owner,
            pin,
            record,
        }
    }
    fn prepare(&mut self) -> Result<Value> {
        self.owner
            .prepare(&json!({"pinId":self.pin["pinId"],"record":self.record}))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.owner.drafts.clear();
        self.owner.stages.clear();
        self.owner.pins.clear();
        let _ = std::fs::remove_dir_all(&self.data);
        let _ = std::fs::remove_dir_all(&self.vault);
    }
}

#[test]
fn grounded_note_is_append_only_and_evidence_cannot_create_edges() {
    let mut f = Fixture::new();
    f.record["evidence"][0]["id"] = "e [[InjectedId]]".into();
    f.record["relatedNotes"][0]["evidenceIds"] = json!(["e [[InjectedId]]"]);
    let before = std::fs::read(f.vault.join("Guides/Prior.md")).unwrap();
    let draft = f.prepare().unwrap();
    f.owner
        .commit(&json!({"draftId":draft["draftId"]}))
        .unwrap();
    assert_eq!(
        std::fs::read(f.vault.join("Guides/Prior.md")).unwrap(),
        before
    );
    let markdown = std::fs::read_to_string(f.vault.join("Learning/workspace/run.md")).unwrap();
    let links = extalia_core::knowledge::links::parse(&markdown, 1).links;
    assert_eq!(links.len(), 2);
    assert!(links.iter().all(|link| link.target == "Guides/Prior.md"));
    assert!(
        links
            .iter()
            .any(|link| link.edge_type.as_str() == "updates")
    );
    assert!(!markdown.contains("managed_by: extalia"));
}

#[test]
fn changed_deleted_symlinked_or_hardlinked_source_cannot_commit() {
    use std::os::unix::fs::symlink;
    for case in [
        "changed",
        "deleted",
        "symlink",
        "hardlink",
        "parent-symlink",
    ] {
        let mut f = Fixture::new();
        let draft = f.prepare().unwrap();
        let source = f.vault.join("Guides/Prior.md");
        match case {
            "changed" => std::fs::write(&source, "Changed source").unwrap(),
            "deleted" => std::fs::remove_file(&source).unwrap(),
            "symlink" => {
                let external = f.data.join("external.md");
                std::fs::rename(&source, &external).unwrap();
                symlink(external, &source).unwrap();
            }
            "hardlink" => std::fs::hard_link(&source, f.data.join("duplicate.md")).unwrap(),
            _ => {
                let external = f.data.join("moved");
                std::fs::rename(f.vault.join("Guides"), &external).unwrap();
                symlink(external, f.vault.join("Guides")).unwrap();
            }
        }
        assert!(
            f.owner
                .commit(&json!({"draftId":draft["draftId"]}))
                .is_err(),
            "accepted {case}"
        );
        assert!(!f.vault.join("Learning/workspace/run.md").exists());
        assert!(f.owner.drafts.is_empty());
    }
}

#[test]
fn prepare_rejects_stale_or_unproved_links_before_creating_note_folder() {
    let mut f = Fixture::new();
    std::fs::write(f.vault.join("Guides/Prior.md"), "Changed source").unwrap();
    assert_eq!(f.prepare().unwrap_err().1, Some("knowledge_source_changed"));
    assert!(!f.vault.join("Learning").exists());
    f.record.as_object_mut().unwrap().remove("knowledgeReads");
    assert!(f.prepare().is_err());
    assert!(!f.vault.join("Learning").exists());
}

#[test]
fn refined_skill_stage_has_bounded_references_lineage_and_cleans_up() {
    let mut f = Fixture::new();
    let proposal = json!({"name":"procedure-class","description":"Use when applying the matching procedure.","instructions":"## Procedure\nRead references/checks.md before verification.",
        "baseRevisionId":format!("skr_{}","a".repeat(64)),"baseSkillSha256":"b".repeat(64),"baseReadReceipt":"c".repeat(64),"refinementReason":"The user correction adds a reusable check.",
        "references":[{"path":"references/checks.md","content":"# Checks\nVerify the actual result."}]});
    let input = json!({"proposal":proposal,"provenance":{"profileId":"default","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"d".repeat(64)}});
    let stage = f.owner.stage(&input).unwrap();
    let folder = f.data.join("skills/imports").join(s(&stage, "path"));
    assert_eq!(
        std::fs::read_to_string(folder.join("references/checks.md")).unwrap(),
        "# Checks\nVerify the actual result."
    );
    let provenance = std::fs::read_to_string(folder.join("PROVENANCE.md")).unwrap();
    assert!(provenance.contains("baseRevisionId"));
    assert!(!provenance.contains("baseReadReceipt"));
    assert!(!provenance.contains(&"c".repeat(64)));
    let original_hash = text::proposal_json(&text::proposal(&proposal).unwrap());
    let mut reread = proposal.clone();
    reread["baseReadReceipt"] = "e".repeat(64).into();
    assert_eq!(
        original_hash,
        text::proposal_json(&text::proposal(&reread).unwrap())
    );
    f.owner.stages.remove(s(&stage, "stageId"));
    assert!(!folder.exists());
}

#[test]
fn malformed_refinement_or_reference_paths_are_refused() {
    let base = json!({"name":"procedure-class","description":"Use for a procedure.","instructions":"Verify results."});
    for path in [
        "../outside.md",
        "references/../outside.md",
        "references/Upper.md",
        "references/a/b.md",
        "references/a.txt",
    ] {
        let mut p = base.clone();
        p["references"] = json!([{"path":path,"content":"Known reference"}]);
        assert!(text::proposal(&p).is_err(), "accepted {path}");
    }
    let mut p = base.clone();
    p["baseRevisionId"] = format!("skr_{}", "a".repeat(64)).into();
    assert!(text::proposal(&p).is_err());
    let mut p = base;
    p["references"] = json!([{"path":"references/check.md","content":"a".repeat(16385)}]);
    assert!(text::proposal(&p).is_err());
}
