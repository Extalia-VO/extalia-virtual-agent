use super::*;
fn source(repo: &str, commit: usize, directory: &str) -> String {
    format!("github:{repo}@{commit:040x}#{directory}")
}
#[test]
fn market_revision_sources_survive_restart_and_preserve_repeat_commit_evidence() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let first = source("example/skills", 1, "skills/demo");
    let second = source("Example/Skills", 2, "skills/demo");
    let revision = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let receipt = registry
            .import(&path, Origin::Imported, &first, NOW)
            .unwrap();
        assert!(
            !registry
                .import(&path, Origin::Imported, &second, LATER)
                .unwrap()
                .created
        );
        assert!(
            !registry
                .import(&path, Origin::Imported, &first, LATER + 1)
                .unwrap()
                .created
        );
        let details = registry.details(&receipt.revision_id).unwrap();
        assert!(details.summary.marketplace_source);
        assert_eq!(details.sources_total, 2);
        assert_eq!(
            details
                .sources
                .iter()
                .map(|s| s.source_ref.as_str())
                .collect::<Vec<_>>(),
            [first.as_str(), second.as_str()]
        );
        assert_eq!(details.sources[0].recorded_at, crate::time::format_utc(NOW));
        receipt.revision_id
    };
    store.close().unwrap();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    assert_eq!(registry.details(&revision).unwrap().sources_total, 2);
    assert!(registry.summary(&revision).unwrap().marketplace_source);
    let other = dir.package(
        "two",
        &[("SKILL.md", &format!("{SKILL_MD}\nA revised instruction."))],
    );
    let third = source("example/skills", 3, "skills/demo");
    let next = registry
        .import(&other, Origin::Imported, &third, LATER + 2)
        .unwrap();
    assert_eq!(
        registry.details(&next.revision_id).unwrap().sources[0].source_ref,
        third
    );
    assert_eq!(registry.details(&revision).unwrap().sources_total, 2);
    assert!(
        registry
            .summary(&next.revision_id)
            .unwrap()
            .marketplace_source
    );
}

/// Append only controlled legacy fixtures, without changing the production import
/// namespace policy. Projection must validate the exact source record itself.
fn append_source(registry: &mut SkillRegistry<'_>, revision: &str, origin: &str, reference: &str) {
    let profile = registry.profile().as_str().to_owned();
    registry.conn().execute(
        "INSERT INTO skill_revision_sources(profile_id,revision_id,origin,source_ref,recorded_at)
         VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![profile, revision, origin, reference, crate::time::format_utc(NOW)],
    ).unwrap();
}

#[test]
fn marketplace_summary_uses_only_valid_exact_revision_sources() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let first = dir.package("first", &[("SKILL.md", SKILL_MD)]);
    let second = dir.package(
        "second",
        &[("SKILL.md", &format!("{SKILL_MD}\nAnother revision."))],
    );
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let a = registry
        .import(&first, Origin::Imported, "folder:demo", NOW)
        .unwrap();
    let b = registry
        .import(&second, Origin::Imported, "folder:demo", LATER)
        .unwrap();
    assert!(!registry.summary(&a.revision_id).unwrap().marketplace_source);
    append_source(
        &mut registry,
        &a.revision_id,
        "imported",
        &source("example/skills", 1, "demo"),
    );
    assert!(registry.summary(&a.revision_id).unwrap().marketplace_source);
    assert!(!registry.summary(&b.revision_id).unwrap().marketplace_source);
    let listed = registry.list(None, None, 10).unwrap();
    assert_eq!(
        listed.iter().filter(|row| row.marketplace_source).count(),
        1
    );
    assert!(
        registry
            .details(&a.revision_id)
            .unwrap()
            .summary
            .marketplace_source
    );
}

#[test]
fn marketplace_summary_rejects_unpinned_malformed_and_nonimported_labels() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let revision = registry
        .import(&path, Origin::Imported, "folder:demo", NOW)
        .unwrap()
        .revision_id;
    for reference in [
        "github:example/skills@main#demo".to_string(),
        format!("github:example/skills@{}#demo", "A".repeat(40)),
        source("example/skills", 1, "../demo"),
        source("example/skills", 1, "demo#extra"),
        format!("https://github.com/example/skills@{}#demo", "a".repeat(40)),
    ] {
        append_source(&mut registry, &revision, "imported", &reference);
    }
    append_source(
        &mut registry,
        &revision,
        "user",
        &source("example/skills", 2, "demo"),
    );
    append_source(
        &mut registry,
        &revision,
        "generated",
        &source("example/skills", 3, "demo"),
    );
    assert!(!registry.summary(&revision).unwrap().marketplace_source);
}

#[test]
fn marketplace_summary_does_not_use_foreign_profile_sources_or_origin_alone() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let revision = {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        registry
            .import(&path, Origin::Imported, "folder:demo", NOW)
            .unwrap()
            .revision_id
    };
    {
        let mut other = SkillRegistry::new(&mut store, &dir.data(), profile("other"));
        let receipt = other
            .import(
                &path,
                Origin::Imported,
                &source("example/skills", 1, "demo"),
                NOW,
            )
            .unwrap();
        assert_eq!(receipt.revision_id, revision);
        assert!(other.summary(&revision).unwrap().marketplace_source);
    }
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    assert!(!registry.summary(&revision).unwrap().marketplace_source);
    assert!(matches!(
        registry.import(
            &path,
            Origin::Imported,
            &source("example/skills", 1, "demo"),
            LATER
        ),
        Err(SkillError::Denied("market_package_source_conflict"))
    ));
    assert!(!registry.summary(&revision).unwrap().marketplace_source);
}

#[test]
fn local_project_and_generated_origins_do_not_claim_marketplace_provenance() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    for (scope, origin, reference) in [
        ("local", Origin::User, "folder:demo"),
        (
            "workspace",
            Origin::Workspace,
            "workspace:w_fixture/.extalia/skills/demo",
        ),
        ("generated", Origin::Generated, "prompt:session:source-hash"),
        ("imported", Origin::Imported, "legacy-unrecorded"),
    ] {
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile(scope));
        let receipt = registry.import(&path, origin, reference, NOW).unwrap();
        assert!(
            !registry
                .summary(&receipt.revision_id)
                .unwrap()
                .marketplace_source
        );
    }
}
#[test]
fn market_namespace_conflicts_refuse_even_identical_trees_and_do_not_record_sources() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let receipt = registry
        .import(
            &path,
            Origin::Imported,
            &source("example/skills", 1, "demo"),
            NOW,
        )
        .unwrap();
    for (origin, reference) in [
        (Origin::Imported, source("other/skills", 2, "demo")),
        (Origin::Imported, source("example/skills", 2, "Demo")),
        (Origin::User, "local-review".into()),
        (Origin::User, source("example/skills", 1, "demo")),
    ] {
        assert!(matches!(
            registry.import(&path, origin, &reference, LATER),
            Err(SkillError::Denied("market_package_source_conflict"))
        ));
    }
    assert_eq!(
        registry
            .details(&receipt.revision_id)
            .unwrap()
            .sources_total,
        1
    );
    let mut other = SkillRegistry::new(&mut store, &dir.data(), profile("other"));
    other
        .import(&path, Origin::User, "local-review", NOW)
        .unwrap();
    assert!(matches!(
        other.import(
            &path,
            Origin::Imported,
            &source("example/skills", 1, "demo"),
            LATER
        ),
        Err(SkillError::Denied("market_package_source_conflict"))
    ));
}
#[test]
fn market_invalid_source_never_registers_a_package() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    for reference in [
        "github:example/skills@main#demo".to_string(),
        source("example/skills", 1, "../demo"),
        source("example/skills", 1, "demo/CON"),
        source("example/skills", 1, "demo#extra"),
    ] {
        assert!(matches!(
            registry.import(&path, Origin::Imported, &reference, NOW),
            Err(SkillError::Denied("market_package_source_invalid"))
        ));
    }
    assert!(registry.list(None, None, 10).unwrap().is_empty());
}
#[test]
fn revision_source_bounds_are_explicit_and_duplicates_still_work_at_limit() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let first = registry
        .import(
            &path,
            Origin::Imported,
            &source("example/skills", 0, ""),
            NOW,
        )
        .unwrap();
    for commit in 1..256 {
        registry
            .import(
                &path,
                Origin::Imported,
                &source("example/skills", commit, ""),
                NOW + commit as i64,
            )
            .unwrap();
    }
    let details = registry.details(&first.revision_id).unwrap();
    assert_eq!(details.sources_total, 256);
    assert_eq!(details.sources.len(), 20);
    assert_eq!(
        details.sources[0].source_ref,
        source("example/skills", 236, "")
    );
    assert!(matches!(
        registry.import(
            &path,
            Origin::Imported,
            &source("example/skills", 256, ""),
            LATER
        ),
        Err(SkillError::Denied("revision_source_limit"))
    ));
    assert!(
        !registry
            .import(
                &path,
                Origin::Imported,
                &source("example/skills", 0, ""),
                LATER
            )
            .unwrap()
            .created
    );
    assert_eq!(
        registry.details(&first.revision_id).unwrap().sources_total,
        256
    );
}
#[test]
fn revision_source_history_is_append_only_and_unknown_source_is_not_fabricated() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let path = dir.package("one", &[("SKILL.md", SKILL_MD)]);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let imported = registry.import(&path, Origin::User, "", NOW).unwrap();
    assert_eq!(
        registry
            .details(&imported.revision_id)
            .unwrap()
            .sources_total,
        0
    );
    registry
        .import(&path, Origin::User, "local-review", LATER)
        .unwrap();
    assert!(
        registry
            .conn()
            .execute("UPDATE skill_revision_sources SET source_ref='changed'", [])
            .is_err()
    );
    assert!(
        registry
            .conn()
            .execute("DELETE FROM skill_revision_sources", [])
            .is_err()
    );
    assert!(registry.conn().execute("INSERT OR REPLACE INTO skill_revision_sources SELECT source_seq,profile_id,revision_id,origin,'replacement',recorded_at FROM skill_revision_sources",[]).is_err());
    assert!(registry.conn().execute("INSERT OR REPLACE INTO skill_revision_sources(profile_id,revision_id,origin,source_ref,recorded_at) SELECT profile_id,revision_id,origin,source_ref,'replacement' FROM skill_revision_sources",[]).is_err());
    let mut other = SkillRegistry::new(&mut store, &dir.data(), profile("other"));
    assert!(matches!(
        other.details(&imported.revision_id),
        Err(SkillError::NotFound)
    ));
}
