//! Skill registry tests. Every test works in its own temporary directory only.

mod preflight;
mod routing;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use super::inspect::{Coverage, Failure, InspectionRequest, Severity};
use super::manifest::{self, Capability, Permissions, RiskClass};
use super::policy::{EvaluationResult, POLICY_VERSION, Route};
use super::registry::{ApprovalRequest, PolicyContext, ProfileGrants};
use super::tree::{self, ObjectStore, StagingLimits, Tree, TreeFile};
use super::views::MAX_LIST_LIMIT;
use super::*;
use crate::adapters::sqlite::{CoreStore, store_path};
use crate::sha256::hex_digest;

const NOW: i64 = 1_800_000_000_000;
const LATER: i64 = NOW + 600_000;
const SKILL_MD: &str = "---\nname: demo\ndescription: Demo skill\n---\nDo the thing.\n";

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-skills-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return Self(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }

    fn data(&self) -> PathBuf {
        self.0.join("data")
    }

    fn package(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = self.0.join("sources").join(name);
        fs::create_dir_all(&root).unwrap();
        for (path, text) in files {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }
        root
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        make_writable(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// Undo the object store's read-only modes so the directory can be removed.
fn make_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    #[cfg(unix)]
    {
        if meta.is_dir() {
            chmod(path, 0o700);
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    make_writable(&entry.path());
                }
            }
        } else if meta.is_file() {
            chmod(path, 0o600);
        }
    }
    #[cfg(not(unix))]
    {
        let mut permissions = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        let _ = fs::set_permissions(path, permissions);
        if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    make_writable(&entry.path());
                }
            }
        }
    }
}

/// Overwrite a stored object file (simulates tampering with the quarantine store).
fn tamper(path: &Path, bytes: &[u8]) {
    make_writable(path.parent().unwrap());
    fs::write(path, bytes).unwrap();
}

fn manifest_json(version: &str, extra: &str) -> String {
    format!(
        r#"{{"schema":"extalia.skill-manifest.v1","id":"demo","version":"{version}","risk_class":"declarative"{extra}}}"#
    )
}

fn profile(id: &str) -> ProfileId {
    ProfileId::parse(id).unwrap()
}

fn refusal(result: Result<impl std::fmt::Debug, SkillError>) -> Refusal {
    match result {
        Err(SkillError::Refused { refusal, .. }) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn pinned() -> ScannerIdentity {
    ScannerIdentity {
        id: "fake-scanner".into(),
        pin: Some("0123abcd+sha256:feed".into()),
        version: Some("1.0.0".into()),
        normalizer_version: Some("1".into()),
    }
}

struct FakeInspector {
    identity: ScannerIdentity,
    outcome: InspectionOutcome,
    tamper: bool,
}

impl FakeInspector {
    fn clean() -> Self {
        Self::with(Severity::None)
    }

    fn with(verdict: Severity) -> Self {
        Self {
            identity: pinned(),
            outcome: InspectionOutcome::Completed {
                verdict,
                coverage: Coverage::Complete,
                report_ref: Some("report:redacted".into()),
            },
            tamper: false,
        }
    }
}

impl SkillInspector for FakeInspector {
    fn identity(&self) -> ScannerIdentity {
        self.identity.clone()
    }

    fn inspect(&self, request: &InspectionRequest<'_>) -> InspectionOutcome {
        if self.tamper {
            tamper(
                &request.object_dir.join("SKILL.md"),
                b"tampered during the scan",
            );
        }
        self.outcome.clone()
    }
}

fn open(dir: &TempDir) -> CoreStore {
    CoreStore::open(&store_path(&dir.data())).unwrap()
}

/// Import, inspect, validate, evaluate, decide and approve one package as the user.
fn approve(
    registry: &mut SkillRegistry<'_>,
    source: &Path,
    inspector: &FakeInspector,
) -> (String, i64) {
    let receipt = registry.import(source, Origin::User, "test", NOW).unwrap();
    let id = receipt.revision_id;
    let ctx = PolicyContext::current(inspector);
    let inspected = registry
        .inspect(&id, inspector, POLICY_VERSION, NOW)
        .unwrap();
    assert_eq!(inspected.state, RevisionState::Inspected);
    registry.validate(&id, &ctx, NOW).unwrap();
    registry
        .record_evaluation(&id, EvaluationResult::Passed, None, Some("evidence:1"), NOW)
        .unwrap();
    let route = registry
        .decide(&id, &ctx, &ProfileGrants::default(), NOW)
        .unwrap();
    assert!(matches!(route, Route::AwaitingApproval(_)));
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
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Approved
    );
    (id, approval)
}

fn count(store: &mut CoreStore, sql: &str) -> i64 {
    store
        .connection()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

// ---- staging and quarantine ----

#[cfg(unix)]
#[test]
fn refuses_symlinks_hard_links_and_special_files() {
    let dir = TempDir::new();
    let store = ObjectStore::new(&dir.data(), &profile("default"));
    let limits = StagingLimits::default();

    let source = dir.package("link", &[("SKILL.md", SKILL_MD)]);
    std::os::unix::fs::symlink("/etc/hosts", source.join("hosts.md")).unwrap();
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::Symlink);

    let source = dir.package("dirlink", &[("SKILL.md", SKILL_MD)]);
    std::os::unix::fs::symlink(&dir.0, source.join("up")).unwrap();
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::Symlink);

    // The package root itself may not be a link.
    let real = dir.package("real", &[("SKILL.md", SKILL_MD)]);
    let alias = dir.0.join("sources").join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    assert_eq!(
        refusal(store.stage(&alias, &limits)),
        Refusal::NotADirectory
    );

    let source = dir.package("hard", &[("SKILL.md", SKILL_MD)]);
    fs::hard_link(source.join("SKILL.md"), dir.0.join("outside.md")).unwrap();
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::HardLink);

    // A socket is a special file. Socket paths are short-limited, so use a short root.
    let short = PathBuf::from(format!("/tmp/exsk-{}", std::process::id()));
    let _ = fs::remove_dir_all(&short);
    fs::create_dir_all(&short).unwrap();
    fs::write(short.join("SKILL.md"), SKILL_MD).unwrap();
    let _socket = std::os::unix::net::UnixListener::bind(short.join("sock")).unwrap();
    let result = store.stage(&short, &limits);
    fs::remove_dir_all(&short).unwrap();
    assert_eq!(refusal(result), Refusal::SpecialFile);

    // Nothing was left in staging or objects.
    let skills = dir.data().join("profiles/default/skills");
    assert_eq!(fs::read_dir(skills.join("staging")).unwrap().count(), 0);
    assert_eq!(fs::read_dir(skills.join("objects")).unwrap().count(), 0);
}

#[test]
fn refuses_traversal_hidden_and_non_portable_names() {
    for bad in [
        "../SKILL.md",
        "a/../b.md",
        "./a.md",
        "/etc/passwd",
        "a//b.md",
        "a/",
        "a\\b.md",
        "C:x.md",
        "con.md",
        "a b.md",
        "-rf",
        "trailing.",
        "",
    ] {
        assert!(tree::check_relative_path(bad).is_err(), "{bad:?}");
    }
    assert_eq!(tree::check_segment(".git"), Err(Refusal::HiddenEntry));
    assert_eq!(tree::check_segment(".."), Err(Refusal::InvalidName));
    for good in ["SKILL.md", "scripts/run.sh", "docs/v1.2_notes-x.md"] {
        assert_eq!(tree::check_relative_path(good), Ok(()), "{good}");
    }
    assert_eq!(
        tree::find_case_collision(["docs/A.md", "SKILL.md", "docs/a.md"]),
        Some("docs/a.md".into())
    );

    let dir = TempDir::new();
    let store = ObjectStore::new(&dir.data(), &profile("default"));
    let limits = StagingLimits::default();
    let source = dir.package("hidden", &[("SKILL.md", SKILL_MD), (".env", "SECRET=1")]);
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::HiddenEntry);
    let source = dir.package("space", &[("SKILL.md", SKILL_MD), ("my notes.md", "x")]);
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::InvalidName);
    // Reads from the object store never leave it.
    let source = dir.package("ok", &[("SKILL.md", SKILL_MD)]);
    let staged = store.stage(&source, &limits).unwrap();
    let entry = staged.file("SKILL.md").unwrap().clone();
    let escape = TreeFile {
        path: "../SKILL.md".into(),
        ..entry
    };
    assert!(matches!(
        store.read_file(&staged.sha256, "../SKILL.md", &escape),
        Err(SkillError::Denied("invalid_path"))
    ));
}

#[test]
fn enforces_caps_and_package_shape() {
    let dir = TempDir::new();
    let store = ObjectStore::new(&dir.data(), &profile("default"));
    let limits = StagingLimits {
        max_file_bytes: 100,
        max_total_bytes: 150,
        max_entries: 4,
        max_depth: 2,
    };
    let big = "x".repeat(101);
    let source = dir.package("big", &[("SKILL.md", SKILL_MD), ("big.md", &big)]);
    assert_eq!(
        refusal(store.stage(&source, &limits)),
        Refusal::FileTooLarge
    );
    let half = "x".repeat(95);
    let source = dir.package("total", &[("SKILL.md", SKILL_MD), ("a.md", &half)]);
    assert_eq!(
        refusal(store.stage(&source, &limits)),
        Refusal::PackageTooLarge
    );
    let source = dir.package(
        "many",
        &[
            ("SKILL.md", "s"),
            ("a.md", "a"),
            ("b.md", "b"),
            ("c.md", "c"),
            ("d.md", "d"),
        ],
    );
    assert_eq!(
        refusal(store.stage(&source, &limits)),
        Refusal::TooManyEntries
    );
    let source = dir.package("deep", &[("SKILL.md", "s"), ("a/b/c.md", "c")]);
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::TooDeep);
    let source = dir.package("nofile", &[]);
    fs::create_dir_all(source.join("empty")).unwrap();
    assert_eq!(refusal(store.stage(&source, &limits)), Refusal::Empty);
    let source = dir.package("noskill", &[("README.md", "r")]);
    assert_eq!(
        refusal(store.stage(&source, &limits)),
        Refusal::MissingSkillMd
    );
    let file = dir.0.join("sources").join("noskill").join("README.md");
    assert_eq!(refusal(store.stage(&file, &limits)), Refusal::NotADirectory);
    assert_eq!(
        refusal(store.stage(&dir.0.join("missing"), &limits)),
        Refusal::NotADirectory
    );
    // The skill store (or a folder containing it) is never a source.
    assert_eq!(
        refusal(store.stage(&dir.data(), &limits)),
        Refusal::InsideStore
    );
    // Within the caps, a nested package is accepted.
    let source = dir.package("fits", &[("SKILL.md", "s"), ("a/b.md", "b")]);
    assert_eq!(store.stage(&source, &limits).unwrap().files.len(), 2);
}

#[test]
fn tree_hash_is_deterministic_and_follows_the_definition() {
    let dir = TempDir::new();
    let store = ObjectStore::new(&dir.data(), &profile("default"));
    let limits = StagingLimits::default();
    let first = dir.package(
        "first",
        &[("SKILL.md", SKILL_MD), ("docs/b.md", "b"), ("a.md", "a")],
    );
    // Same content, created in another order and at another time.
    let second = dir.package("second", &[("a.md", "a"), ("docs/b.md", "b")]);
    fs::write(second.join("SKILL.md"), SKILL_MD).unwrap();
    fs::create_dir(second.join("empty-dir")).unwrap();
    let a = store.stage(&first, &limits).unwrap();
    let b = store.stage(&second, &limits).unwrap();
    assert_eq!(
        a.sha256, b.sha256,
        "independent of creation order and empty directories"
    );
    assert_eq!(a.files, b.files);

    let line = |path: &str, mode: &str, text: &str| {
        format!(
            "{path}\0{mode}\0{}\0{}\n",
            text.len(),
            hex_digest(text.as_bytes())
        )
    };
    let canonical = format!(
        "extalia.skill-tree.v1\n{}{}{}",
        line("SKILL.md", "100644", SKILL_MD),
        line("a.md", "100644", "a"),
        line("docs/b.md", "100644", "b"),
    );
    assert_eq!(a.sha256, hex_digest(canonical.as_bytes()));
    assert_eq!(
        a.files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["SKILL.md", "a.md", "docs/b.md"],
        "sorted by path bytes (uppercase first)"
    );

    let changed = dir.package(
        "changed",
        &[("SKILL.md", SKILL_MD), ("docs/b.md", "B"), ("a.md", "a")],
    );
    assert_ne!(store.stage(&changed, &limits).unwrap().sha256, a.sha256);
    let renamed = dir.package(
        "renamed",
        &[("SKILL.md", SKILL_MD), ("docs/c.md", "b"), ("a.md", "a")],
    );
    assert_ne!(store.stage(&renamed, &limits).unwrap().sha256, a.sha256);

    #[cfg(unix)]
    {
        let exec = dir.package(
            "exec",
            &[("SKILL.md", SKILL_MD), ("docs/b.md", "b"), ("a.md", "a")],
        );
        chmod(&exec.join("a.md"), 0o755);
        let hashed = store.stage(&exec, &limits).unwrap();
        assert_ne!(
            hashed.sha256, a.sha256,
            "the executable bit is part of the hash"
        );
        assert!(hashed.file("a.md").unwrap().executable);
        let canonical = format!(
            "extalia.skill-tree.v1\n{}{}{}",
            line("SKILL.md", "100644", SKILL_MD),
            line("a.md", "100755", "a"),
            line("docs/b.md", "100644", "b"),
        );
        assert_eq!(hashed.sha256, hex_digest(canonical.as_bytes()));
    }
    // A Tree built from the same files in any order has the same hash.
    let mut reversed = a.files.clone();
    reversed.reverse();
    assert_eq!(Tree::from_files(reversed).sha256, a.sha256);
}

#[cfg(unix)]
#[test]
fn objects_are_read_only_private_and_content_addressed() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD), ("run/go.sh", "echo hi")]);
    chmod(&source.join("run/go.sh"), 0o755);
    fs::write(
        source.join(manifest::MANIFEST_FILE),
        r#"{"schema":"extalia.skill-manifest.v1","id":"demo","version":"1.0.0","risk_class":"executable"}"#,
    )
    .unwrap();
    let first = registry.import(&source, Origin::User, "test", NOW).unwrap();
    assert!(first.created);
    assert_eq!(first.revision_id, format!("skr_{}", first.tree_sha256));
    let object = registry.object_store().object_dir(&first.tree_sha256);
    assert_eq!(mode(&object), 0o500);
    assert_eq!(mode(&object.join("run")), 0o500);
    assert_eq!(mode(&object.join("SKILL.md")), 0o400);
    assert_eq!(mode(&object.join("run/go.sh")), 0o500);
    assert_eq!(mode(&dir.data().join("profiles/default/skills")), 0o700);
    // The same bytes name the same revision; the source is never read again.
    let again = registry.import(&source, Origin::User, "test", NOW).unwrap();
    assert!(!again.created);
    assert_eq!(again.revision_id, first.revision_id);
    fs::write(source.join("SKILL.md"), "changed after import").unwrap();
    let stored = registry.revision(&first.revision_id).unwrap();
    assert_eq!(stored.risk_class, RiskClass::Executable);
    assert_eq!(stored.skill_md_sha256, hex_digest(SKILL_MD.as_bytes()));
}

// ---- manifest ----

#[test]
fn manifest_is_strict() {
    let ok = manifest::parse_manifest(
        br#"{"schema":"extalia.skill-manifest.v1","id":"laravel-query","version":"1.2.0-rc.1+build.5",
            "categories":["development.backend.laravel","development.database.mysql"],
            "intents":["optimize_query","fix_n_plus_one"],
            "compatibility":{"php":">=8.2","laravel":">=11 <13 || ^10.4"},
            "dependencies":[{"id":"sql-basics","range":"^1.0.0"}],
            "conflicts":[{"id":"old-laravel"}],
            "permissions":{"filesystem_read":["src/**","workspace/**"],"filesystem_write":[],
              "network":["api.example.com","*.example.org"],"terminal":true,"secrets":["db-readonly"]},
            "risk_class":"tool_using"}"#,
    )
    .unwrap();
    assert_eq!(ok.risk_class, RiskClass::ToolUsing);
    assert_eq!(ok.permissions.entries().len(), 6);
    assert!(
        ok.permissions
            .entries()
            .contains(&(Capability::Terminal, "*".into()))
    );
    assert_eq!(ok.conflicts.get("old-laravel"), Some(&None));
    // Round trip through the stored form keeps the permission digest.
    let stored = Permissions::from_entries(ok.permissions.entries());
    assert_eq!(stored.digest(), ok.permissions.digest());

    let base = r#""schema":"extalia.skill-manifest.v1","id":"demo","version":"1.0.0","risk_class":"declarative""#;
    let bad = [
        (
            format!("{{{base},\"extra\":1}}"),
            "manifest.extra: unknown field.",
        ),
        (
            format!("{{{base},\"permissions\":{{\"shell\":true}}}}"),
            "manifest.permissions.shell: unknown field.",
        ),
        (
            format!("{{{base},\"permissions\":{{\"network\":true}}}}"),
            "manifest.permissions.network: expected false or a host list.",
        ),
        (
            format!("{{{base},\"permissions\":{{\"filesystem_read\":[\"/etc/**\"]}}}}"),
            "manifest.permissions.filesystem_read: invalid entry.",
        ),
        (
            format!("{{{base},\"permissions\":{{\"filesystem_write\":[\"../x\"]}}}}"),
            "manifest.permissions.filesystem_write: invalid entry.",
        ),
        (
            format!("{{{base},\"permissions\":{{\"network\":[\"https://x.com\"]}}}}"),
            "manifest.permissions.network: invalid entry.",
        ),
        (
            format!("{{{base},\"categories\":[\"a.b\",\"a.b\"]}}"),
            "manifest.categories: duplicate entry.",
        ),
        (
            format!("{{{base},\"categories\":[\"Bad Category\"]}}"),
            "manifest.categories: invalid entry.",
        ),
        (
            format!("{{{base},\"intents\":[\"Optimize\"]}}"),
            "manifest.intents: invalid entry.",
        ),
        (
            format!("{{{base},\"dependencies\":[{{\"id\":\"x\"}}]}}"),
            "manifest.dependencies: invalid entry (id and SemVer range).",
        ),
        (
            format!("{{{base},\"dependencies\":[{{\"id\":\"demo\",\"range\":\"1\"}}]}}"),
            "manifest.dependencies: a package cannot name itself.",
        ),
        (
            format!("{{{base},\"conflicts\":[{{\"id\":\"x\",\"why\":\"\"}}]}}"),
            "manifest.conflicts.why: unknown field.",
        ),
        (
            format!("{{{base},\"compatibility\":{{\"php\":\"latest\"}}}}"),
            "manifest.compatibility: invalid entry (fact id and SemVer range).",
        ),
    ];
    for (json, expected) in &bad {
        let issues = manifest::parse_manifest(json.as_bytes()).unwrap_err();
        assert!(
            issues.iter().any(|issue| issue == expected),
            "{json}: {issues:?}"
        );
    }
    for version in ["1.0", "01.0.0", "1.0.0-", "1.0.0-01", "v1.0.0", "1.0.0+"] {
        assert!(!manifest::is_semver(version), "{version}");
    }
    for version in [
        "0.0.0",
        "1.2.3-alpha.1",
        "1.2.3+20261022.sha",
        "10.20.30-rc.1+b",
    ] {
        assert!(manifest::is_semver(version), "{version}");
    }
    let wrong_schema = br#"{"schema":"extalia.skill-manifest.v2","id":"demo","version":"1.0.0","risk_class":"declarative"}"#;
    assert!(manifest::parse_manifest(wrong_schema).is_err());
    assert!(manifest::parse_manifest(b"[]").is_err());
    assert!(manifest::parse_manifest(b"{").is_err());
    assert!(manifest::parse_manifest(&vec![b' '; manifest::MAX_MANIFEST_BYTES + 1]).is_err());
}

#[test]
fn manifest_cross_checks_skill_md_and_the_tree() {
    let file = |path: &str, executable: bool| TreeFile {
        path: path.into(),
        size: 1,
        sha256: "0".repeat(64),
        executable,
    };
    let markdown = Tree::from_files(vec![
        file("SKILL.md", false),
        file(manifest::MANIFEST_FILE, false),
    ]);
    let manifest = manifest_json("1.0.0", "");
    let resolved =
        manifest::resolve(&markdown, Some(manifest.as_bytes()), SKILL_MD.as_bytes()).unwrap();
    assert!(!resolved.inferred);
    assert_eq!(resolved.front_matter.description, "Demo skill");

    let issues = |tree: &Tree, manifest: Option<&str>, skill: &str| match manifest::resolve(
        tree,
        manifest.map(str::as_bytes),
        skill.as_bytes(),
    ) {
        Err(SkillError::Manifest(issues)) => issues,
        other => panic!("expected manifest issues, got {other:?}"),
    };
    let other_name = SKILL_MD.replace("name: demo", "name: other");
    assert!(
        issues(&markdown, Some(&manifest), &other_name)
            .contains(&"manifest.id: must equal the SKILL.md front matter name.".into())
    );
    let no_description = SKILL_MD.replace("description: Demo skill", "description:");
    assert_eq!(
        issues(&markdown, Some(&manifest), &no_description),
        ["SKILL.md: description is missing."]
    );
    assert_eq!(
        issues(&markdown, None, "no front matter"),
        ["SKILL.md: missing front matter."]
    );
    assert_eq!(
        issues(&markdown, None, "---\nname: demo\ndescription: d\n---\n"),
        ["SKILL.md: no instructions after the front matter."]
    );
    let with_script = Tree::from_files(vec![file("SKILL.md", false), file("run.py", false)]);
    assert!(
        issues(&with_script, Some(&manifest), SKILL_MD)
            .contains(&"manifest.risk_class: declarative requires a Markdown-only package.".into())
    );
    let executable_md = Tree::from_files(vec![file("SKILL.md", false), file("x.md", true)]);
    assert!(issues(&executable_md, Some(&manifest), SKILL_MD).contains(
        &"manifest.risk_class: a file with an executable bit requires executable.".into()
    ));

    // Inferred manifests.
    let inferred = manifest::resolve(&markdown, None, SKILL_MD.as_bytes()).unwrap();
    assert!(inferred.inferred);
    assert_eq!(inferred.manifest.id, "demo");
    assert_eq!(inferred.manifest.risk_class, RiskClass::Declarative);
    assert_eq!(
        inferred.manifest.version,
        format!("0.0.0+tree.{}", &markdown.sha256[..16])
    );
    assert!(manifest::is_semver(&inferred.manifest.version));
    assert!(inferred.manifest.permissions.is_empty());
    let inferred = manifest::resolve(&with_script, None, SKILL_MD.as_bytes()).unwrap();
    assert_eq!(inferred.manifest.risk_class, RiskClass::Executable);
    // CRLF and a byte-order mark are accepted like the W0 loader.
    let crlf = format!("\u{feff}{}", SKILL_MD.replace('\n', "\r\n"));
    assert!(manifest::parse_front_matter(crlf.as_bytes()).is_ok());
}

// ---- inspection, policy and lifecycle on the store ----

#[test]
fn scanner_unavailable_keeps_every_package_quarantined() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = UnavailableInspector;
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let receipt = registry
        .import(&source, Origin::Workspace, "workspace:demo", NOW)
        .unwrap();
    assert_eq!(receipt.state, RevisionState::Quarantined);
    let id = receipt.revision_id;
    for _ in 0..2 {
        let inspected = registry
            .inspect(&id, &inspector, POLICY_VERSION, NOW)
            .unwrap();
        assert_eq!(inspected.outcome, "scanner-unavailable");
        assert_eq!(inspected.state, RevisionState::Quarantined);
        assert_eq!(
            inspected.state_reason.as_deref(),
            Some("scanner-unavailable")
        );
    }
    assert!(matches!(
        registry.validate(&id, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Quarantined))
    ));
    assert!(matches!(
        registry.decide(
            &id,
            &ctx,
            &ProfileGrants {
                auto_activation: true,
                ..ProfileGrants::default()
            },
            NOW
        ),
        Err(SkillError::WrongState(RevisionState::Quarantined))
    ));
    let revision = registry.revision(&id).unwrap();
    let request = ApprovalRequest {
        revision_id: &id,
        shown_tree_sha256: &revision.tree_sha256,
        shown_permission_digest: &revision.permission_digest,
        workspace_id: None,
        approver: "user:owner",
        expires_at_ms: LATER,
    };
    assert!(matches!(
        registry.approve(&request, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Quarantined))
    ));
    assert!(matches!(
        registry.activate(&id, 1, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Quarantined))
    ));
    assert!(matches!(
        registry.read_active_file("demo", "SKILL.md", &ctx, NOW),
        Err(SkillError::NotFound)
    ));
    assert!(registry.invalidate_stale(&ctx, NOW).unwrap().is_empty());
    drop(registry);
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_inspections WHERE outcome = 'scanner-unavailable' AND verdict IS NULL AND scanner_pin IS NULL"
        ),
        2
    );
    assert_eq!(count(&mut store, "SELECT count(*) FROM skill_approvals"), 0);
    assert_eq!(
        count(&mut store, "SELECT count(*) FROM skill_activations"),
        0
    );
    // discovered, quarantined, then (inspecting, quarantined) twice.
    assert_eq!(
        count(&mut store, "SELECT count(*) FROM skill_revision_events"),
        6
    );
}

#[test]
fn findings_map_to_review_and_block() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let cases = [
        (
            FakeInspector::with(Severity::Medium),
            RevisionState::ReviewRequired,
            Some("finding-medium"),
        ),
        (
            FakeInspector::with(Severity::High),
            RevisionState::Blocked,
            Some("finding-high"),
        ),
        (
            FakeInspector::with(Severity::Critical),
            RevisionState::Blocked,
            Some("finding-critical"),
        ),
        (
            FakeInspector::with(Severity::Low),
            RevisionState::Inspected,
            Some("finding-low"),
        ),
        (
            FakeInspector {
                outcome: InspectionOutcome::Completed {
                    verdict: Severity::None,
                    coverage: Coverage::Partial,
                    report_ref: None,
                },
                ..FakeInspector::clean()
            },
            RevisionState::Quarantined,
            Some("incomplete"),
        ),
        (
            FakeInspector {
                outcome: InspectionOutcome::Failed(Failure::Timeout),
                ..FakeInspector::clean()
            },
            RevisionState::Quarantined,
            Some("timeout"),
        ),
        // A scanner without a verified pin is not run: a clean report cannot attest.
        (
            FakeInspector {
                identity: ScannerIdentity {
                    pin: None,
                    ..pinned()
                },
                ..FakeInspector::clean()
            },
            RevisionState::Quarantined,
            Some("scanner-unavailable"),
        ),
    ];
    for (index, (inspector, state, reason)) in cases.iter().enumerate() {
        let body = format!("{SKILL_MD}case {index}\n");
        let source = dir.package(&format!("case{index}"), &[("SKILL.md", &body)]);
        let id = registry
            .import(&source, Origin::User, "test", NOW)
            .unwrap()
            .revision_id;
        let receipt = registry
            .inspect(&id, inspector, POLICY_VERSION, NOW)
            .unwrap();
        assert_eq!(
            (receipt.state, receipt.state_reason.as_deref()),
            (*state, *reason),
            "case {index}"
        );
        let ctx = PolicyContext::current(inspector);
        if *state == RevisionState::ReviewRequired {
            assert!(matches!(
                registry.validate(&id, &ctx, NOW),
                Err(SkillError::WrongState(RevisionState::ReviewRequired))
            ));
        }
    }
}

#[test]
fn full_flow_activates_and_reads_verified_files() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package(
        "demo",
        &[("SKILL.md", SKILL_MD), ("docs/guide.md", "guide")],
    );
    let (id, approval) = approve(&mut registry, &source, &inspector);
    assert_eq!(registry.index_generation().unwrap(), 0);
    let activation = registry.activate(&id, approval, &ctx, NOW).unwrap();
    assert_eq!(activation.package_id, "demo");
    assert_eq!(registry.active("demo").unwrap(), Some(activation));
    assert_eq!(registry.revision(&id).unwrap().state, RevisionState::Active);
    assert_eq!(registry.index_generation().unwrap(), 1);
    assert_eq!(
        registry
            .read_active_file("demo", "SKILL.md", &ctx, NOW)
            .unwrap(),
        SKILL_MD.as_bytes()
    );
    assert_eq!(
        registry
            .read_active_file("demo", "docs/guide.md", &ctx, NOW)
            .unwrap(),
        b"guide"
    );
    assert!(matches!(
        registry.read_active_file("demo", "../SKILL.md", &ctx, NOW),
        Err(SkillError::NotFound)
    ));
    // Activating an active revision again is refused by the lifecycle.
    assert!(matches!(
        registry.activate(&id, approval, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Active))
    ));
    drop(registry);
    // Only the core writes approvals; their binding columns are immutable.
    assert!(
        store
            .connection()
            .execute(
                "UPDATE skill_approvals SET tree_sha256 = ?1",
                [&"f".repeat(64)]
            )
            .is_err()
    );
    assert!(
        store
            .connection()
            .execute("DELETE FROM skill_approvals", [])
            .is_err()
    );
    assert!(
        store
            .connection()
            .execute("UPDATE skill_revisions SET manifest_json = '{}'", [])
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn mutated_bytes_after_import_refuse_activation() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let (id, approval) = approve(&mut registry, &source, &inspector);
    let revision = registry.revision(&id).unwrap();
    let object = registry.object_store().object_dir(&revision.tree_sha256);
    tamper(
        &object.join("SKILL.md"),
        b"---\nname: demo\ndescription: evil\n---\nrm -rf\n",
    );
    assert!(matches!(
        registry.activate(&id, approval, &ctx, NOW),
        Err(SkillError::Integrity)
    ));
    let revoked = registry.revision(&id).unwrap();
    assert_eq!(revoked.state, RevisionState::Revoked);
    assert_eq!(revoked.state_reason.as_deref(), Some("integrity"));
    assert_eq!(registry.active("demo").unwrap(), None);
    // Terminal: nothing brings it back.
    assert!(matches!(
        registry.activate(&id, approval, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Revoked))
    ));
    drop(registry);
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_approvals WHERE status = 'revoked'"
        ),
        1
    );

    // Tampering after activation is caught when the file is loaded (hash point g).
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD), ("notes.md", "n")]);
    let (id, approval) = approve(&mut registry, &source, &inspector);
    registry.activate(&id, approval, &ctx, NOW).unwrap();
    let tree_sha256 = registry.revision(&id).unwrap().tree_sha256;
    let object = registry.object_store().object_dir(&tree_sha256);
    tamper(&object.join("notes.md"), b"N");
    assert!(matches!(
        registry.read_active_file("demo", "notes.md", &ctx, NOW),
        Err(SkillError::Integrity)
    ));
    assert_eq!(registry.active("demo").unwrap(), None);
    let history = registry.history("demo").unwrap();
    assert_eq!(history.last().unwrap().action, "revoke");
    assert_eq!(history.last().unwrap().reason.as_deref(), Some("integrity"));
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Revoked
    );
}

#[cfg(unix)]
#[test]
fn bytes_changed_during_the_scan_revoke_the_revision() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let id = registry
        .import(&source, Origin::User, "test", NOW)
        .unwrap()
        .revision_id;
    let inspector = FakeInspector {
        tamper: true,
        ..FakeInspector::clean()
    };
    assert!(matches!(
        registry.inspect(&id, &inspector, POLICY_VERSION, NOW),
        Err(SkillError::Integrity)
    ));
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Revoked
    );
    drop(registry);
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_inspections WHERE outcome = 'integrity'"
        ),
        1
    );
}

#[test]
fn approvals_are_bound_to_one_revision_hash() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let manifest = |version: &str| manifest_json(version, "");
    let v1 = dir.package(
        "v1",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest("1.0.0")),
        ],
    );
    let v2 = dir.package(
        "v2",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest("1.1.0")),
        ],
    );
    let (first, first_approval) = approve(&mut registry, &v1, &inspector);
    let receipt = registry.import(&v2, Origin::User, "test", NOW).unwrap();
    let second = receipt.revision_id.clone();
    registry
        .inspect(&second, &inspector, POLICY_VERSION, NOW)
        .unwrap();
    registry.validate(&second, &ctx, NOW).unwrap();
    registry
        .record_evaluation(&second, EvaluationResult::Passed, Some(&first), None, NOW)
        .unwrap();
    registry
        .decide(&second, &ctx, &ProfileGrants::default(), NOW)
        .unwrap();
    let revision = registry.revision(&second).unwrap();
    // The UI must show this revision's digests; only a user approves.
    let mut approval = ApprovalRequest {
        revision_id: &second,
        shown_tree_sha256: &receipt.tree_sha256,
        shown_permission_digest: &revision.permission_digest,
        workspace_id: None,
        approver: "user:owner",
        expires_at_ms: LATER,
    };
    let other_hash = registry.revision(&first).unwrap().tree_sha256;
    for (patched, reason) in [
        (
            ApprovalRequest {
                shown_tree_sha256: &other_hash,
                ..approval
            },
            "digest_mismatch",
        ),
        (
            ApprovalRequest {
                shown_permission_digest: "0",
                ..approval
            },
            "permission_digest_mismatch",
        ),
        (
            ApprovalRequest {
                approver: "policy:auto",
                ..approval
            },
            "approver_invalid",
        ),
        (
            ApprovalRequest {
                approver: "user:",
                ..approval
            },
            "approver_invalid",
        ),
        (
            ApprovalRequest {
                expires_at_ms: NOW,
                ..approval
            },
            "approval_expired",
        ),
        (
            ApprovalRequest {
                workspace_id: Some("w"),
                ..approval
            },
            "workspace_invalid",
        ),
    ] {
        match registry.approve(&patched, &ctx, NOW) {
            Err(SkillError::Denied(found)) => assert_eq!(found, reason),
            other => panic!("expected {reason}, got {other:?}"),
        }
    }
    // Activating the second revision with the first revision's approval is refused.
    approval.workspace_id = Some("00000000-0000-4000-8000-000000000001");
    let second_approval = registry.approve(&approval, &ctx, NOW).unwrap();
    assert!(matches!(
        registry.activate(&second, first_approval, &ctx, NOW),
        Err(SkillError::Denied("approval_mismatch"))
    ));
    assert!(matches!(
        registry.activate(&first, second_approval, &ctx, NOW),
        Err(SkillError::Denied("approval_mismatch"))
    ));
    assert!(matches!(
        registry.activate(&second, 9_999, &ctx, NOW),
        Err(SkillError::NotFound)
    ));
    // Expired by the time of activation.
    assert!(matches!(
        registry.activate(&second, second_approval, &ctx, LATER),
        Err(SkillError::Denied("approval_expired"))
    ));
    registry
        .activate(&second, second_approval, &ctx, NOW)
        .unwrap();
    assert_eq!(
        registry.revision(&first).unwrap().state,
        RevisionState::Approved
    );
}

#[test]
fn profiles_are_isolated() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let (work_id, work_approval) = {
        let mut work = SkillRegistry::new(&mut store, &dir.data(), profile("work"));
        approve(&mut work, &source, &inspector)
    };
    let mut personal = SkillRegistry::new(&mut store, &dir.data(), profile("personal"));
    // Same bytes, same revision id, but a separate row, object and lifecycle.
    let receipt = personal.import(&source, Origin::User, "test", NOW).unwrap();
    assert!(receipt.created);
    assert_eq!(receipt.revision_id, work_id);
    assert_eq!(receipt.state, RevisionState::Quarantined);
    for name in ["work", "personal"] {
        assert!(
            dir.data()
                .join("profiles")
                .join(name)
                .join("skills/objects")
                .join(&receipt.tree_sha256)
                .is_dir()
        );
    }
    assert!(matches!(
        personal.activate(&work_id, work_approval, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Quarantined))
    ));
    personal
        .inspect(&work_id, &inspector, POLICY_VERSION, NOW)
        .unwrap();
    personal.validate(&work_id, &ctx, NOW).unwrap();
    personal
        .record_evaluation(&work_id, EvaluationResult::Passed, None, None, NOW)
        .unwrap();
    personal
        .decide(&work_id, &ctx, &ProfileGrants::default(), NOW)
        .unwrap();
    // Even an approved revision cannot use another profile's approval.
    let revision = personal.revision(&work_id).unwrap();
    let own = personal
        .approve(
            &ApprovalRequest {
                revision_id: &work_id,
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
    assert_ne!(own, work_approval);
    assert!(matches!(
        personal.activate(&work_id, work_approval, &ctx, NOW),
        Err(SkillError::NotFound)
    ));
    personal.activate(&work_id, own, &ctx, NOW).unwrap();
    assert!(personal.history("demo").unwrap().len() == 1);
    drop(personal);
    let mut work = SkillRegistry::new(&mut store, &dir.data(), profile("work"));
    assert_eq!(
        work.active("demo").unwrap(),
        None,
        "activation is per profile"
    );
    assert_eq!(
        work.revision(&work_id).unwrap().state,
        RevisionState::Approved
    );
    assert!(work.history("demo").unwrap().is_empty());
    assert_eq!(work.index_generation().unwrap(), 0);
    assert!(matches!(
        SkillRegistry::new(&mut store, &dir.data(), profile("nobody")).revision(&work_id),
        Err(SkillError::NotFound)
    ));
    assert!(ProfileId::parse("../work").is_none());
    assert!(ProfileId::parse("Work").is_none());
}

#[test]
fn rollback_uses_the_append_only_history() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let v1 = dir.package(
        "v1",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("1.0.0", "")),
        ],
    );
    let v2 = dir.package(
        "v2",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("2.0.0", "")),
        ],
    );
    let (first, first_approval) = approve(&mut registry, &v1, &inspector);
    let (second, second_approval) = approve(&mut registry, &v2, &inspector);
    assert!(matches!(
        registry.rollback("demo", &first, &ctx, NOW),
        Err(SkillError::Denied("not_previously_active"))
    ));
    registry
        .activate(&first, first_approval, &ctx, NOW)
        .unwrap();
    registry
        .activate(&second, second_approval, &ctx, NOW)
        .unwrap();
    assert_eq!(
        registry.revision(&first).unwrap().state,
        RevisionState::Superseded
    );
    let back = registry.rollback("demo", &first, &ctx, NOW).unwrap();
    assert_eq!(back.revision_id, first);
    assert_eq!(back.approval_id, first_approval);
    assert_eq!(
        registry.revision(&second).unwrap().state,
        RevisionState::Superseded
    );
    assert_eq!(
        registry.revision(&first).unwrap().state,
        RevisionState::Active
    );
    let actions: Vec<_> = registry
        .history("demo")
        .unwrap()
        .into_iter()
        .map(|event| (event.action, event.from_revision_id, event.to_revision_id))
        .collect();
    assert_eq!(
        actions,
        [
            ("activate".to_owned(), None, Some(first.clone())),
            (
                "activate".to_owned(),
                Some(first.clone()),
                Some(second.clone())
            ),
            (
                "rollback".to_owned(),
                Some(second.clone()),
                Some(first.clone())
            ),
        ]
    );
    registry.deactivate("demo", "user-request", NOW).unwrap();
    assert_eq!(registry.active("demo").unwrap(), None);
    assert_eq!(
        registry.revision(&first).unwrap().state,
        RevisionState::Approved
    );
    assert_eq!(registry.index_generation().unwrap(), 4);
    assert!(matches!(
        registry.deactivate("demo", "again", NOW),
        Err(SkillError::NotFound)
    ));
    // Rolling forward again works with the approval from the history.
    registry.rollback("demo", &second, &ctx, NOW).unwrap();
    assert_eq!(registry.history("demo").unwrap().len(), 5);
    drop(registry);
    for sql in [
        "UPDATE skill_activation_events SET reason = 'x'",
        "DELETE FROM skill_activation_events",
        "UPDATE skill_revision_events SET reason = 'x'",
        "DELETE FROM skill_revision_events",
        "DELETE FROM skill_inspections",
    ] {
        assert!(store.connection().execute(sql, []).is_err(), "{sql}");
    }
}

#[test]
fn stale_attestations_requarantine_and_void_approvals() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let (id, approval) = approve(&mut registry, &source, &inspector);
    // Policy upgrade: the attestation no longer holds.
    let upgraded = PolicyContext {
        policy_version: "extalia.skill-policy.v2".into(),
        ..ctx.clone()
    };
    assert!(matches!(
        registry.activate(&id, approval, &upgraded, NOW),
        Err(SkillError::Denied("policy_changed"))
    ));
    let revision = registry.revision(&id).unwrap();
    assert_eq!(revision.state, RevisionState::Quarantined);
    assert_eq!(revision.state_reason.as_deref(), Some("policy_changed"));
    // Re-inspection under the new policy starts over; the old approval stays void.
    registry
        .inspect(&id, &inspector, "extalia.skill-policy.v2", NOW)
        .unwrap();
    registry.validate(&id, &upgraded, NOW).unwrap();
    registry
        .record_evaluation(&id, EvaluationResult::Passed, None, None, NOW)
        .unwrap();
    registry
        .decide(&id, &upgraded, &ProfileGrants::default(), NOW)
        .unwrap();
    assert!(matches!(
        registry.activate(&id, approval, &upgraded, NOW),
        Err(SkillError::WrongState(RevisionState::AwaitingApproval))
    ));

    // An active revision whose scanner changed is deactivated and requarantined; the
    // unavailable inspector never attests anything.
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let (id, approval) = approve(&mut registry, &source, &inspector);
    registry.activate(&id, approval, &ctx, NOW).unwrap();
    let unavailable = PolicyContext::current(&UnavailableInspector);
    assert_eq!(
        registry.invalidate_stale(&unavailable, NOW).unwrap(),
        std::slice::from_ref(&id)
    );
    assert_eq!(registry.active("demo").unwrap(), None);
    assert_eq!(
        registry.revision(&id).unwrap().state_reason.as_deref(),
        Some("scanner_unpinned")
    );
    assert_eq!(
        registry.history("demo").unwrap().last().unwrap().action,
        "deactivate"
    );
    drop(registry);
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_approvals WHERE status = 'granted'"
        ),
        0
    );
}

#[test]
fn active_reads_recheck_every_scanner_identity_field_and_policy_without_fallback() {
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let changed_scanner = |scanner| PolicyContext {
        scanner,
        ..ctx.clone()
    };
    let cases = [
        (
            PolicyContext {
                policy_version: "extalia.skill-policy.v2".into(),
                ..ctx.clone()
            },
            "policy_changed",
        ),
        (
            changed_scanner(ScannerIdentity {
                id: "changed-scanner".into(),
                ..pinned()
            }),
            "scanner_changed",
        ),
        (
            changed_scanner(ScannerIdentity {
                pin: Some("changed-pin+sha256:changed".into()),
                ..pinned()
            }),
            "scanner_changed",
        ),
        (
            changed_scanner(ScannerIdentity {
                version: Some("2.0.0".into()),
                ..pinned()
            }),
            "scanner_changed",
        ),
        (
            changed_scanner(ScannerIdentity {
                normalizer_version: Some("2".into()),
                ..pinned()
            }),
            "scanner_changed",
        ),
        (
            changed_scanner(ScannerIdentity {
                pin: None,
                ..pinned()
            }),
            "scanner_unpinned",
        ),
        (
            PolicyContext::current(&UnavailableInspector),
            "scanner_unpinned",
        ),
    ];
    for (changed, reason) in cases {
        let dir = TempDir::new();
        let mut store = open(&dir);
        let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let (id, approval) = approve(&mut registry, &source, &inspector);
        registry.activate(&id, approval, &ctx, NOW).unwrap();
        assert_eq!(
            registry
                .read_active_file("demo", "SKILL.md", &ctx, NOW)
                .unwrap(),
            SKILL_MD.as_bytes()
        );
        assert!(matches!(
            registry.read_active_file("demo", "SKILL.md", &changed, NOW + 1),
            Err(SkillError::Denied(found)) if found == reason
        ));
        let revision = registry.revision(&id).unwrap();
        assert_eq!(revision.state, RevisionState::Quarantined);
        assert_eq!(revision.state_reason.as_deref(), Some(reason));
        assert_eq!(registry.active("demo").unwrap(), None);
        assert_eq!(
            registry.history("demo").unwrap().last().unwrap().action,
            "deactivate"
        );
        // The unchanged source and previously valid context cannot restore the pointer
        // or provide an unscanned fallback after the read discovers stale evidence.
        assert_eq!(
            fs::read(source.join("SKILL.md")).unwrap(),
            SKILL_MD.as_bytes()
        );
        assert!(matches!(
            registry.read_active_file("demo", "SKILL.md", &ctx, NOW + 2),
            Err(SkillError::NotFound)
        ));
        assert!(matches!(
            registry.activate(&id, approval, &ctx, NOW + 2),
            Err(SkillError::WrongState(RevisionState::Quarantined))
        ));
        drop(registry);
        assert_eq!(
            count(
                &mut store,
                "SELECT count(*) FROM skill_approvals WHERE status='granted'"
            ),
            0
        );
        assert_eq!(
            count(
                &mut store,
                "SELECT count(*) FROM skill_approvals WHERE status='revoked'"
            ),
            1
        );
        assert_eq!(
            count(&mut store, "SELECT count(*) FROM skill_activations"),
            0
        );
        assert_eq!(
            count(&mut store, "SELECT count(*) FROM skill_inspections"),
            1
        );
    }
}

#[test]
fn version_reuse_is_blocked() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let manifest = manifest_json("1.0.0", "");
    let first = dir.package(
        "a",
        &[("SKILL.md", SKILL_MD), ("extalia-skill.json", &manifest)],
    );
    approve(&mut registry, &first, &inspector);
    let body = format!("{SKILL_MD}more\n");
    let second = dir.package(
        "b",
        &[("SKILL.md", &body), ("extalia-skill.json", &manifest)],
    );
    let receipt = registry.import(&second, Origin::User, "test", NOW).unwrap();
    assert_eq!(receipt.state, RevisionState::Blocked);
    assert_eq!(receipt.state_reason.as_deref(), Some("version_reuse"));
}

#[test]
fn hybrid_auto_activation_needs_every_gate() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let grants = ProfileGrants {
        preauthorized: Permissions::default(),
        auto_activation: true,
    };
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let run = |registry: &mut SkillRegistry<'_>, source: &Path| {
        let id = registry
            .import(source, Origin::Generated, "candidate", NOW)
            .unwrap()
            .revision_id;
        registry
            .inspect(&id, &inspector, POLICY_VERSION, NOW)
            .unwrap();
        registry.validate(&id, &ctx, NOW).unwrap();
        registry
            .record_evaluation(&id, EvaluationResult::Passed, None, None, NOW)
            .unwrap();
        (
            id.clone(),
            registry.decide(&id, &ctx, &grants, NOW).unwrap(),
        )
    };
    let plain = dir.package("plain", &[("SKILL.md", SKILL_MD)]);
    let (id, route) = run(&mut registry, &plain);
    assert_eq!(route, Route::AutoEligible);
    let approval = registry
        .approve_auto(&id, &ctx, &grants, LATER, NOW)
        .unwrap();
    registry.activate(&id, approval, &ctx, NOW).unwrap();

    // Declared permissions are a ceiling, never a grant: an increase awaits the user.
    let reader = dir.package(
        "reader",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                &manifest_json("3.0.0", r#","permissions":{"filesystem_read":["src/**"]}"#),
            ),
        ],
    );
    let (id, route) = run(&mut registry, &reader);
    assert_eq!(
        route,
        Route::AwaitingApproval(vec!["permission_increase", "exceeds_preauthorized_grants"])
    );
    assert!(matches!(
        registry.approve_auto(&id, &ctx, &grants, LATER, NOW),
        Err(SkillError::WrongState(RevisionState::AwaitingApproval))
    ));
    assert_eq!(
        registry.revision(&id).unwrap().state_reason.as_deref(),
        Some("permission_increase")
    );
}

#[test]
fn declared_dependencies_wait_for_the_resolver() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package(
        "deps",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                &manifest_json(
                    "1.0.0",
                    r#","categories":["development.backend.laravel"],"intents":["optimize_query"],"dependencies":[{"id":"sql-basics","range":"^1.0.0"}]"#,
                ),
            ),
        ],
    );
    let id = registry
        .import(&source, Origin::Imported, "test", NOW)
        .unwrap()
        .revision_id;
    registry
        .inspect(&id, &inspector, POLICY_VERSION, NOW)
        .unwrap();
    assert!(matches!(
        registry.validate(&id, &ctx, NOW),
        Err(SkillError::Denied("resolver_unavailable"))
    ));
    assert_eq!(
        registry.revision(&id).unwrap().state,
        RevisionState::Inspected
    );
    drop(registry);
    // The category index rows were derived from the manifest, parents included.
    assert_eq!(
        count(&mut store, "SELECT count(*) FROM skill_categories"),
        3
    );
    assert_eq!(
        count(&mut store, "SELECT count(*) FROM skill_category_map"),
        1
    );
    assert_eq!(count(&mut store, "SELECT count(*) FROM skill_intents"), 1);
    assert_eq!(
        count(&mut store, "SELECT count(*) FROM skill_dependencies"),
        1
    );
}

#[test]
fn malformed_packages_are_not_recorded() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package(
        "bad",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                r#"{"schema":"extalia.skill-manifest.v1","id":"demo"}"#,
            ),
        ],
    );
    assert!(matches!(
        registry.import(&source, Origin::User, "test", NOW),
        Err(SkillError::Manifest(_))
    ));
    drop(registry);
    assert_eq!(count(&mut store, "SELECT count(*) FROM skill_revisions"), 0);
}

// ---- W3 slice 2: recovery, deprecation, expiry, consent, built-ins, views ----

/// An inspector that "crashes" mid-scan (the daemon process dies after `inspecting` was
/// committed).
struct CrashingInspector;

impl SkillInspector for CrashingInspector {
    fn identity(&self) -> ScannerIdentity {
        pinned()
    }

    fn inspect(&self, _request: &InspectionRequest<'_>) -> InspectionOutcome {
        panic!("simulated crash during the scan");
    }
}

#[test]
fn crash_during_inspecting_recovers_to_quarantined_without_replay() {
    let dir = TempDir::new();
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let id = {
        let mut store = open(&dir);
        let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
        let id = registry
            .import(&source, Origin::User, "test", NOW)
            .unwrap()
            .revision_id;
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            registry.inspect(&id, &CrashingInspector, POLICY_VERSION, NOW)
        }));
        assert!(crashed.is_err());
        assert_eq!(
            registry.revision(&id).unwrap().state,
            RevisionState::Inspecting
        );
        id
    };
    // Reopen, as the daemon does after a restart. Another profile's recovery does not
    // touch this one.
    let mut store = open(&dir);
    assert!(
        SkillRegistry::new(&mut store, &dir.data(), profile("other"))
            .recover_interrupted(NOW)
            .unwrap()
            .is_empty()
    );
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    assert_eq!(
        registry.recover_interrupted(LATER).unwrap(),
        std::slice::from_ref(&id)
    );
    let revision = registry.revision(&id).unwrap();
    assert_eq!(revision.state, RevisionState::Quarantined);
    assert_eq!(
        revision.state_reason.as_deref(),
        Some("inspection-interrupted")
    );
    assert!(registry.recover_interrupted(LATER).unwrap().is_empty());
    // A later scan starts over; the interrupted one is never replayed or recorded.
    let inspector = FakeInspector::clean();
    let receipt = registry
        .inspect(&id, &inspector, POLICY_VERSION, LATER)
        .unwrap();
    assert_eq!(receipt.state, RevisionState::Inspected);
    drop(registry);
    assert_eq!(
        count(&mut store, "SELECT count(*) FROM skill_inspections"),
        1
    );
}

#[test]
fn deprecated_revisions_stay_active_until_replaced() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let v1 = dir.package(
        "v1",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("1.0.0", "")),
        ],
    );
    let v2 = dir.package(
        "v2",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("2.0.0", "")),
        ],
    );
    assert!(matches!(
        registry.deprecate("demo", NOW),
        Err(SkillError::NotFound)
    ));
    let (first, first_approval) = approve(&mut registry, &v1, &inspector);
    let (second, second_approval) = approve(&mut registry, &v2, &inspector);
    registry
        .activate(&first, first_approval, &ctx, NOW)
        .unwrap();
    assert_eq!(registry.deprecate("demo", NOW).unwrap(), first);
    assert_eq!(
        registry.revision(&first).unwrap().state,
        RevisionState::Deprecated
    );
    assert!(matches!(
        registry.deprecate("demo", NOW),
        Err(SkillError::WrongState(RevisionState::Deprecated))
    ));
    // Still served while deprecated.
    assert_eq!(
        registry
            .read_active_file("demo", "SKILL.md", &ctx, NOW)
            .unwrap(),
        SKILL_MD.as_bytes()
    );
    registry
        .activate(&second, second_approval, &ctx, NOW)
        .unwrap();
    assert_eq!(
        registry.revision(&first).unwrap().state,
        RevisionState::Superseded
    );
}

#[test]
fn approval_expiry_bounds_the_first_activation_only() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let v1 = dir.package(
        "v1",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("1.0.0", "")),
        ],
    );
    let v2 = dir.package(
        "v2",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("2.0.0", "")),
        ],
    );
    let (first, first_approval) = approve(&mut registry, &v1, &inspector);
    // A requested expiry beyond the maximum is refused.
    let receipt = registry.import(&v2, Origin::User, "test", NOW).unwrap();
    let second = receipt.revision_id;
    registry
        .inspect(&second, &inspector, POLICY_VERSION, NOW)
        .unwrap();
    registry.validate(&second, &ctx, NOW).unwrap();
    registry
        .record_evaluation(&second, EvaluationResult::Passed, None, None, NOW)
        .unwrap();
    registry
        .decide(&second, &ctx, &ProfileGrants::default(), NOW)
        .unwrap();
    let revision = registry.revision(&second).unwrap();
    let request = ApprovalRequest {
        revision_id: &second,
        shown_tree_sha256: &revision.tree_sha256,
        shown_permission_digest: &revision.permission_digest,
        workspace_id: None,
        approver: "user:owner",
        expires_at_ms: NOW + policy::MAX_APPROVAL_TTL_MS + 1,
    };
    assert!(matches!(
        registry.approve(&request, &ctx, NOW),
        Err(SkillError::Denied("approval_expiry_too_far"))
    ));
    let second_approval = registry
        .approve(
            &ApprovalRequest {
                expires_at_ms: NOW + policy::DEFAULT_APPROVAL_TTL_MS,
                ..request
            },
            &ctx,
            NOW,
        )
        .unwrap();
    registry
        .activate(&first, first_approval, &ctx, NOW)
        .unwrap();
    registry
        .activate(&second, second_approval, &ctx, NOW)
        .unwrap();
    // Long after both approvals expired: rollback and re-activation of a revision the
    // approval already activated still work; the attestation and bytes are re-checked.
    let much_later = NOW + 30 * 24 * 60 * 60_000;
    registry.rollback("demo", &first, &ctx, much_later).unwrap();
    registry
        .deactivate("demo", "user-request", much_later)
        .unwrap();
    registry
        .activate(&first, first_approval, &ctx, much_later)
        .unwrap();
    // An approval that never activated its revision is bound by its expiry.
    let v3 = dir.package(
        "v3",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("3.0.0", "")),
        ],
    );
    let (third, third_approval) = approve(&mut registry, &v3, &inspector);
    assert!(matches!(
        registry.activate(&third, third_approval, &ctx, LATER),
        Err(SkillError::Denied("approval_expired"))
    ));
}

#[test]
fn consent_is_review_input_and_never_activates() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD), ("notes.md", "n")]);
    let id = registry
        .import(&source, Origin::Workspace, "workspace:demo", NOW)
        .unwrap()
        .revision_id;
    let changed = dir.package("changed", &[("SKILL.md", &format!("{SKILL_MD}more\n"))]);
    let other = registry
        .import(&changed, Origin::Workspace, "workspace:demo", NOW)
        .unwrap()
        .revision_id;
    let sha = hex_digest(SKILL_MD.as_bytes());
    let file = format!(
        r#"{{"schema":"extalia.skill-consent.v1","projectLocation":"/p","skills":{{
            "demo":{{"sha256":"{sha}","allowedAt":"2026-10-21T10:00:00.000Z"}},
            "absent":{{"sha256":"{sha}","allowedAt":"2026-10-21T10:00:00.000Z"}}}}}}"#
    );
    let entries = consent::parse(file.as_bytes(), Some("/p"));
    let inputs = registry.consent_inputs(&entries, None).unwrap();
    assert_eq!(
        inputs,
        [views::ConsentInput {
            package_id: "demo".into(),
            revision_id: id.clone(),
            path: "SKILL.md".into(),
            sha256: sha,
            allowed_at: Some("2026-10-21T10:00:00.000Z".into()),
        }]
    );
    // The edited revision (another SKILL.md hash) gets no consent.
    assert!(
        registry
            .consent_inputs(&entries, Some(&other))
            .unwrap()
            .is_empty()
    );
    // Stored as review input, once per (revision, workspace, digest); never a decision.
    const WORKSPACE: &str = "00000000-0000-4000-8000-0000000000aa";
    assert_eq!(
        registry
            .record_consent_inputs(WORKSPACE, &inputs, NOW)
            .unwrap(),
        1
    );
    assert_eq!(
        registry
            .record_consent_inputs(WORKSPACE, &inputs, LATER)
            .unwrap(),
        0
    );
    let stored = registry.review_inputs(&id).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(
        (
            stored[0].source.as_str(),
            stored[0].workspace_id.as_str(),
            stored[0].consent_sha256.as_str(),
            stored[0].allowed_at.as_deref()
        ),
        (
            "w0-consent",
            WORKSPACE,
            inputs[0].sha256.as_str(),
            Some("2026-10-21T10:00:00.000Z")
        )
    );
    assert!(matches!(
        registry.record_consent_inputs("../elsewhere", &inputs, NOW),
        Err(SkillError::Denied("workspace_invalid"))
    ));
    // A consent that does not match the stored SKILL.md is refused by the store itself.
    let forged = views::ConsentInput {
        revision_id: other.clone(),
        ..inputs[0].clone()
    };
    assert!(
        registry
            .record_consent_inputs(WORKSPACE, &[forged], NOW)
            .is_err()
    );
    assert!(registry.review_inputs(&other).unwrap().is_empty());
    assert!(registry.reviews(&id).unwrap().is_empty());
    // Nothing moved: still quarantined, no inspection, approval or activation.
    for revision in [&id, &other] {
        assert_eq!(
            registry.revision(revision).unwrap().state,
            RevisionState::Quarantined
        );
    }
    assert_eq!(registry.active("demo").unwrap(), None);
    let inspected = registry
        .inspect(&id, &inspector, POLICY_VERSION, NOW)
        .unwrap();
    assert_eq!(inspected.state, RevisionState::Inspected);
    drop(registry);
    for table in ["skill_approvals", "skill_activations", "skill_reviews"] {
        assert_eq!(
            count(&mut store, &format!("SELECT count(*) FROM {table}")),
            0
        );
    }
}

#[test]
fn builtins_are_hashed_exempt_and_only_registered_internally() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD), ("guide.md", "guide")]);
    let skill = catalog.register(&mut store, &source, NOW).unwrap().clone();
    let tree = tree::scan(&source, &StagingLimits::default()).unwrap();
    assert_eq!(skill.revision_id, format!("skr_{}", tree.sha256));
    assert_eq!(skill.package_id, "demo");
    assert!(
        dir.data()
            .join("profiles/default/skills/objects")
            .join(&tree.sha256)
            .is_dir()
    );
    // Idempotent for the same bytes; another tree under the same id is refused.
    catalog.register(&mut store, &source, NOW).unwrap();
    let changed = dir.package("changed", &[("SKILL.md", &format!("{SKILL_MD}x\n"))]);
    assert!(matches!(
        catalog.register(&mut store, &changed, NOW),
        Err(SkillError::Denied("builtin_conflict"))
    ));
    assert_eq!(catalog.len(), 1);
    let (entry, bytes) = catalog
        .read_file(&mut store, &skill.revision_id, "SKILL.md", NOW)
        .unwrap();
    assert_eq!(bytes, SKILL_MD.as_bytes());
    assert_eq!(entry.sha256, hex_digest(SKILL_MD.as_bytes()));
    assert!(matches!(
        catalog.read_file(&mut store, &skill.revision_id, "missing.md", NOW),
        Err(SkillError::NotFound)
    ));
    // No scanner ran and nothing was written to the store's skill tables; the
    // registration is recorded once, outside the revision tables.
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_builtin_registrations"
        ),
        1
    );
    for table in ["skill_packages", "skill_revisions", "skill_inspections"] {
        assert_eq!(
            count(&mut store, &format!("SELECT count(*) FROM {table}")),
            0
        );
    }
    // The import path cannot claim the origin, not even through the manifest.
    assert_eq!(Origin::parse("builtin"), None);
    assert!(
        Origin::ALL
            .iter()
            .all(|origin| origin.as_str() != BUILTIN_ORIGIN)
    );
    let claims = dir.package(
        "claims",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                &manifest_json("1.0.0", r#","origin":"builtin""#),
            ),
        ],
    );
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    assert!(matches!(
        registry.import(&claims, Origin::Imported, "test", NOW),
        Err(SkillError::Manifest(_))
    ));
    // Importing the same bytes as a built-in gives an ordinary quarantined revision.
    let receipt = registry.import(&source, Origin::User, "test", NOW).unwrap();
    assert_eq!(receipt.revision_id, skill.revision_id);
    assert_eq!(receipt.state, RevisionState::Quarantined);
    drop(registry);
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_packages WHERE origin = 'user'"
        ),
        1
    );
}

#[cfg(unix)]
#[test]
fn tampered_builtins_are_dropped() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let skill = catalog.register(&mut store, &source, NOW).unwrap().clone();
    let object = dir
        .data()
        .join("profiles/default/skills/objects")
        .join(&skill.tree.sha256);
    tamper(&object.join("SKILL.md"), b"evil");
    assert!(matches!(
        catalog.read_file(&mut store, &skill.revision_id, "SKILL.md", NOW),
        Err(SkillError::Integrity)
    ));
    assert!(catalog.is_empty());
    assert!(matches!(
        catalog.read_file(&mut store, &skill.revision_id, "SKILL.md", NOW),
        Err(SkillError::NotFound)
    ));
    assert_eq!(
        count(
            &mut store,
            "SELECT count(*) FROM skill_builtin_registrations WHERE event = 'integrity'"
        ),
        1
    );
    // A later start does not load it again.
    let mut restarted = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let report = restarted.restore(&mut store, LATER).unwrap();
    assert!(report.restored.is_empty() && report.integrity.is_empty());
    assert!(restarted.is_empty());
}

#[test]
fn views_list_inspect_and_read_only_the_active_revision() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::clean();
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let v1 = dir.package(
        "v1",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                &manifest_json("1.0.0", r#","permissions":{"network":["example.com"]}"#),
            ),
        ],
    );
    let v2 = dir.package(
        "v2",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest_json("2.0.0", "")),
        ],
    );
    let (first, first_approval) = approve(&mut registry, &v1, &inspector);
    let (second, _) = approve(&mut registry, &v2, &inspector);
    let other = dir.package(
        "other",
        &[("SKILL.md", "---\nname: alpha\ndescription: A\n---\nA.\n")],
    );
    let alpha = registry
        .import(&other, Origin::Imported, "test", NOW)
        .unwrap()
        .revision_id;
    registry
        .activate(&first, first_approval, &ctx, NOW)
        .unwrap();

    let all = registry.list(None, None, 100).unwrap();
    let keys: Vec<_> = all
        .iter()
        .map(|summary| {
            (
                summary.revision.package_id.clone(),
                summary.revision.revision_id.clone(),
            )
        })
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].revision.revision_id, alpha);
    assert_eq!(all[0].origin, "imported");
    assert!(all.iter().any(|summary| summary.active
        && summary.revision.revision_id == first
        && summary.revision.permissions.network.contains("example.com")));
    // Cursor paging returns the rest exactly once.
    let page = registry.list(None, None, 2).unwrap();
    let last = page.last().unwrap();
    let rest = registry
        .list(
            Some((&last.revision.package_id, &last.revision.revision_id)),
            None,
            100,
        )
        .unwrap();
    assert_eq!(page.len() + rest.len(), 3);
    assert_eq!(registry.list(None, Some("demo"), 100).unwrap().len(), 2);
    assert!(matches!(
        registry.list(None, None, 0),
        Err(SkillError::Denied("limit_invalid"))
    ));
    // A full page of MAX_LIST_LIMIT plus the one lookahead row is allowed; more is not.
    assert!(registry.list(None, None, MAX_LIST_LIMIT + 1).is_ok());
    assert!(matches!(
        registry.list(None, None, MAX_LIST_LIMIT + 2),
        Err(SkillError::Denied("limit_invalid"))
    ));

    let details = registry.details(&first).unwrap();
    assert_eq!(
        details
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["SKILL.md", "extalia-skill.json"]
    );
    assert_eq!(details.inspections.len(), 1);
    assert_eq!(details.approvals[0].approver, "user:owner");
    assert_eq!(
        details.history.last().unwrap().to_state,
        RevisionState::Active
    );
    assert_eq!(details.history[0].from_state, None);

    let file = registry
        .read_revision_file(&first, "SKILL.md", &ctx, NOW)
        .unwrap();
    assert_eq!(file.bytes, SKILL_MD.as_bytes());
    assert_eq!(file.entry.sha256, hex_digest(SKILL_MD.as_bytes()));
    for revision in [&second, &alpha] {
        assert!(matches!(
            registry.read_revision_file(revision, "SKILL.md", &ctx, NOW),
            Err(SkillError::Denied("not_active"))
        ));
    }
    assert!(matches!(
        registry.read_revision_file(&format!("skr_{}", "0".repeat(64)), "SKILL.md", &ctx, NOW),
        Err(SkillError::NotFound)
    ));
}

// ---- human review (migration 0004) ----

/// Import one package and inspect it with a medium finding: `review_required`.
fn reviewable(
    registry: &mut SkillRegistry<'_>,
    source: &Path,
    inspector: &FakeInspector,
) -> super::registry::Revision {
    let id = registry
        .import(source, Origin::Imported, "test", NOW)
        .unwrap()
        .revision_id;
    let receipt = registry
        .inspect(&id, inspector, POLICY_VERSION, NOW)
        .unwrap();
    assert_eq!(receipt.state, RevisionState::ReviewRequired);
    registry.revision(&id).unwrap()
}

fn review_request<'a>(
    revision: &'a super::registry::Revision,
    principal: &'a str,
    decision: review::ReviewDecision,
) -> review::ReviewRequest<'a> {
    review::ReviewRequest {
        revision_id: &revision.revision_id,
        shown_tree_sha256: &revision.tree_sha256,
        principal,
        decision,
        note: None,
    }
}

#[test]
fn accepted_review_validates_and_still_needs_an_approval() {
    use review::ReviewDecision::Accept;
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::with(Severity::Medium);
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let revision = reviewable(&mut registry, &source, &inspector);

    // Agents, models, scanners and the policy cannot review; nothing is recorded.
    for principal in [
        "agent:planner",
        "model:gpt",
        "policy:auto",
        "scanner:x",
        "local",
        "user:",
    ] {
        assert!(
            matches!(
                registry.review(&review_request(&revision, principal, Accept), &ctx, NOW),
                Err(SkillError::Denied("principal_not_user"))
            ),
            "{principal}"
        );
    }
    // A stale hash (the UI showed other bytes) is refused.
    let stale = "0".repeat(64);
    assert!(matches!(
        registry.review(
            &review::ReviewRequest {
                shown_tree_sha256: &stale,
                ..review_request(&revision, "user:owner", Accept)
            },
            &ctx,
            NOW
        ),
        Err(SkillError::Denied("digest_mismatch"))
    ));
    for note in [" \n ", "bell\u{7}"] {
        assert!(matches!(
            registry.review(
                &review::ReviewRequest {
                    note: Some(note),
                    ..review_request(&revision, "user:owner", Accept)
                },
                &ctx,
                NOW
            ),
            Err(SkillError::Denied("note_invalid"))
        ));
    }
    assert!(registry.reviews(&revision.revision_id).unwrap().is_empty());
    assert_eq!(
        registry.revision(&revision.revision_id).unwrap().state,
        RevisionState::ReviewRequired
    );

    let receipt = registry
        .review(
            &review::ReviewRequest {
                note: Some("Reviewed the finding.\nDocumentation URL only."),
                ..review_request(&revision, "user:owner", Accept)
            },
            &ctx,
            NOW,
        )
        .unwrap();
    assert_eq!(
        (receipt.state, receipt.state_reason.as_deref()),
        (RevisionState::Validated, Some("review-accepted"))
    );
    let reviews = registry.reviews(&revision.revision_id).unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0].review_id, receipt.review_id);
    assert_eq!(reviews[0].principal, "user:owner");
    assert_eq!(reviews[0].decision, Accept);
    assert_eq!(reviews[0].tree_sha256, revision.tree_sha256);
    let details = registry.details(&revision.revision_id).unwrap();
    assert_eq!(
        reviews[0].inspection_id,
        details.inspections.last().unwrap().inspection_id
    );
    // Review on the wrong state: it is validated now.
    assert!(matches!(
        registry.review(&review_request(&revision, "user:owner", Accept), &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Validated))
    ));
    // A review is not an approval: the medium finding still routes to the user.
    registry
        .record_evaluation(
            &revision.revision_id,
            EvaluationResult::Passed,
            None,
            None,
            NOW,
        )
        .unwrap();
    let grants = ProfileGrants {
        auto_activation: true,
        ..ProfileGrants::default()
    };
    assert_eq!(
        registry
            .decide(&revision.revision_id, &ctx, &grants, NOW)
            .unwrap(),
        Route::AwaitingApproval(vec!["reviewed_finding"])
    );
    assert_eq!(registry.active("demo").unwrap(), None);
    drop(registry);
    // Append-only.
    for sql in [
        "UPDATE skill_reviews SET decision = 'reject'",
        "UPDATE skill_reviews SET note = NULL",
        "DELETE FROM skill_reviews",
    ] {
        assert!(store.connection().execute(sql, []).is_err(), "{sql}");
    }
    assert_eq!(count(&mut store, "SELECT count(*) FROM skill_reviews"), 1);
}

#[test]
fn rejected_review_quarantines_until_a_new_inspection() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::with(Severity::Medium);
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let revision = reviewable(&mut registry, &source, &inspector);
    let receipt = registry
        .review(
            &review::ReviewRequest {
                note: Some("Not needed."),
                ..review_request(&revision, "user:owner", review::ReviewDecision::Reject)
            },
            &ctx,
            NOW,
        )
        .unwrap();
    assert_eq!(
        (receipt.state, receipt.state_reason.as_deref()),
        (RevisionState::Quarantined, Some("review-rejected"))
    );
    assert!(matches!(
        registry.validate(&revision.revision_id, &ctx, NOW),
        Err(SkillError::WrongState(RevisionState::Quarantined))
    ));
    assert_eq!(
        registry.reviews(&revision.revision_id).unwrap()[0]
            .note
            .as_deref(),
        Some("Not needed.")
    );
    // Only a new inspection leads on, back to a review.
    let again = registry
        .inspect(&revision.revision_id, &inspector, POLICY_VERSION, LATER)
        .unwrap();
    assert_eq!(again.state, RevisionState::ReviewRequired);
}

#[test]
fn accepting_needs_a_valid_attestation_intact_bytes_and_the_resolver() {
    use review::ReviewDecision::Accept;
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::with(Severity::Medium);
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(&mut store, &dir.data(), profile("default"));

    // The scanner changed since the inspection: requarantined, no review recorded.
    let first = dir.package("first", &[("SKILL.md", SKILL_MD)]);
    let revision = reviewable(&mut registry, &first, &inspector);
    let upgraded = PolicyContext {
        scanner: ScannerIdentity {
            version: Some("1.0.1".into()),
            ..pinned()
        },
        ..ctx.clone()
    };
    assert!(matches!(
        registry.review(
            &review_request(&revision, "user:owner", Accept),
            &upgraded,
            NOW
        ),
        Err(SkillError::Denied("scanner_changed"))
    ));
    assert_eq!(
        registry.revision(&revision.revision_id).unwrap().state,
        RevisionState::Quarantined
    );
    assert!(registry.reviews(&revision.revision_id).unwrap().is_empty());

    // Declared dependencies wait for the resolver, as in validation.
    let deps = dir.package(
        "deps",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                &manifest_json(
                    "1.0.0",
                    r#","dependencies":[{"id":"sql-basics","range":"^1.0.0"}]"#,
                ),
            ),
        ],
    );
    let revision = reviewable(&mut registry, &deps, &inspector);
    assert!(matches!(
        registry.review(&review_request(&revision, "user:owner", Accept), &ctx, NOW),
        Err(SkillError::Denied("resolver_unavailable"))
    ));
    assert_eq!(
        registry.revision(&revision.revision_id).unwrap().state,
        RevisionState::ReviewRequired
    );

    // Bytes changed in the object store: revoked, never validated.
    let third = dir.package("third", &[("SKILL.md", &format!("{SKILL_MD}third\n"))]);
    let revision = reviewable(&mut registry, &third, &inspector);
    tamper(
        &registry
            .object_store()
            .object_dir(&revision.tree_sha256)
            .join("SKILL.md"),
        b"evil",
    );
    assert!(matches!(
        registry.review(&review_request(&revision, "user:owner", Accept), &ctx, NOW),
        Err(SkillError::Integrity)
    ));
    let stored = registry.revision(&revision.revision_id).unwrap();
    assert_eq!(
        (stored.state, stored.state_reason.as_deref()),
        (RevisionState::Revoked, Some("integrity"))
    );
    drop(registry);
    assert_eq!(count(&mut store, "SELECT count(*) FROM skill_reviews"), 0);
}

#[test]
fn reviews_stay_inside_their_profile() {
    let dir = TempDir::new();
    let mut store = open(&dir);
    let inspector = FakeInspector::with(Severity::Medium);
    let ctx = PolicyContext::current(&inspector);
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let revision = {
        let mut work = SkillRegistry::new(&mut store, &dir.data(), profile("work"));
        reviewable(&mut work, &source, &inspector)
    };
    let mut personal = SkillRegistry::new(&mut store, &dir.data(), profile("personal"));
    assert!(matches!(
        personal.review(
            &review_request(&revision, "user:owner", review::ReviewDecision::Accept),
            &ctx,
            NOW
        ),
        Err(SkillError::NotFound)
    ));
    assert!(personal.reviews(&revision.revision_id).unwrap().is_empty());
}

// ---- built-in persistence (migration 0004) ----

fn builtin_rows(store: &mut CoreStore) -> Vec<(String, String)> {
    store
        .connection()
        .prepare(
            "SELECT package_id, event FROM skill_builtin_registrations ORDER BY registration_id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn builtins_persist_and_are_reverified_across_restarts() {
    let dir = TempDir::new();
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD)]);
    let other = dir.package(
        "other",
        &[("SKILL.md", "---\nname: alpha\ndescription: A\n---\nA.\n")],
    );
    let registered = {
        let mut store = open(&dir);
        let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
        let skill = catalog.register(&mut store, &source, NOW).unwrap().clone();
        catalog.register(&mut store, &other, NOW).unwrap();
        store.close().unwrap();
        skill
    };

    // Restart: restored from the store after re-hashing, without the bundle.
    let mut store = open(&dir);
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let report = catalog.restore(&mut store, LATER).unwrap();
    assert_eq!(report.restored, ["alpha", "demo"]);
    assert!(report.integrity.is_empty() && report.invalid.is_empty());
    assert_eq!(catalog.get("demo"), Some(&registered));
    // Registering the same bytes again records nothing new.
    catalog.register(&mut store, &other, LATER).unwrap();
    assert_eq!(builtin_rows(&mut store).len(), 2);
    // An app update replaces a restored package with other bytes, once per run.
    let updated = dir.package("updated", &[("SKILL.md", &format!("{SKILL_MD}v2\n"))]);
    let updated_id = catalog
        .register(&mut store, &updated, LATER)
        .unwrap()
        .revision_id
        .clone();
    // Within this run `demo` is now fixed.
    let third = dir.package("third", &[("SKILL.md", &format!("{SKILL_MD}v3\n"))]);
    assert!(matches!(
        catalog.register(&mut store, &third, LATER),
        Err(SkillError::Denied("builtin_conflict"))
    ));
    catalog.retire(&mut store, "alpha", LATER).unwrap();
    assert!(catalog.get("alpha").is_none());
    assert_eq!(
        builtin_rows(&mut store),
        [
            ("demo".to_owned(), "registered".to_owned()),
            ("alpha".to_owned(), "registered".to_owned()),
            ("demo".to_owned(), "registered".to_owned()),
            ("alpha".to_owned(), "retired".to_owned()),
        ]
    );
    // Nothing reached the revision tables.
    for table in ["skill_packages", "skill_revisions"] {
        assert_eq!(
            count(&mut store, &format!("SELECT count(*) FROM {table}")),
            0
        );
    }
    store.close().unwrap();

    let mut store = open(&dir);
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let report = catalog.restore(&mut store, LATER).unwrap();
    assert_eq!(report.restored, ["demo"]);
    assert_eq!(catalog.get("demo").unwrap().revision_id, updated_id);
    assert!(
        catalog.get("alpha").is_none(),
        "a retired built-in stays out"
    );
}

#[cfg(unix)]
#[test]
fn tampered_builtin_objects_are_detected_on_restart() {
    let dir = TempDir::new();
    let source = dir.package("demo", &[("SKILL.md", SKILL_MD), ("guide.md", "guide")]);
    let skill = {
        let mut store = open(&dir);
        let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
        let skill = catalog.register(&mut store, &source, NOW).unwrap().clone();
        store.close().unwrap();
        skill
    };
    let object = dir
        .data()
        .join("profiles/default/skills/objects")
        .join(&skill.tree.sha256);
    // Altered while the daemon was not running.
    tamper(&object.join("guide.md"), b"evil");

    let mut store = open(&dir);
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    let report = catalog.restore(&mut store, LATER).unwrap();
    assert_eq!(report.integrity, ["demo"]);
    assert!(report.restored.is_empty());
    assert!(catalog.is_empty());
    assert!(matches!(
        catalog.read_file(&mut store, &skill.revision_id, "SKILL.md", LATER),
        Err(SkillError::NotFound)
    ));
    // No fallback: the bundle's bytes cannot be re-registered over the altered object.
    assert!(matches!(
        catalog.register(&mut store, &source, LATER),
        Err(SkillError::Integrity)
    ));
    assert_eq!(
        builtin_rows(&mut store),
        [
            ("demo".to_owned(), "registered".to_owned()),
            ("demo".to_owned(), "integrity".to_owned()),
        ]
    );
    // Reported once: the latest row is `integrity`, so a later start skips it.
    store.close().unwrap();
    let mut store = open(&dir);
    let mut catalog = BuiltinCatalog::new(&dir.data(), &profile("default"));
    assert_eq!(
        catalog.restore(&mut store, LATER).unwrap(),
        Default::default()
    );
}
