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
