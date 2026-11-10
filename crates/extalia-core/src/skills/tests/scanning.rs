use super::*;

#[test]
fn split_scan_keeps_store_usable_and_cannot_complete_after_revocation() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let id = registry
        .import(&source, Origin::Imported, "fixture", NOW)
        .unwrap()
        .revision_id;
    let ticket = registry
        .begin_inspection(&id, &inspector.identity(), POLICY_VERSION, NOW)
        .unwrap();
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Inspecting
    );
    assert!(
        registry
            .begin_inspection(&id, &inspector.identity(), POLICY_VERSION, NOW)
            .is_err()
    );
    registry.revoke(&id, "user-revoked", NOW + 1).unwrap();
    let outcome = inspector.inspect(&ticket.request());
    assert!(
        registry
            .complete_inspection(
                ticket,
                outcome,
                &inspector.identity(),
                POLICY_VERSION,
                NOW + 2
            )
            .is_err()
    );
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Revoked
    );
}

#[test]
fn stale_scan_ticket_cannot_complete_newer_retry_after_recovery() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let id = registry
        .import(&source, Origin::Imported, "fixture", NOW)
        .unwrap()
        .revision_id;
    let old = registry
        .begin_inspection(&id, &inspector.identity(), POLICY_VERSION, NOW)
        .unwrap();
    registry.recover_interrupted(NOW + 1).unwrap();
    let new = registry
        .begin_inspection(&id, &inspector.identity(), POLICY_VERSION, NOW + 2)
        .unwrap();
    let outcome = inspector.inspect(&old.request());
    assert!(
        registry
            .complete_inspection(old, outcome, &inspector.identity(), POLICY_VERSION, NOW + 3)
            .is_err()
    );
    let outcome = inspector.inspect(&new.request());
    registry
        .complete_inspection(new, outcome, &inspector.identity(), POLICY_VERSION, NOW + 4)
        .unwrap();
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Inspected
    );
}

#[test]
fn instruction_scan_routes_to_explicit_user_approval_without_fake_evaluation() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let id = registry
        .import(&source, Origin::Imported, "fixture", NOW)
        .unwrap()
        .revision_id;
    registry
        .inspect(&id, &inspector, POLICY_VERSION, NOW)
        .unwrap();
    registry.validate(&id, &ctx, NOW).unwrap();
    assert_eq!(
        registry
            .request_instruction_approval(&id, &ctx, NOW)
            .unwrap(),
        RevisionState::AwaitingApproval
    );
    assert!(registry.active("demo").unwrap().is_none());
    assert!(registry.activate(&id, 1, &ctx, NOW).is_err());
    let revision = registry.revision(&id).unwrap();
    let approval = registry
        .approve(
            &ApprovalRequest {
                revision_id: &id,
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
    registry.activate(&id, approval, &ctx, NOW).unwrap();
    assert!(registry.active("demo").unwrap().is_some());
    drop(registry);
    let count: i64 = store
        .connection()
        .query_row("SELECT COUNT(*) FROM skill_evaluations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn code_and_executable_markdown_cannot_use_instruction_only_route() {
    for executable in [false, true] {
        let dir = TempDir::new();
        let mut store = open(&dir);
        let inspector = FakeInspector::clean();
        let ctx = PolicyContext::current(&inspector);
        let source = if executable {
            let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
            #[cfg(unix)]
            chmod(&source.join("SKILL.md"), 0o755);
            source
        } else {
            dir.package(
                "demo",
                &[("SKILL.md", SKILL_MD), ("run.py", "print('unexecuted')")],
            )
        };
        if executable && !cfg!(unix) {
            continue;
        }
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let id = registry
            .import(&source, Origin::Imported, "fixture", NOW)
            .unwrap()
            .revision_id;
        registry
            .inspect(&id, &inspector, POLICY_VERSION, NOW)
            .unwrap();
        registry.validate(&id, &ctx, NOW).unwrap();
        assert!(
            registry
                .request_instruction_approval(&id, &ctx, NOW)
                .is_err()
        );
        assert_eq!(
            registry.revision(&id).unwrap().state_reason.as_deref(),
            Some("evaluation-required")
        );
        assert!(registry.active("demo").unwrap().is_none());
    }
}

#[test]
fn changed_scanner_settles_current_ticket_without_leaving_inspecting() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let id = registry
        .import(&source, Origin::Imported, "fixture", NOW)
        .unwrap()
        .revision_id;
    let ticket = registry
        .begin_inspection(&id, &inspector.identity(), POLICY_VERSION, NOW)
        .unwrap();
    let outcome = inspector.inspect(&ticket.request());
    let mut changed = inspector.identity();
    changed.pin = None;
    assert!(
        registry
            .complete_inspection(ticket, outcome, &changed, POLICY_VERSION, NOW + 1)
            .is_err()
    );
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Quarantined
    );
    registry.prepare_rescan(&id, NOW + 2).unwrap();
}

#[test]
fn human_preview_is_literal_and_does_not_authorize_agent_reads() {
    for oversized in [false, true] {
        let dir = TempDir::new();
        let mut store = open(&dir);
        let inspector = FakeInspector::clean();
        let ctx = PolicyContext::current(&inspector);
        let body = if oversized {
            format!("{SKILL_MD}{}", "x".repeat(65536))
        } else {
            format!("{SKILL_MD}<script>never execute this literal text</script>")
        };
        let source = dir.package("demo", &[("SKILL.md", &body)]);
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let id = registry
            .import(&source, Origin::Generated, "fixture", NOW)
            .unwrap()
            .revision_id;
        assert_eq!(
            registry.instruction_preview(&id, NOW).unwrap(),
            if oversized { None } else { Some(body) }
        );
        assert!(
            registry
                .read_active_file("demo", "SKILL.md", &ctx, NOW)
                .is_err()
        );
        assert_eq!(
            registry.revision(&id).unwrap().state,
            RevisionState::Quarantined
        );
    }
}

#[test]
fn control_bytes_in_human_preview_are_unavailable_not_malformed_wire_text() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let body = format!("{SKILL_MD}hidden\0control");
    let source = dir.package("demo", &[("SKILL.md", &body)]);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let id = registry
        .import(&source, Origin::Generated, "fixture", NOW)
        .unwrap()
        .revision_id;
    assert_eq!(registry.instruction_preview(&id, NOW).unwrap(), None);
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Quarantined
    );
}
