//! Skill registry operations over the wire. Sessions run in process with a fake pinned
//! inspector where a test needs one (the binary always installs the unavailable
//! inspector); one test spawns the binary to check crash recovery on open. Every frame the
//! daemon answers is re-encoded, so it is validated against the contract.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use extalia_core::CoreStore;
use extalia_core::adapters::sqlite::store_path;
use extalia_core::skills::builtin::RestoreReport;
use extalia_core::skills::inspect::{Coverage, InspectionRequest, Severity};
use extalia_core::skills::policy::{EvaluationResult, POLICY_VERSION};
use extalia_core::skills::registry::{PolicyContext, ProfileGrants};
use extalia_core::skills::{
    InspectionOutcome, Origin, ProfileId, ScannerIdentity, ScannerStatus, SkillInspector,
    SkillRegistry,
};
use extalia_daemon::missions::Missions;
use extalia_daemon::session::Session;
use extalia_daemon::skills::Skills;
use extalia_daemon::wire::{self, Frame, FrameReader, MAX_FRAME_BYTES, Op};
use serde_json::{Value, json};

const ID: &str = "00000000-0000-4000-8000-000000000100";
/// A host workspace id (`newId('w')`), the form the host sends.
const WORKSPACE: &str = "w_mh3p2k1x9f04c2a7";
/// The lowercase UUID form the contract first required; still accepted.
const UUID_WORKSPACE: &str = "00000000-0000-4000-8000-0000000000aa";
const SKILL_MD: &str = "---\nname: demo\ndescription: Demo skill\n---\nDo the \"thing\".\n";
const USER: &str = "user:local";

mod support;

use support::Isolation;

/// A private temporary directory; it also keeps the test's [`support`] isolation.
struct TempDir(
    PathBuf,
    #[allow(dead_code, reason = "held until the test ends")] Isolation,
);

impl TempDir {
    /// For a test that holds store locks in this process.
    fn new() -> Self {
        Self::with(Isolation::HoldsLocks(support::holds_locks()))
    }

    /// For a test that spawns the daemon binary.
    fn spawning() -> Self {
        Self::with(Isolation::SpawnsDaemon(support::spawns_daemon()))
    }

    fn with(isolation: Isolation) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-daemon-skills-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return Self(dir, isolation),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }

    fn data(&self) -> PathBuf {
        self.0.join("data")
    }

    /// Write a package into `profile`'s import inbox.
    fn inbox_package(&self, profile: &str, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = self
            .data()
            .join("profiles")
            .join(profile)
            .join("skill-imports")
            .join(name);
        write_files(&root, files);
        root
    }
}

fn write_files(root: &Path, files: &[(&str, &str)]) {
    fs::create_dir_all(root).unwrap();
    for (path, text) in files {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        make_writable(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The object store is read-only; undo that so the directory can be removed.
fn make_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    let mut permissions = meta.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(if meta.is_dir() { 0o700 } else { 0o600 });
    }
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    let _ = fs::set_permissions(path, permissions);
    if meta.is_dir()
        && let Ok(entries) = fs::read_dir(path)
    {
        for entry in entries.flatten() {
            make_writable(&entry.path());
        }
    }
}

fn manifest(version: &str) -> String {
    format!(
        r#"{{"schema":"extalia.skill-manifest.v1","id":"demo","version":"{version}","risk_class":"declarative"}}"#
    )
}

#[derive(Clone)]
struct FakeInspector(Severity);

impl SkillInspector for FakeInspector {
    fn identity(&self) -> ScannerIdentity {
        ScannerIdentity {
            id: "fake-scanner".into(),
            pin: Some("0123abcd+sha256:feed".into()),
            version: Some("1.0.0".into()),
            normalizer_version: Some("1".into()),
        }
    }

    fn inspect(&self, _request: &InspectionRequest<'_>) -> InspectionOutcome {
        InspectionOutcome::Completed {
            verdict: self.0,
            coverage: Coverage::Complete,
            report_ref: None,
        }
    }
}

struct Crashing;

impl SkillInspector for Crashing {
    fn identity(&self) -> ScannerIdentity {
        FakeInspector(Severity::None).identity()
    }

    fn inspect(&self, _request: &InspectionRequest<'_>) -> InspectionOutcome {
        panic!("simulated crash during the scan");
    }
}

/// A handshaken session on `store` for `profile`; `inspector` `None` is the binary's
/// unavailable inspector.
fn start(
    dir: &TempDir,
    store: CoreStore,
    profile: &str,
    inspector: Option<FakeInspector>,
) -> Session {
    let skills = match inspector {
        Some(inspector) => Skills::with_inspector(&dir.data(), profile, Box::new(inspector)),
        None => Skills::new(&dir.data(), profile),
    };
    let mut session =
        Session::with_missions(Missions::new(store, profile.to_owned())).with_skills(skills);
    hello(&mut session);
    session
}

fn open(dir: &TempDir) -> CoreStore {
    CoreStore::open(&store_path(&dir.data())).unwrap()
}

fn close(session: Session) -> CoreStore {
    session.into_missions().unwrap().into_store()
}

fn hello(session: &mut Session) -> Vec<String> {
    let reply = send(
        session,
        json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello",
            "params": { "clientVersion": "test", "capabilities": ["hello"] } }),
    );
    reply.unwrap()["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| op.as_str().unwrap().to_owned())
        .collect()
}

/// Send one request value; `Ok(result)` or `Err((code, reason))`. The answer is encoded,
/// so it passed the contract validator.
fn send(session: &mut Session, value: Value) -> Result<Value, (String, Option<String>)> {
    let reply = session.handle(wire::parse_frame(&value));
    let frame = reply.frame.expect("a request is answered");
    let bytes = wire::encode(&frame).expect("the answer follows the contract");
    assert!(bytes.len() <= MAX_FRAME_BYTES + 4);
    match frame.to_value() {
        value if value["kind"] == "response" => Ok(value["result"].clone()),
        value => Err((
            value["error"]["code"].as_str().unwrap().to_owned(),
            value["error"]["reason"].as_str().map(str::to_owned),
        )),
    }
}

fn op(session: &mut Session, name: &str, params: Value) -> Result<Value, (String, Option<String>)> {
    send(
        session,
        json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": name, "params": params }),
    )
}

fn refused(code: &str, reason: &str) -> Result<Value, (String, Option<String>)> {
    Err((code.to_owned(), Some(reason.to_owned())))
}

/// Inspected → validated → evaluated → awaiting approval through the core: these steps have
/// no wire operation yet (the sandbox evaluation of FR-22 is not built).
fn advance_to_awaiting_approval(
    dir: &TempDir,
    store: &mut CoreStore,
    profile: &str,
    revision: &str,
) {
    let inspector = FakeInspector(Severity::None);
    let ctx = PolicyContext::current(&inspector);
    let mut registry = SkillRegistry::new(store, &dir.data(), ProfileId::parse(profile).unwrap());
    registry.validate(revision, &ctx, 1).unwrap();
    registry
        .record_evaluation(revision, EvaluationResult::Passed, None, None, 1)
        .unwrap();
    registry
        .decide(revision, &ctx, &ProfileGrants::default(), 1)
        .unwrap();
}

#[test]
fn hello_advertises_skill_operations_only_with_a_store() {
    let mut bare = Session::new();
    let capabilities = hello(&mut bare);
    assert!(capabilities.iter().all(|op| !op.starts_with("skill.")));
    assert_eq!(
        op(&mut bare, "skill.list", json!({})),
        Err(("unknown_op".to_owned(), None))
    );

    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    let capabilities = hello(&mut session);
    for name in Op::ALL
        .iter()
        .map(|op| op.as_str())
        .filter(|op| op.starts_with("skill."))
    {
        assert!(capabilities.iter().any(|op| op == name), "{name}");
    }
    // Served, including `skill.review` (core migration 0004).
    let revision = format!("skr_{}", "a".repeat(64));
    assert_eq!(
        op(
            &mut session,
            "skill.review",
            json!({ "revisionId": revision, "treeSha256": "a".repeat(64), "principal": "user:local", "decision": "accept" })
        ),
        Err(("not_found".to_owned(), None))
    );
}

#[test]
fn imports_stay_quarantined_without_a_pinned_scanner() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    dir.inbox_package("default", "demo", &[("SKILL.md", SKILL_MD)]);
    let import = op(
        &mut session,
        "skill.import",
        json!({ "origin": "workspace", "path": "demo" }),
    )
    .unwrap();
    assert_eq!(import["state"], "quarantined");
    assert_eq!(import["stateReason"], "scanner-unavailable");
    assert_eq!(import["created"], true);
    let revision = import["revisionId"].as_str().unwrap().to_owned();
    let tree = import["treeSha256"].as_str().unwrap().to_owned();
    // Importing the same bytes again runs the (still unavailable) scanner again.
    let again = op(
        &mut session,
        "skill.import",
        json!({ "origin": "workspace", "path": "demo" }),
    )
    .unwrap();
    assert_eq!(
        (again["created"].clone(), again["revisionId"].clone()),
        (json!(false), json!(revision))
    );

    let list = op(&mut session, "skill.list", json!({})).unwrap();
    assert_eq!(list["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(list["revisions"][0]["origin"], "workspace");
    assert_eq!(list["revisions"][0]["active"], false);
    assert!(list.get("nextCursor").is_none());

    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap();
    let outcomes: Vec<_> = details["inspections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["outcome"].clone(), row.get("verdict").cloned()))
        .collect();
    assert_eq!(outcomes, vec![(json!("scanner-unavailable"), None); 2]);
    assert_eq!(details["files"][0]["path"], "SKILL.md");

    // Nothing gets further: approval, activation and reads are refused.
    let digest = details["revision"]["permissionDigest"].clone();
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": revision, "treeSha256": tree, "permissionDigest": digest, "principal": USER })
        ),
        refused("conflict", "wrong_state")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.activate",
            json!({ "revisionId": revision, "approvalId": 1 })
        ),
        refused("conflict", "wrong_state")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.read",
            json!({ "revisionId": revision, "path": "SKILL.md" })
        ),
        refused("denied", "not_active")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.deactivate",
            json!({ "packageId": "demo" })
        ),
        Err(("not_found".to_owned(), None))
    );
}

#[test]
fn import_reads_only_inside_the_inbox_and_refuses_the_builtin_origin() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    dir.inbox_package("default", "demo", &[("SKILL.md", SKILL_MD)]);
    // The origin cannot be spoofed: `builtin` is not an import origin on the wire.
    assert_eq!(
        op(
            &mut session,
            "skill.import",
            json!({ "origin": "builtin", "path": "demo" })
        ),
        Err(("invalid_request".to_owned(), None))
    );
    for path in ["../demo", "/etc", ".hidden", "demo/../../x"] {
        assert_eq!(
            op(
                &mut session,
                "skill.import",
                json!({ "origin": "user", "path": path })
            ),
            Err(("invalid_request".to_owned(), None)),
            "{path}"
        );
    }
    assert_eq!(
        op(
            &mut session,
            "skill.import",
            json!({ "origin": "user", "path": "missing" })
        ),
        Err(("not_found".to_owned(), None))
    );
    // A manifest cannot claim the origin either (unknown fields are refused).
    dir.inbox_package(
        "default",
        "claims",
        &[
            ("SKILL.md", SKILL_MD),
            (
                "extalia-skill.json",
                r#"{"schema":"extalia.skill-manifest.v1","id":"demo","version":"1.0.0","risk_class":"declarative","origin":"builtin"}"#,
            ),
        ],
    );
    assert_eq!(
        op(
            &mut session,
            "skill.import",
            json!({ "origin": "imported", "path": "claims" })
        ),
        refused("denied", "manifest_invalid")
    );
    #[cfg(unix)]
    {
        let outside = dir.0.join("outside");
        write_files(&outside, &[("SKILL.md", SKILL_MD)]);
        let inbox = dir.data().join("profiles/default/skill-imports");
        std::os::unix::fs::symlink(&outside, inbox.join("linked")).unwrap();
        fs::create_dir_all(inbox.join("nested")).unwrap();
        std::os::unix::fs::symlink(&dir.0, inbox.join("nested/up")).unwrap();
        assert_eq!(
            op(
                &mut session,
                "skill.import",
                json!({ "origin": "user", "path": "linked" })
            ),
            refused("denied", "symlink")
        );
        assert_eq!(
            op(
                &mut session,
                "skill.import",
                json!({ "origin": "user", "path": "nested/up/outside" })
            ),
            refused("denied", "outside_import_root")
        );
    }
}

#[test]
fn full_flow_approve_activate_read_rollback_revoke() {
    let dir = TempDir::new();
    let clean = Some(FakeInspector(Severity::None));
    let mut session = start(&dir, open(&dir), "default", clean.clone());
    dir.inbox_package(
        "default",
        "v1",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest("1.0.0")),
        ],
    );
    dir.inbox_package(
        "default",
        "v2",
        &[
            ("SKILL.md", SKILL_MD),
            ("extalia-skill.json", &manifest("2.0.0")),
        ],
    );
    let mut revisions = Vec::new();
    for path in ["v1", "v2"] {
        let import = op(
            &mut session,
            "skill.import",
            json!({ "origin": "user", "path": path, "sourceRef": format!("user:{path}") }),
        )
        .unwrap();
        assert_eq!(import["state"], "inspected");
        revisions.push((
            import["revisionId"].as_str().unwrap().to_owned(),
            import["treeSha256"].as_str().unwrap().to_owned(),
        ));
    }
    let mut store = close(session);
    for (revision, _) in &revisions {
        advance_to_awaiting_approval(&dir, &mut store, "default", revision);
    }
    let mut session = start(&dir, store, "default", clean);
    let (first, first_tree) = revisions[0].clone();
    let (second, second_tree) = revisions[1].clone();
    let digest = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": first }),
    )
    .unwrap()["revision"]["permissionDigest"]
        .clone();

    // Only the local user approves, and only the digests that were shown.
    for principal in ["agent:lead", "model:planner", "policy:auto", "user:"] {
        assert_eq!(
            op(
                &mut session,
                "skill.approve",
                json!({ "revisionId": first, "treeSha256": first_tree, "permissionDigest": digest, "principal": principal })
            ),
            Err(("invalid_request".to_owned(), None)),
            "{principal}"
        );
    }
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": first, "treeSha256": second_tree, "permissionDigest": digest, "principal": "user:local" })
        ),
        refused("conflict", "digest_mismatch")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": first, "treeSha256": first_tree, "permissionDigest": "0".repeat(64), "principal": "user:local" })
        ),
        refused("conflict", "permission_digest_mismatch")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": first, "treeSha256": first_tree, "permissionDigest": digest, "principal": "user:local", "expiresAt": "2001-01-01T00:00:00Z" })
        ),
        refused("denied", "approval_expired")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": first, "treeSha256": first_tree, "permissionDigest": digest, "principal": "user:local", "expiresAt": "9999-01-01T00:00:00Z" })
        ),
        refused("denied", "approval_expiry_too_far")
    );
    let approval = op(&mut session, "skill.approve", json!({ "revisionId": first, "treeSha256": first_tree, "permissionDigest": digest, "principal": "user:local", "workspaceId": WORKSPACE })).unwrap();
    assert_eq!(approval["state"], "approved");
    // Default expiry: 10 minutes after the approval.
    let expires = extalia_core::time::parse_utc(approval["expiresAt"].as_str().unwrap()).unwrap();
    let remaining = expires - extalia_core::time::now_millis();
    assert!(
        (9 * 60_000..=10 * 60_000).contains(&remaining),
        "{remaining}"
    );
    let first_approval = approval["approvalId"].as_u64().unwrap();

    assert_eq!(
        op(
            &mut session,
            "skill.read",
            json!({ "revisionId": first, "path": "SKILL.md" })
        ),
        refused("denied", "not_active")
    );
    let activation = op(
        &mut session,
        "skill.activate",
        json!({ "revisionId": first, "approvalId": first_approval }),
    )
    .unwrap();
    assert_eq!(
        (
            activation["packageId"].clone(),
            activation["indexGeneration"].clone()
        ),
        (json!("demo"), json!(1))
    );
    let read = op(
        &mut session,
        "skill.read",
        json!({ "revisionId": first, "path": "SKILL.md" }),
    )
    .unwrap();
    assert_eq!(read["content"], SKILL_MD);
    assert_eq!(read["size"], SKILL_MD.len());
    assert_eq!(
        op(
            &mut session,
            "skill.read",
            json!({ "revisionId": first, "path": "missing.md" })
        ),
        Err(("not_found".to_owned(), None))
    );
    // A non-active revision is never readable.
    assert_eq!(
        op(
            &mut session,
            "skill.read",
            json!({ "revisionId": second, "path": "SKILL.md" })
        ),
        refused("denied", "not_active")
    );

    let second_approval = op(&mut session, "skill.approve", json!({ "revisionId": second, "treeSha256": second_tree, "permissionDigest": digest, "principal": "user:local" })).unwrap()["approvalId"].as_u64().unwrap();
    assert_eq!(
        op(
            &mut session,
            "skill.activate",
            json!({ "revisionId": second, "approvalId": first_approval })
        ),
        refused("conflict", "approval_mismatch")
    );
    op(
        &mut session,
        "skill.activate",
        json!({ "revisionId": second, "approvalId": second_approval }),
    )
    .unwrap();
    assert_eq!(
        op(
            &mut session,
            "skill.read",
            json!({ "revisionId": first, "path": "SKILL.md" })
        ),
        refused("denied", "not_active")
    );
    let back = op(
        &mut session,
        "skill.rollback",
        json!({ "packageId": "demo", "revisionId": first }),
    )
    .unwrap();
    assert_eq!(
        (back["revisionId"].clone(), back["approvalId"].clone()),
        (json!(first), json!(first_approval))
    );
    assert_eq!(
        op(
            &mut session,
            "skill.rollback",
            json!({ "packageId": "demo", "revisionId": format!("skr_{}", "0".repeat(64)) })
        ),
        refused("denied", "not_previously_active")
    );
    let off = op(
        &mut session,
        "skill.deactivate",
        json!({ "packageId": "demo" }),
    )
    .unwrap();
    assert_eq!(
        (off["revisionId"].clone(), off["state"].clone()),
        (json!(first), json!("approved"))
    );
    let revoked = op(
        &mut session,
        "skill.revoke",
        json!({ "revisionId": second }),
    )
    .unwrap();
    assert_eq!(revoked["state"], "revoked");
    assert_eq!(
        op(
            &mut session,
            "skill.revoke",
            json!({ "revisionId": second })
        ),
        refused("conflict", "wrong_state")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.rollback",
            json!({ "packageId": "demo", "revisionId": second })
        ),
        refused("conflict", "wrong_state")
    );

    let list = op(&mut session, "skill.list", json!({ "limit": 1 })).unwrap();
    assert_eq!(list["revisions"].as_array().unwrap().len(), 1);
    let cursor = list["nextCursor"].as_str().unwrap().to_owned();
    let rest = op(&mut session, "skill.list", json!({ "cursor": cursor })).unwrap();
    assert_eq!(rest["revisions"].as_array().unwrap().len(), 1);
    assert!(rest.get("nextCursor").is_none());
    assert_ne!(
        list["revisions"][0]["revisionId"],
        rest["revisions"][0]["revisionId"]
    );

    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": first }),
    )
    .unwrap();
    assert_eq!(details["approvals"][0]["approver"], "user:local");
    assert_eq!(details["approvals"][0]["workspaceId"], WORKSPACE);
    let states: Vec<_> = details["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["toState"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(states.last().unwrap(), "approved");
    assert!(states.contains(&"superseded".to_owned()));
}

#[test]
fn builtin_skills_are_registered_inside_the_daemon_only() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    let bundle = dir.0.join("app/skills/planning");
    write_files(
        &bundle,
        &[(
            "SKILL.md",
            "---\nname: planning\ndescription: Plans\n---\nPlan first.\n",
        )],
    );
    let builtin = session.register_builtin(&bundle).unwrap().unwrap();

    let list = op(&mut session, "skill.list", json!({})).unwrap();
    let entry = &list["revisions"][0];
    assert_eq!(
        (
            entry["origin"].clone(),
            entry["active"].clone(),
            entry["state"].clone()
        ),
        (json!("builtin"), json!(true), json!("active"))
    );
    assert_eq!(entry["revisionId"], builtin);
    // Exempt from the scanner gate: readable without inspection, approval or activation.
    let read = op(
        &mut session,
        "skill.read",
        json!({ "revisionId": builtin, "path": "SKILL.md" }),
    )
    .unwrap();
    assert_eq!(read["packageId"], "planning");
    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": builtin }),
    )
    .unwrap();
    assert_eq!(details["inspections"], json!([]));
    // It never enters the lifecycle over the wire.
    let tree = entry["treeSha256"].clone();
    let digest = entry["permissionDigest"].clone();
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": builtin, "treeSha256": tree, "permissionDigest": digest, "principal": "user:local" })
        ),
        refused("denied", "builtin")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.revoke",
            json!({ "revisionId": builtin })
        ),
        refused("denied", "builtin")
    );
    assert_eq!(
        op(
            &mut session,
            "skill.deactivate",
            json!({ "packageId": "planning" })
        ),
        Err(("not_found".to_owned(), None))
    );
    // The same bytes imported by a user are an ordinary, quarantined revision.
    dir.inbox_package(
        "default",
        "planning",
        &[(
            "SKILL.md",
            "---\nname: planning\ndescription: Plans\n---\nPlan first.\n",
        )],
    );
    let import = op(
        &mut session,
        "skill.import",
        json!({ "origin": "user", "path": "planning" }),
    )
    .unwrap();
    assert_eq!(
        (import["revisionId"].clone(), import["state"].clone()),
        (json!(builtin), json!("quarantined"))
    );
    let origins: Vec<_> = op(
        &mut session,
        "skill.list",
        json!({ "packageId": "planning" }),
    )
    .unwrap()["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["origin"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(origins.len(), 2);
    assert!(origins.contains(&"builtin".to_owned()) && origins.contains(&"user".to_owned()));
}

#[test]
fn consent_is_shown_as_review_input_and_activates_nothing() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    dir.inbox_package("default", "demo", &[("SKILL.md", SKILL_MD)]);
    let revision = op(
        &mut session,
        "skill.import",
        json!({ "origin": "workspace", "path": "demo" }),
    )
    .unwrap()["revisionId"]
        .clone();
    let sha = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap()["revision"]["skillMdSha256"]
        .clone();
    let consent_dir = dir.data().join("workspaces").join(WORKSPACE);
    fs::create_dir_all(&consent_dir).unwrap();
    fs::write(
        consent_dir.join("skill-consent.json"),
        json!({ "schema": "extalia.skill-consent.v1", "projectLocation": "/p",
            "skills": { "demo": { "sha256": sha, "allowedAt": "2026-10-21T08:00:00.000Z" } } })
        .to_string(),
    )
    .unwrap();
    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision, "workspaceId": WORKSPACE }),
    )
    .unwrap();
    let recorded = json!([{ "path": "SKILL.md", "sha256": sha,
        "allowedAt": "2026-10-21T08:00:00.000Z", "workspaceId": WORKSPACE }]);
    assert_eq!(details["consent"], recorded);
    assert_eq!(details["revision"]["state"], "quarantined");
    assert_eq!(details["approvals"], json!([]));
    // Another workspace (no consent file) adds nothing; the stored input stays visible, also
    // without a workspace.
    let other = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision, "workspaceId": "w_mh3p2k1x9f04c2a8" }),
    )
    .unwrap();
    assert_eq!(other["consent"], recorded);
    let plain = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap();
    assert_eq!(plain["consent"], recorded);
    // Inspecting again records the same input once; the revision never moved.
    let again = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision, "workspaceId": WORKSPACE }),
    )
    .unwrap();
    assert_eq!(again["revision"]["state"], "quarantined");
    assert_eq!(again["history"], details["history"]);
    close(session).close().unwrap();
    let inputs: i64 = cell(
        &dir,
        "SELECT count(*) FROM skill_review_inputs WHERE source = 'w0-consent'",
    );
    assert_eq!(inputs, 1);
    let stored: String = cell(
        &dir,
        "SELECT workspace_id || ' ' || consent_sha256 || ' ' || allowed_at FROM skill_review_inputs",
    );
    assert_eq!(
        stored,
        format!(
            "{WORKSPACE} {} 2026-10-21T08:00:00.000Z",
            sha.as_str().unwrap()
        )
    );
    for table in ["skill_reviews", "skill_approvals", "skill_activations"] {
        let rows: i64 = cell(&dir, &format!("SELECT count(*) FROM {table}"));
        assert_eq!(rows, 0, "{table}");
    }
}

#[test]
fn profiles_are_isolated_over_the_wire() {
    let dir = TempDir::new();
    let clean = Some(FakeInspector(Severity::None));
    let mut work = start(&dir, open(&dir), "work", clean.clone());
    dir.inbox_package("work", "demo", &[("SKILL.md", SKILL_MD)]);
    let revision = op(
        &mut work,
        "skill.import",
        json!({ "origin": "user", "path": "demo" }),
    )
    .unwrap()["revisionId"]
        .clone();
    let store = close(work);

    let mut personal = start(&dir, store, "personal", clean);
    assert_eq!(
        op(&mut personal, "skill.list", json!({})).unwrap()["revisions"],
        json!([])
    );
    assert_eq!(
        op(
            &mut personal,
            "skill.inspect",
            json!({ "revisionId": revision })
        ),
        Err(("not_found".to_owned(), None))
    );
    assert_eq!(
        op(
            &mut personal,
            "skill.read",
            json!({ "revisionId": revision, "path": "SKILL.md" })
        ),
        Err(("not_found".to_owned(), None))
    );
    assert_eq!(
        op(
            &mut personal,
            "skill.revoke",
            json!({ "revisionId": revision })
        ),
        Err(("not_found".to_owned(), None))
    );
    // Another profile's inbox is not reachable either.
    assert_eq!(
        op(
            &mut personal,
            "skill.import",
            json!({ "origin": "user", "path": "demo" })
        ),
        Err(("not_found".to_owned(), None))
    );
}

/// Import `name` with a medium finding: `review_required`. Returns (revision, tree hash).
fn import_for_review(
    session: &mut Session,
    dir: &TempDir,
    name: &str,
    body: &str,
) -> (Value, Value) {
    dir.inbox_package("default", name, &[("SKILL.md", body)]);
    let import = op(
        session,
        "skill.import",
        json!({ "origin": "imported", "path": name }),
    )
    .unwrap();
    assert_eq!(
        (import["state"].clone(), import["stateReason"].clone()),
        (json!("review_required"), json!("finding-medium"))
    );
    (import["revisionId"].clone(), import["treeSha256"].clone())
}

#[test]
fn medium_findings_are_validated_only_by_a_user_review() {
    let dir = TempDir::new();
    let mut session = start(
        &dir,
        open(&dir),
        "default",
        Some(FakeInspector(Severity::Medium)),
    );
    let (revision, tree) = import_for_review(&mut session, &dir, "demo", SKILL_MD);
    let digest = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap()["revision"]["permissionDigest"]
        .clone();
    // Not approvable before the review.
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": revision, "treeSha256": tree, "permissionDigest": digest, "principal": USER })
        ),
        refused("conflict", "wrong_state")
    );
    // Only the local user principal can be expressed at all.
    for principal in ["agent:planner", "policy:auto", "model:x"] {
        assert_eq!(
            op(
                &mut session,
                "skill.review",
                json!({ "revisionId": revision, "treeSha256": tree, "principal": principal, "decision": "accept" })
            ),
            Err(("invalid_request".to_owned(), None)),
            "{principal}"
        );
    }
    // A stale hash is refused.
    assert_eq!(
        op(
            &mut session,
            "skill.review",
            json!({ "revisionId": revision, "treeSha256": "0".repeat(64), "principal": USER, "decision": "accept" })
        ),
        refused("conflict", "digest_mismatch")
    );
    let review = op(
        &mut session,
        "skill.review",
        json!({ "revisionId": revision, "treeSha256": tree, "principal": USER, "decision": "accept",
            "note": "Reviewed the medium finding.\nThe flagged URL is documentation only." }),
    )
    .unwrap();
    assert_eq!(
        review,
        json!({ "revisionId": revision, "decision": "accept", "state": "validated",
            "stateReason": "review-accepted", "reviewId": 1 })
    );
    // Review on the wrong state.
    assert_eq!(
        op(
            &mut session,
            "skill.review",
            json!({ "revisionId": revision, "treeSha256": tree, "principal": USER, "decision": "reject" })
        ),
        refused("conflict", "wrong_state")
    );
    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap();
    assert_eq!(details["revision"]["state"], "validated");
    assert_eq!(details["approvals"], json!([]));
    let last = details["history"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(
        (last["fromState"].clone(), last["reason"].clone()),
        (json!("review_required"), json!("review-accepted"))
    );
    // Still not approvable: evaluation and the policy decision come first.
    assert_eq!(
        op(
            &mut session,
            "skill.approve",
            json!({ "revisionId": revision, "treeSha256": tree, "permissionDigest": digest, "principal": USER })
        ),
        refused("conflict", "wrong_state")
    );
    close(session).close().unwrap();
    let principal: String = cell(&dir, "SELECT principal FROM skill_reviews");
    assert_eq!(principal, USER);
}

#[test]
fn rejected_reviews_quarantine_the_revision() {
    let dir = TempDir::new();
    let mut session = start(
        &dir,
        open(&dir),
        "default",
        Some(FakeInspector(Severity::Medium)),
    );
    let (revision, tree) = import_for_review(&mut session, &dir, "demo", SKILL_MD);
    assert_eq!(
        op(
            &mut session,
            "skill.review",
            json!({ "revisionId": revision, "treeSha256": tree, "principal": USER, "decision": "reject" })
        )
        .unwrap(),
        json!({ "revisionId": revision, "decision": "reject", "state": "quarantined",
            "stateReason": "review-rejected", "reviewId": 1 })
    );
    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap();
    assert_eq!(
        (
            details["revision"]["state"].clone(),
            details["revision"]["stateReason"].clone()
        ),
        (json!("quarantined"), json!("review-rejected"))
    );
}

/// One cell of the (closed) store, read with a plain connection.
fn cell<T: rusqlite::types::FromSql>(dir: &TempDir, sql: &str) -> T {
    let conn = rusqlite::Connection::open(store_path(&dir.data())).unwrap();
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Send `requests` to a spawned daemon and return the decoded answers.
fn run_binary(args: &[&str], requests: &[Value]) -> Vec<Frame> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon starts");
    let mut stdin = child.stdin.take().unwrap();
    for value in requests {
        let payload = serde_json::to_vec(value).unwrap();
        stdin
            .write_all(&(payload.len() as u32).to_be_bytes())
            .unwrap();
        stdin.write_all(&payload).unwrap();
    }
    drop(stdin);
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut output)
        .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0));
    FrameReader::new(MAX_FRAME_BYTES)
        .push(&output)
        .into_iter()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn the_binary_recovers_an_interrupted_inspection_on_open() {
    let dir = TempDir::spawning();
    let source = dir.0.join("source");
    write_files(&source, &[("SKILL.md", SKILL_MD)]);
    let revision = {
        let mut store = open(&dir);
        let mut registry = SkillRegistry::new(
            &mut store,
            &dir.data(),
            ProfileId::parse("default").unwrap(),
        );
        let revision = registry
            .import(&source, Origin::User, "test", 1)
            .unwrap()
            .revision_id;
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            registry.inspect(&revision, &Crashing, POLICY_VERSION, 1)
        }));
        assert!(crashed.is_err());
        drop(registry);
        store.close().unwrap();
        revision
    };
    let data = dir.data();
    let frames = run_binary(
        &["--data-dir", data.to_str().unwrap()],
        &[
            json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello",
                "params": { "clientVersion": "test", "capabilities": ["hello"] } }),
            json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "skill.inspect",
                "params": { "revisionId": revision } }),
        ],
    );
    let values: Vec<_> = frames.iter().map(Frame::to_value).collect();
    assert!(
        values[0]["result"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("skill.import"))
    );
    let details = &values[1]["result"];
    assert_eq!(details["revision"]["state"], "quarantined");
    assert_eq!(details["revision"]["stateReason"], "inspection-interrupted");
    // The scan was not replayed: no inspection row exists.
    assert_eq!(details["inspections"], json!([]));
    assert!(matches!(&frames[1], Frame::Response(_)));
}

/// Open the store and the registry as the binary does: built-ins re-verified first.
fn restart(dir: &TempDir) -> (Session, RestoreReport) {
    let mut store = open(dir);
    let mut skills = Skills::new(&dir.data(), "default");
    let report = skills.restore_builtins(&mut store).unwrap();
    let mut session =
        Session::with_missions(Missions::new(store, "default".to_owned())).with_skills(skills);
    hello(&mut session);
    (session, report)
}

#[test]
fn builtin_registrations_survive_a_restart_and_tampering_is_detected() {
    let dir = TempDir::spawning();
    let mut session = start(&dir, open(&dir), "default", None);
    let bundle = dir.0.join("app/skills/planning");
    let planning = "---\nname: planning\ndescription: Plans\n---\nPlan first.\n";
    write_files(&bundle, &[("SKILL.md", planning)]);
    let builtin = session.register_builtin(&bundle).unwrap().unwrap();
    close(session).close().unwrap();

    // The binary restores it without the bundle.
    let data = dir.data();
    let frames = run_binary(
        &["--data-dir", data.to_str().unwrap()],
        &[
            json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "hello",
                "params": { "clientVersion": "test", "capabilities": ["hello"] } }),
            json!({ "schemaVersion": 1, "kind": "request", "requestId": ID, "op": "skill.read",
                "params": { "revisionId": builtin, "path": "SKILL.md" } }),
        ],
    );
    assert_eq!(frames[1].to_value()["result"]["content"], planning);

    let (mut session, report) = restart(&dir);
    assert_eq!(report.restored, ["planning"]);
    let list = op(&mut session, "skill.list", json!({})).unwrap();
    assert_eq!(
        (
            list["revisions"][0]["revisionId"].clone(),
            list["revisions"][0]["origin"].clone()
        ),
        (json!(builtin), json!("builtin"))
    );
    close(session).close().unwrap();

    // Altered while no daemon ran: detected on start, recorded, never served.
    let object = data
        .join("profiles/default/skills/objects")
        .join(&builtin[4..]);
    make_writable(&object);
    fs::write(object.join("SKILL.md"), "evil").unwrap();
    let (mut session, report) = restart(&dir);
    assert_eq!(report.integrity, ["planning"]);
    assert!(report.restored.is_empty());
    assert_eq!(
        op(&mut session, "skill.list", json!({})).unwrap()["revisions"],
        json!([])
    );
    assert_eq!(
        op(
            &mut session,
            "skill.read",
            json!({ "revisionId": builtin, "path": "SKILL.md" })
        ),
        Err(("not_found".to_owned(), None))
    );
    close(session).close().unwrap();
    let events: String = cell(
        &dir,
        "SELECT group_concat(event, ',') FROM (SELECT event FROM skill_builtin_registrations ORDER BY registration_id)",
    );
    assert_eq!(events, "registered,integrity");
}

#[test]
fn consent_of_uuid_and_host_workspaces_is_kept_and_bad_ids_are_refused() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    dir.inbox_package("default", "demo", &[("SKILL.md", SKILL_MD)]);
    let imported = op(
        &mut session,
        "skill.import",
        json!({ "origin": "workspace", "path": "demo" }),
    )
    .unwrap();
    let revision = imported["revisionId"].clone();
    let sha = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap()["revision"]["skillMdSha256"]
        .clone();
    for workspace in [UUID_WORKSPACE, WORKSPACE] {
        let folder = dir.data().join("workspaces").join(workspace);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("skill-consent.json"),
            json!({ "schema": "extalia.skill-consent.v1", "projectLocation": "/p",
                "skills": { "demo": { "sha256": sha } } })
            .to_string(),
        )
        .unwrap();
        op(
            &mut session,
            "skill.inspect",
            json!({ "revisionId": revision, "workspaceId": workspace }),
        )
        .unwrap();
    }
    let details = op(
        &mut session,
        "skill.inspect",
        json!({ "revisionId": revision }),
    )
    .unwrap();
    assert_eq!(
        details["consent"],
        json!([
            { "path": "SKILL.md", "sha256": sha, "workspaceId": UUID_WORKSPACE },
            { "path": "SKILL.md", "sha256": sha, "workspaceId": WORKSPACE },
        ]),
        "oldest first, each with its workspace"
    );
    // Ids that are not workspace ids never reach a path or the store.
    for bad in [
        "w_../../../etc",
        "../../workspaces/x",
        "W_MH3P2K1X9F04C2A7",
        "w_mh3p2k1x9f04c2a7/..",
        "00000000-0000-4000-8000-0000000000AA",
    ] {
        assert_eq!(
            op(
                &mut session,
                "skill.inspect",
                json!({ "revisionId": revision, "workspaceId": bad }),
            ),
            Err(("invalid_request".to_owned(), None)),
            "{bad}"
        );
    }
    close(session).close().unwrap();
    let inputs: i64 = cell(&dir, "SELECT count(*) FROM skill_review_inputs");
    assert_eq!(inputs, 2);
}

struct Unpinned {
    claims_ready: bool,
}

impl SkillInspector for Unpinned {
    fn identity(&self) -> ScannerIdentity {
        ScannerIdentity {
            id: "skillspector".into(),
            pin: None,
            version: Some("0.9.0".into()),
            normalizer_version: None,
        }
    }

    fn inspect(&self, _request: &InspectionRequest<'_>) -> InspectionOutcome {
        panic!("an unpinned scanner is never run");
    }

    fn status(&self) -> ScannerStatus {
        if self.claims_ready {
            ScannerStatus::Ready
        } else {
            ScannerStatus::Unpinned
        }
    }
}

#[test]
fn scanner_reports_the_installed_inspector_without_running_it() {
    let dir = TempDir::new();
    let mut session = start(&dir, open(&dir), "default", None);
    assert!(hello(&mut session).iter().any(|op| op == "skill.scanner"));
    assert_eq!(
        op(&mut session, "skill.scanner", json!({})).unwrap(),
        json!({ "scannerId": "unavailable", "pinned": false, "policyVersion": POLICY_VERSION,
            "status": "unavailable" })
    );
    assert_eq!(
        op(&mut session, "skill.scanner", json!({ "run": true })),
        Err(("invalid_request".to_owned(), None))
    );
    close(session).close().unwrap();

    let mut session = start(
        &dir,
        open(&dir),
        "default",
        Some(FakeInspector(Severity::None)),
    );
    assert_eq!(
        op(&mut session, "skill.scanner", json!({})).unwrap(),
        json!({ "scannerId": "fake-scanner", "pinned": true, "pin": "0123abcd+sha256:feed",
            "version": "1.0.0", "normalizerVersion": "1", "policyVersion": POLICY_VERSION,
            "status": "ready" })
    );
    close(session).close().unwrap();

    for claims_ready in [false, true] {
        let skills =
            Skills::with_inspector(&dir.data(), "default", Box::new(Unpinned { claims_ready }));
        let mut session = Session::with_missions(Missions::new(open(&dir), "default".to_owned()))
            .with_skills(skills);
        hello(&mut session);
        // `ready` is never reported without a pin.
        assert_eq!(
            op(&mut session, "skill.scanner", json!({})).unwrap(),
            json!({ "scannerId": "skillspector", "pinned": false, "version": "0.9.0",
                "policyVersion": POLICY_VERSION, "status": "unpinned" }),
            "claims ready: {claims_ready}"
        );
        close(session).close().unwrap();
    }

    let mut bare = Session::new();
    hello(&mut bare);
    assert_eq!(
        op(&mut bare, "skill.scanner", json!({})),
        Err(("unknown_op".to_owned(), None))
    );
}
