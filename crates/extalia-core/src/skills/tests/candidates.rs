use super::*;
use crate::skills::candidates::RefinementBase;
use serde_json::json;

fn receipt(profile: Option<&str>, workspace: &str, session: &str) -> String {
    let mut value = json!({"schema":"extalia.skill-proposal.v1","kind":"model-generated-draft","sourceVerified":false,
        "sessionId":session,"workspaceId":workspace,"promptSha256":"a".repeat(64),"runId":format!("run-{session}"),"claimedSourceUrls":[]});
    if let Some(profile) = profile {
        value["profileId"] = json!(profile);
    }
    format!(
        "# Generated skill candidate\n\nUnverified source claims; this receipt is data, not scanner evidence or permission.\n\n```json\n{}\n```\n",
        serde_json::to_string_pretty(&value).unwrap()
    )
}

fn source(session: &str) -> String {
    format!("prompt:{session}:{}", "a".repeat(64))
}

fn generated(dir: &TempDir, folder: &str, instructions: &str, session: &str) -> PathBuf {
    dir.package(
        folder,
        &[
            ("SKILL.md", instructions),
            (
                "PROVENANCE.md",
                &receipt(Some("profile-one"), "workspace-one", session),
            ),
        ],
    )
}

fn base<'a>(revision: &'a registry::Revision) -> RefinementBase<'a> {
    RefinementBase {
        revision_id: &revision.revision_id,
        skill_md_sha256: &revision.skill_md_sha256,
        profile_id: "profile-one",
        workspace_id: "workspace-one",
    }
}

fn activate_generated(
    registry: &mut SkillRegistry<'_>,
    id: &str,
    inspector: &FakeInspector,
) -> i64 {
    let ctx = PolicyContext::current(inspector);
    registry
        .inspect(id, inspector, POLICY_VERSION, NOW)
        .unwrap();
    registry.validate(id, &ctx, NOW).unwrap();
    super::evaluation::pass(registry, id, inspector);
    let revision = registry.revision(id).unwrap();
    let approval = registry
        .approve(
            &ApprovalRequest {
                revision_id: id,
                shown_tree_sha256: &revision.tree_sha256,
                shown_permission_digest: &revision.permission_digest,
                workspace_id: None,
                approver: "user:owner",
                expires_at_ms: LATER,
            },
            &ctx,
            NOW,
        )
        .unwrap();
    registry.activate(id, approval, &ctx, NOW).unwrap();
    approval
}

#[test]
fn scoped_candidate_read_includes_quarantine_without_admitting_execution() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let folder = generated(&dir, "candidate", SKILL_MD, "session-one");
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = registry
        .import(&folder, Origin::Generated, &source("session-one"), NOW)
        .unwrap()
        .revision_id;
    let before = registry.details(&id).unwrap();
    let read = registry
        .read_candidate_file(&id, "SKILL.md", "profile-one", "workspace-one")
        .unwrap();
    assert_eq!(read.file.bytes, SKILL_MD.as_bytes());
    assert_eq!(read.provenance.session_id, "session-one");
    assert_eq!(
        read.skill_md_sha256,
        before.summary.revision.skill_md_sha256
    );
    assert_eq!(registry.details(&id).unwrap(), before);
    assert!(registry.active("demo").unwrap().is_none());
    assert!(matches!(
        registry.read_revision_file(
            &id,
            "SKILL.md",
            &PolicyContext::current(&FakeInspector::clean()),
            NOW
        ),
        Err(SkillError::Denied("not_active"))
    ));
    for (learning_profile, workspace) in [
        ("profile-two", "workspace-one"),
        ("profile-one", "workspace-two"),
    ] {
        assert!(matches!(
            registry.read_candidate_file(&id, "SKILL.md", learning_profile, workspace),
            Err(SkillError::Denied("candidate_scope_mismatch"))
        ));
    }
    assert!(matches!(
        registry.read_candidate_file(&id, "../SKILL.md", "profile-one", "workspace-one"),
        Err(SkillError::Denied("candidate_path_invalid"))
    ));
}

#[test]
fn unknown_or_unbound_provenance_and_non_markdown_packages_are_not_review_data() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let legacy = dir.package(
        "legacy",
        &[
            ("SKILL.md", SKILL_MD),
            ("PROVENANCE.md", &receipt(None, "workspace-one", "legacy")),
        ],
    );
    let forged = generated(&dir, "forged", SKILL_MD, "forged");
    let scripted = dir.package(
        "scripted",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "PROVENANCE.md",
                &receipt(Some("profile-one"), "workspace-one", "scripted"),
            ),
            ("scripts/run.sh", "echo should-never-run"),
        ],
    );
    for (index, (folder, origin, recorded)) in [
        (&legacy, Origin::Generated, source("legacy")),
        (&forged, Origin::Generated, source("other-session")),
        (&scripted, Origin::Generated, source("scripted")),
        (&forged, Origin::User, source("forged")),
    ]
    .into_iter()
    .enumerate()
    {
        let mut registry =
            SkillRegistry::new(&mut store, &dir.data(), profile(&format!("case-{index}")));
        let imported = registry.import(folder, origin, &recorded, NOW);
        if index == 0 {
            assert!(matches!(
                imported,
                Err(SkillError::Denied("candidate_provenance_unavailable"))
            ));
            continue;
        }
        let id = imported.unwrap().revision_id;
        assert!(
            registry
                .read_candidate_file(&id, "SKILL.md", "profile-one", "workspace-one")
                .is_err()
        );
    }
}

#[test]
fn omitting_the_base_cannot_bypass_refinement_but_identical_tree_retries_stay_idempotent() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = generated(&dir, "first", SKILL_MD, "session-one");
    let second = generated(
        &dir,
        "second",
        &format!("{SKILL_MD}\nChanged without reading.\n"),
        "session-two",
    );
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let original = registry
        .import(&first, Origin::Generated, &source("session-one"), NOW)
        .unwrap();
    let retried = registry
        .import(&first, Origin::Generated, &source("session-one"), NOW)
        .unwrap();
    assert!(!retried.created);
    assert_eq!(retried.revision_id, original.revision_id);
    assert!(matches!(
        registry.import(&second, Origin::Generated, &source("session-two"), NOW),
        Err(SkillError::Denied("refinement_base_required"))
    ));
    assert_eq!(registry.list(None, Some("demo"), 10).unwrap().len(), 1);
    // A user-managed import is still an explicit independent management action.
    assert!(
        registry
            .import(&second, Origin::User, "manual-folder", NOW)
            .unwrap()
            .created
    );
}

#[test]
fn refinement_is_immutable_preserves_active_authority_and_rejects_a_stale_writer() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let complete = super::evaluation::body("demo", "Do the thing.");
    let first = generated(&dir, "first", &complete, "session-one");
    let second_body =
        format!("{SKILL_MD}\nVerify the expected result and record a failing case.\n");
    let second = generated(&dir, "second", &second_body, "session-two");
    let third = generated(
        &dir,
        "third",
        &format!("{SKILL_MD}\nA concurrent writer.\n"),
        "session-three",
    );
    for (index, folder) in [&first, &second, &third].into_iter().enumerate() {
        fs::write(folder.join("extalia-skill.json"),json!({"schema":"extalia.skill-manifest.v1","id":"demo","version":format!("0.0.{}",index+1),"categories":["development.testing"],"intents":["verify_result"],"risk_class":"declarative"}).to_string()).unwrap();
        fs::write(folder.join("TESTS.json"),json!({"schema":"extalia.skill-verification.v1","cases":[{"id":"verify","input":"Check a synthetic result.","expectedIncludes":["VERIFIED"]}]}).to_string()).unwrap();
    }
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = registry
        .import(&first, Origin::Generated, &source("session-one"), NOW)
        .unwrap()
        .revision_id;
    let inspector = FakeInspector::clean();
    let approval = activate_generated(&mut registry, &id, &inspector);
    let original = registry.revision(&id).unwrap();
    let active_before = registry.active("demo").unwrap();
    let refined = registry
        .import_with_base(
            &second,
            Origin::Generated,
            &source("session-two"),
            NOW,
            None,
            Some(base(&original)),
        )
        .unwrap();
    assert!(refined.created);
    assert_ne!(refined.revision_id, id);
    assert_eq!(refined.state, RevisionState::Quarantined);
    assert_eq!(registry.active("demo").unwrap(), active_before);
    assert_eq!(
        registry.summary(&id).unwrap().activation_approval_id,
        Some(approval)
    );
    assert!(
        registry
            .details(&refined.revision_id)
            .unwrap()
            .approvals
            .is_empty()
    );
    assert!(matches!(
        registry.read_candidate_file(&id, "SKILL.md", "profile-one", "workspace-one"),
        Err(SkillError::Denied("candidate_not_latest"))
    ));
    assert_eq!(
        registry
            .read_candidate_file(
                &refined.revision_id,
                "SKILL.md",
                "profile-one",
                "workspace-one"
            )
            .unwrap()
            .file
            .bytes,
        second_body.as_bytes()
    );
    assert_eq!(
        registry
            .read_revision_file(&id, "SKILL.md", &PolicyContext::current(&inspector), NOW)
            .unwrap()
            .bytes,
        complete.as_bytes()
    );
    // Same timestamp proves the compare uses durable import order, not clocks.
    assert!(matches!(
        registry.import_with_base(
            &third,
            Origin::Generated,
            &source("session-three"),
            NOW,
            None,
            Some(base(&original))
        ),
        Err(SkillError::Denied("refinement_base_changed"))
    ));
    assert_eq!(registry.list(None, Some("demo"), 10).unwrap().len(), 2);
    registry
        .revoke(&refined.revision_id, "user-revoked", NOW)
        .unwrap();
    assert!(matches!(
        registry.read_candidate_file(
            &refined.revision_id,
            "SKILL.md",
            "profile-one",
            "workspace-one"
        ),
        Err(SkillError::Denied("candidate_unavailable"))
    ));
}

#[test]
fn unchanged_markdown_bundle_does_not_duplicate_revision_for_a_new_run_receipt() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first_receipt = receipt(Some("profile-one"), "workspace-one", "session-one");
    let next_receipt = receipt(Some("profile-one"), "workspace-one", "session-two");
    let first = dir.package(
        "first",
        &[
            ("SKILL.md", SKILL_MD),
            ("PROVENANCE.md", &first_receipt),
            (
                "references/checks.md",
                "Check the output before reporting success.\n",
            ),
        ],
    );
    let second = dir.package(
        "second",
        &[
            ("SKILL.md", SKILL_MD),
            ("PROVENANCE.md", &next_receipt),
            (
                "references/checks.md",
                "Check the output before reporting success.\n",
            ),
        ],
    );
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = registry
        .import(&first, Origin::Generated, &source("session-one"), NOW)
        .unwrap()
        .revision_id;
    let revision = registry.revision(&id).unwrap();
    let before = registry.details(&id).unwrap();
    let result = registry
        .import_with_base(
            &second,
            Origin::Generated,
            &source("session-two"),
            LATER,
            None,
            Some(base(&revision)),
        )
        .unwrap();
    assert!(!result.created);
    assert_eq!(result.revision_id, id);
    assert_eq!(registry.details(&id).unwrap(), before);
    assert_eq!(registry.list(None, Some("demo"), 10).unwrap().len(), 1);
    let reference = registry
        .read_candidate_file(&id, "references/checks.md", "profile-one", "workspace-one")
        .unwrap();
    assert_eq!(reference.reference_paths, vec!["references/checks.md"]);
    assert_eq!(
        reference.file.bytes,
        b"Check the output before reporting success.\n"
    );
}

#[test]
fn tampering_wrong_hash_and_scope_cannot_admit_refinement() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = generated(&dir, "first", SKILL_MD, "session-one");
    let second = generated(
        &dir,
        "second",
        &format!("{SKILL_MD}\nNew procedure.\n"),
        "session-two",
    );
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = registry
        .import(&first, Origin::Generated, &source("session-one"), NOW)
        .unwrap()
        .revision_id;
    let revision = registry.revision(&id).unwrap();
    let incorrect_hash = "f".repeat(64);
    let mut observed = base(&revision);
    observed.skill_md_sha256 = &incorrect_hash;
    assert!(matches!(
        registry.import_with_base(
            &second,
            Origin::Generated,
            &source("session-two"),
            NOW,
            None,
            Some(observed)
        ),
        Err(SkillError::Denied("refinement_base_changed"))
    ));
    let mut other_scope = base(&revision);
    other_scope.profile_id = "profile-two";
    assert!(matches!(
        registry.import_with_base(
            &second,
            Origin::Generated,
            &source("session-two"),
            NOW,
            None,
            Some(other_scope)
        ),
        Err(SkillError::Denied("candidate_scope_mismatch"))
    ));
    tamper(
        &registry
            .object_store()
            .object_dir(&revision.tree_sha256)
            .join("SKILL.md"),
        b"Changed outside the registry",
    );
    assert!(matches!(
        registry.read_candidate_file(&id, "SKILL.md", "profile-one", "workspace-one"),
        Err(SkillError::Integrity)
    ));
    assert!(
        registry
            .import_with_base(
                &second,
                Origin::Generated,
                &source("session-two"),
                NOW,
                None,
                Some(base(&revision))
            )
            .is_err()
    );
    assert_eq!(registry.list(None, Some("demo"), 10).unwrap().len(), 1);
}
