//! Skill registry dispatch (W3; ADRs 0023, 0025, 0026; gap-map decision 10) on the daemon's
//! one profile and core store. The profile is fixed at start; the wire carries no profile id.
//!
//! - `skill.import` stages `<data>/profiles/<profile>/skill-imports/<path>` (the only allowed
//!   staging root; the resolved directory must stay inside it) and runs the installed
//!   inspector. The binary installs [`UnavailableInspector`], so every import stays
//!   `quarantined` with `scanner-unavailable` until a verified scanner pin exists (ADR 0023).
//! - Built-in skills enter only through [`Skills::register_builtin`], an API inside the
//!   daemon: no request can register one or claim the `builtin` origin. Registrations are
//!   recorded in the core store and [`Skills::restore_builtins`] re-verifies them against
//!   the object store when the daemon opens it (core migration 0004).
//! - `skill.review` records the local user's review of a `review_required` revision (accept
//!   → `validated`, reject → `quarantined`), bound to the tree hash the UI showed.
//! - `skill.inspect` with a `workspaceId` stores matching W0 consent as review input; that
//!   never changes a state. Its `consent` lists the revision's stored review inputs (each with
//!   its workspace), so consent recorded once stays visible to the reviewer.
//! - `skill.scanner` reports the installed inspector and policy version without running it.
//! - Refusals carry a stable `reason`; diagnostics go to stderr without paths or contents.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use extalia_core::CoreStore;
use extalia_core::skills::builtin::{BuiltinSkill, RestoreReport};
use extalia_core::skills::consent::{self, MAX_CONSENT_BYTES};
use extalia_core::skills::manifest::{Permissions, SKILL_FILE};
use extalia_core::skills::policy::{DEFAULT_APPROVAL_TTL_MS, POLICY_VERSION};
use extalia_core::skills::registry::{ApprovalRequest, PolicyContext};
use extalia_core::skills::review::{ReviewDecision as CoreDecision, ReviewRequest};
use extalia_core::skills::tree::TreeFile;
use extalia_core::skills::views::{RevisionDetails, RevisionSummary};
use extalia_core::skills::{
    BUILTIN_ORIGIN, BuiltinCatalog, ProfileId, Refusal, RevisionState, ScannerStatus, SkillError,
    SkillInspector, SkillRegistry, UnavailableInspector, is_workspace_id,
};
use extalia_core::time::{format_utc, now_millis, parse_utc};
use serde_json::{Value, json};

use crate::wire::{
    ErrorCode, Op, ResponseResult, ReviewDecision, SKILL_LIST_MAX_LIMIT, SKILL_READ_MAX_BYTES,
    SkillRequest,
};

/// Skill operations served when a core store is open, advertised in the `hello` result.
pub const CAPABILITIES: [Op; 11] = [
    Op::SkillImport,
    Op::SkillList,
    Op::SkillInspect,
    Op::SkillReview,
    Op::SkillApprove,
    Op::SkillActivate,
    Op::SkillDeactivate,
    Op::SkillRollback,
    Op::SkillRevoke,
    Op::SkillRead,
    Op::SkillScanner,
];
/// `DAEMON_SKILL_LIST_DEFAULT_LIMIT`.
pub const LIST_DEFAULT_LIMIT: u64 = 50;
/// A `skill.list` page stops growing past this many JSON bytes (frames are at most 1 MiB).
pub const LIST_BYTE_BUDGET: usize = 768 * 1024;
/// Folder below the profile directory that `skill.import` reads packages from.
pub const IMPORT_INBOX: &str = "skill-imports";
const MAX_CONSENT_INPUTS: usize = 8;

/// A refusal: wire code and optional stable reason.
pub type SkillRefusal = (ErrorCode, Option<&'static str>);

/// The skill registry of the daemon's profile.
pub struct Skills {
    data_dir: PathBuf,
    profile: ProfileId,
    inspector: Box<dyn SkillInspector + Send>,
    builtins: BuiltinCatalog,
}

impl std::fmt::Debug for Skills {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Skills")
            .field("profile", &self.profile)
            .field("inspector", &self.inspector.identity().id)
            .field("builtins", &self.builtins.len())
            .finish()
    }
}

impl Skills {
    /// The registry of `profile` under `data_dir`, with the fail-closed
    /// [`UnavailableInspector`]. `profile` must be a valid profile id.
    pub fn new(data_dir: &Path, profile: &str) -> Self {
        Self::with_inspector(data_dir, profile, Box::new(UnavailableInspector))
    }

    /// The same with another inspector (tests and, later, the pinned scanner adapter).
    pub fn with_inspector(
        data_dir: &Path,
        profile: &str,
        inspector: Box<dyn SkillInspector + Send>,
    ) -> Self {
        let profile = ProfileId::parse(profile).expect("valid profile id");
        Self {
            builtins: BuiltinCatalog::new(data_dir, &profile),
            data_dir: data_dir.to_owned(),
            profile,
            inspector,
        }
    }

    /// The only directory `skill.import` reads from.
    pub fn import_inbox(&self) -> PathBuf {
        self.data_dir
            .join("profiles")
            .join(self.profile.as_str())
            .join(IMPORT_INBOX)
    }

    /// Daemon-internal registration of a built-in skill shipped with the app (gap-map
    /// decision 10): staged, content-hashed and recorded, exempt from the scanner gate. No
    /// wire operation reaches this. Returns the revision id.
    pub fn register_builtin(
        &mut self,
        store: &mut CoreStore,
        source: &Path,
    ) -> Result<String, SkillError> {
        let skill = self.builtins.register(store, source, now_millis())?;
        eprintln!(
            "extalia-daemon: registered built-in skill {} ({})",
            skill.package_id, skill.revision_id
        );
        Ok(skill.revision_id.clone())
    }

    /// Load the built-in skills recorded by earlier runs when the store is opened, each only
    /// after its stored object re-hashes to the recorded tree; an altered or missing object
    /// is recorded (`integrity`) and stays unavailable.
    pub fn restore_builtins(&mut self, store: &mut CoreStore) -> Result<RestoreReport, SkillError> {
        self.builtins.restore(store, now_millis())
    }

    /// Crash recovery when the store is opened: interrupted inspections go back to
    /// `quarantined`; nothing is replayed.
    pub fn recover(&self, store: &mut CoreStore) -> Result<Vec<String>, SkillError> {
        self.registry(store).recover_interrupted(now_millis())
    }

    fn registry<'s>(&self, store: &'s mut CoreStore) -> SkillRegistry<'s> {
        SkillRegistry::new(store, &self.data_dir, self.profile.clone())
    }

    fn context(&self) -> PolicyContext {
        PolicyContext::current(self.inspector.as_ref())
    }

    /// The `skill.scanner` result: the installed inspector's identity, its status and this
    /// build's policy version. `ready` is never reported without a pin.
    pub fn scanner(&self) -> Value {
        let identity = self.inspector.identity();
        let status = match self.inspector.status() {
            ScannerStatus::Ready if identity.pin.is_none() => ScannerStatus::Unpinned,
            status => status,
        };
        let mut value = json!({
            "scannerId": identity.id,
            "pinned": identity.pin.is_some(),
            "policyVersion": POLICY_VERSION,
            "status": status.as_str(),
        });
        put_opt(&mut value, "pin", identity.pin);
        put_opt(&mut value, "version", identity.version);
        put_opt(&mut value, "normalizerVersion", identity.normalizer_version);
        value
    }

    /// Run one skill request. Failures change nothing beyond what the core records for
    /// them (an integrity failure revokes; a stale attestation requarantines).
    pub fn handle(
        &mut self,
        store: &mut CoreStore,
        request: &SkillRequest,
    ) -> Result<ResponseResult, SkillRefusal> {
        let op = request.op();
        let result = self.dispatch(store, request).map_err(|error| {
            eprintln!("extalia-daemon: {} refused ({error})", op.as_str());
            refusal(&error)
        })?;
        Ok(ResponseResult::Skill { op, result })
    }

    fn dispatch(
        &mut self,
        store: &mut CoreStore,
        request: &SkillRequest,
    ) -> Result<Value, SkillError> {
        let now = now_millis();
        let ctx = self.context();
        match request {
            SkillRequest::Import {
                origin,
                path,
                source_ref,
            } => {
                let source = self.resolve_import(path)?;
                let mut registry = self.registry(store);
                let mut receipt = registry.import(
                    &source,
                    *origin,
                    source_ref.as_deref().unwrap_or(path),
                    now,
                )?;
                if receipt.state == RevisionState::Quarantined {
                    let inspected = registry.inspect(
                        &receipt.revision_id,
                        self.inspector.as_ref(),
                        POLICY_VERSION,
                        now,
                    )?;
                    receipt.state = inspected.state;
                    receipt.state_reason = inspected.state_reason;
                }
                let mut result = json!({
                    "packageId": receipt.package_id,
                    "revisionId": receipt.revision_id,
                    "treeSha256": receipt.tree_sha256,
                    "version": receipt.version,
                    "state": receipt.state.as_str(),
                    "created": receipt.created,
                });
                put_opt(&mut result, "stateReason", receipt.state_reason);
                Ok(result)
            }
            SkillRequest::List {
                cursor,
                limit,
                package_id,
            } => self.list(store, cursor.as_deref(), *limit, package_id.as_deref()),
            SkillRequest::Inspect {
                revision_id,
                workspace_id,
            } => self.inspect(store, revision_id, workspace_id.as_deref(), now),
            SkillRequest::Review {
                revision_id,
                tree_sha256,
                principal,
                decision,
                note,
            } => {
                self.refuse_builtin(store, revision_id)?;
                let decision = match decision {
                    ReviewDecision::Accept => CoreDecision::Accept,
                    ReviewDecision::Reject => CoreDecision::Reject,
                };
                let receipt = self.registry(store).review(
                    &ReviewRequest {
                        revision_id,
                        shown_tree_sha256: tree_sha256,
                        principal,
                        decision,
                        note: note.as_deref(),
                    },
                    &ctx,
                    now,
                )?;
                let mut result = json!({
                    "revisionId": revision_id,
                    "decision": decision.as_str(),
                    "state": receipt.state.as_str(),
                    "reviewId": receipt.review_id,
                });
                put_opt(&mut result, "stateReason", receipt.state_reason);
                Ok(result)
            }
            SkillRequest::Approve {
                revision_id,
                tree_sha256,
                permission_digest,
                principal,
                workspace_id,
                expires_at,
            } => {
                self.refuse_builtin(store, revision_id)?;
                let expires_at_ms = match expires_at {
                    Some(text) => parse_utc(text).ok_or(SkillError::Denied("expiry_invalid"))?,
                    None => now + DEFAULT_APPROVAL_TTL_MS,
                };
                let mut registry = self.registry(store);
                let approval_id = registry.approve(
                    &ApprovalRequest {
                        revision_id,
                        shown_tree_sha256: tree_sha256,
                        shown_permission_digest: permission_digest,
                        workspace_id: workspace_id.as_deref(),
                        approver: principal,
                        expires_at_ms,
                    },
                    &ctx,
                    now,
                )?;
                let state = registry.revision(revision_id)?.state;
                Ok(json!({
                    "approvalId": approval_id,
                    "revisionId": revision_id,
                    "state": state.as_str(),
                    "expiresAt": format_utc(expires_at_ms),
                }))
            }
            SkillRequest::Activate {
                revision_id,
                approval_id,
            } => {
                self.refuse_builtin(store, revision_id)?;
                let approval_id = i64::try_from(*approval_id).map_err(|_| SkillError::NotFound)?;
                let mut registry = self.registry(store);
                let activation = registry.activate(revision_id, approval_id, &ctx, now)?;
                activation_value(&mut registry, activation)
            }
            SkillRequest::Deactivate { package_id } => {
                let mut registry = self.registry(store);
                let current = registry.active(package_id)?.ok_or(SkillError::NotFound)?;
                registry.deactivate(package_id, "user-request", now)?;
                let state = registry.revision(&current.revision_id)?.state;
                Ok(json!({
                    "packageId": package_id,
                    "revisionId": current.revision_id,
                    "state": state.as_str(),
                    "indexGeneration": registry.index_generation()?,
                }))
            }
            SkillRequest::Rollback {
                package_id,
                revision_id,
            } => {
                let mut registry = self.registry(store);
                let activation = registry.rollback(package_id, revision_id, &ctx, now)?;
                activation_value(&mut registry, activation)
            }
            SkillRequest::Revoke { revision_id } => {
                self.refuse_builtin(store, revision_id)?;
                let mut registry = self.registry(store);
                registry.revoke(revision_id, "user-revoked", now)?;
                let state = registry.revision(revision_id)?.state;
                Ok(json!({
                    "revisionId": revision_id,
                    "state": state.as_str(),
                    "indexGeneration": registry.index_generation()?,
                }))
            }
            SkillRequest::Scanner => Ok(self.scanner()),
            SkillRequest::Read { revision_id, path } => {
                // A built-in skill holds exactly these bytes; otherwise only the package's
                // active revision is readable.
                let (package_id, entry, bytes) = if let Some(skill) =
                    self.builtins.by_revision(revision_id)
                {
                    let package_id = skill.package_id.clone();
                    let (entry, bytes) = self.builtins.read_file(store, revision_id, path, now)?;
                    (package_id, entry, bytes)
                } else {
                    let file =
                        self.registry(store)
                            .read_revision_file(revision_id, path, &ctx, now)?;
                    (file.package_id, file.entry, file.bytes)
                };
                if entry.size > SKILL_READ_MAX_BYTES {
                    return Err(SkillError::Denied("file_too_large_to_read"));
                }
                let content = String::from_utf8(bytes)
                    .ok()
                    .filter(|text| {
                        text.chars().all(|character| {
                            matches!(character, '\t' | '\n' | '\r')
                                || (character as u32 >= 32 && character as u32 != 127)
                        })
                    })
                    .ok_or(SkillError::Denied("binary_content"))?;
                Ok(json!({
                    "revisionId": revision_id,
                    "packageId": package_id,
                    "path": path,
                    "size": entry.size,
                    "sha256": entry.sha256,
                    "content": content,
                }))
            }
        }
    }

    /// The package directory below the import inbox, refused when it resolves outside it.
    fn resolve_import(&self, path: &str) -> Result<PathBuf, SkillError> {
        let inbox = self.import_inbox();
        let candidate = inbox.join(path);
        match fs::symlink_metadata(&candidate) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(SkillError::Refused {
                    refusal: Refusal::Symlink,
                    path: None,
                });
            }
            Ok(_) => {}
            Err(_) => return Err(SkillError::NotFound),
        }
        let inbox = fs::canonicalize(&inbox).map_err(|_| SkillError::NotFound)?;
        let resolved = fs::canonicalize(&candidate).map_err(|_| SkillError::NotFound)?;
        if resolved == inbox || !resolved.starts_with(&inbox) {
            return Err(SkillError::Denied("outside_import_root"));
        }
        Ok(resolved)
    }

    /// Built-in skills never enter the lifecycle: approving, activating or revoking one
    /// over the wire is refused (unless the same bytes were also imported).
    fn refuse_builtin(&self, store: &mut CoreStore, revision_id: &str) -> Result<(), SkillError> {
        if self.builtins.by_revision(revision_id).is_some() {
            match self.registry(store).revision(revision_id) {
                Err(SkillError::NotFound) => return Err(SkillError::Denied("builtin")),
                Err(error) => return Err(error),
                Ok(_) => {}
            }
        }
        Ok(())
    }

    fn list(
        &mut self,
        store: &mut CoreStore,
        cursor: Option<&str>,
        limit: Option<u64>,
        package_id: Option<&str>,
    ) -> Result<Value, SkillError> {
        let limit = limit
            .unwrap_or(LIST_DEFAULT_LIMIT)
            .clamp(1, SKILL_LIST_MAX_LIMIT) as usize;
        let after = cursor.and_then(|cursor| cursor.split_once('/'));
        let mut registry = self.registry(store);
        // One more than the page shows tells whether another page exists.
        let stored = registry.list(after, package_id, limit + 1)?;
        let index_generation = registry.index_generation()?;
        let mut entries: Vec<((String, String), Value)> = stored
            .into_iter()
            .map(|summary| {
                let key = (
                    summary.revision.package_id.clone(),
                    summary.revision.revision_id.clone(),
                );
                (key, summary_value(&summary))
            })
            .collect();
        entries.extend(
            self.builtins
                .iter()
                .filter(|skill| package_id.is_none_or(|id| id == skill.package_id))
                .map(|skill| {
                    (
                        (skill.package_id.clone(), skill.revision_id.clone()),
                        builtin_value(skill),
                    )
                })
                .filter(|(key, _)| {
                    after.is_none_or(|(package, revision)| {
                        (key.0.as_str(), key.1.as_str()) > (package, revision)
                    })
                }),
        );
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut page = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for (index, (key, value)) in entries.into_iter().enumerate() {
            let size = serde_json::to_vec(&value).map_or(usize::MAX, |json| json.len());
            if index >= limit || (!page.is_empty() && bytes + size > LIST_BYTE_BUDGET) {
                more = true;
                break;
            }
            bytes += size;
            page.push((key, value));
        }
        let next = more.then(|| {
            let (package, revision) = &page.last().expect("a page has an entry").0;
            format!("{package}/{revision}")
        });
        let mut result = json!({
            "revisions": page.into_iter().map(|(_, value)| value).collect::<Vec<_>>(),
            "indexGeneration": index_generation,
        });
        put_opt(&mut result, "nextCursor", next);
        Ok(result)
    }

    fn inspect(
        &mut self,
        store: &mut CoreStore,
        revision_id: &str,
        workspace_id: Option<&str>,
        now: i64,
    ) -> Result<Value, SkillError> {
        let mut registry = self.registry(store);
        let details = match registry.details(revision_id) {
            Err(SkillError::NotFound) => {
                let skill = self
                    .builtins
                    .by_revision(revision_id)
                    .ok_or(SkillError::NotFound)?;
                return Ok(json!({
                    "revision": builtin_value(skill),
                    "manifest": skill.manifest_json,
                    "files": skill.tree.files.iter().map(file_value).collect::<Vec<_>>(),
                    "inspections": [],
                    "approvals": [],
                    "history": [],
                    "consent": [],
                }));
            }
            other => other?,
        };
        if let Some(workspace) = workspace_id {
            let entries = read_consent(&self.data_dir, workspace);
            let inputs = registry.consent_inputs(&entries, Some(revision_id))?;
            // Stored as review input (ADR 0025 §7); never a decision.
            registry.record_consent_inputs(workspace, &inputs, now)?;
        }
        // Every stored input of the revision, newest last: consent recorded for any workspace
        // stays visible to the reviewer.
        let inputs = registry.review_inputs(revision_id)?;
        let skip = inputs.len().saturating_sub(MAX_CONSENT_INPUTS);
        let mut value = details_value(&details);
        value["consent"] = inputs
            .into_iter()
            .skip(skip)
            .map(|input| {
                let mut entry = json!({ "path": SKILL_FILE, "sha256": input.consent_sha256 });
                put_opt(
                    &mut entry,
                    "allowedAt",
                    input.allowed_at.filter(|at| parse_utc(at).is_some()),
                );
                // A row of schema 4 may hold an id the contract does not admit; it is shown
                // without its workspace rather than failing the whole inspection.
                put_opt(
                    &mut entry,
                    "workspaceId",
                    Some(input.workspace_id).filter(|id| is_workspace_id(id)),
                );
                entry
            })
            .collect();
        Ok(value)
    }
}

/// `<data>/workspaces/<id>/skill-consent.json` (W0), bounded; a missing, linked, oversize
/// or unreadable file is no consent.
fn read_consent(data_dir: &Path, workspace_id: &str) -> Vec<consent::ConsentEntry> {
    let file = data_dir
        .join("workspaces")
        .join(workspace_id)
        .join("skill-consent.json");
    let Ok(meta) = fs::symlink_metadata(&file) else {
        return Vec::new();
    };
    if !meta.file_type().is_file() || meta.len() > MAX_CONSENT_BYTES as u64 {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    let read = fs::File::open(&file).and_then(|handle| {
        handle
            .take(MAX_CONSENT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
    });
    if read.is_err() {
        return Vec::new();
    }
    // The workspace's project folder is not known here; the input is informational and
    // matched by the exact SKILL.md hash.
    consent::parse(&bytes, None)
}

fn put_opt(object: &mut Value, key: &str, value: Option<String>) {
    if let (Some(value), Some(map)) = (value, object.as_object_mut()) {
        map.insert(key.to_owned(), value.into());
    }
}

fn permissions_value(permissions: &Permissions) -> Value {
    permissions
        .entries()
        .into_iter()
        .map(|(capability, scope)| json!({ "capability": capability.as_str(), "scope": scope }))
        .collect()
}

fn summary_value(summary: &RevisionSummary) -> Value {
    let revision = &summary.revision;
    let mut value = json!({
        "packageId": revision.package_id,
        "revisionId": revision.revision_id,
        "origin": summary.origin,
        "version": revision.version,
        "treeSha256": revision.tree_sha256,
        "skillMdSha256": revision.skill_md_sha256,
        "state": revision.state.as_str(),
        "riskClass": revision.risk_class.as_str(),
        "manifestInferred": revision.manifest_inferred,
        "permissionDigest": revision.permission_digest,
        "permissions": permissions_value(&revision.permissions),
        "active": summary.active,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
    });
    put_opt(&mut value, "stateReason", revision.state_reason.clone());
    value
}

fn builtin_value(skill: &BuiltinSkill) -> Value {
    json!({
        "packageId": skill.package_id,
        "revisionId": skill.revision_id,
        "origin": BUILTIN_ORIGIN,
        "version": skill.version,
        "treeSha256": skill.tree.sha256,
        "skillMdSha256": skill.skill_md_sha256,
        "state": RevisionState::Active.as_str(),
        "stateReason": "builtin",
        "riskClass": skill.risk_class.as_str(),
        "manifestInferred": skill.manifest_inferred,
        "permissionDigest": skill.permission_digest,
        "permissions": permissions_value(&skill.permissions),
        "active": true,
        "createdAt": skill.registered_at,
        "updatedAt": skill.registered_at,
    })
}

fn file_value(file: &TreeFile) -> Value {
    json!({
        "path": file.path,
        "size": file.size,
        "sha256": file.sha256,
        "executable": file.executable,
    })
}

fn details_value(details: &RevisionDetails) -> Value {
    let inspections: Vec<Value> = details
        .inspections
        .iter()
        .map(|row| {
            let mut value = json!({
                "inspectionId": row.inspection_id,
                "scannerId": row.scanner_id,
                "policyVersion": row.policy_version,
                "outcome": row.outcome,
                "coverage": row.coverage,
                "startedAt": row.started_at,
                "finishedAt": row.finished_at,
            });
            put_opt(&mut value, "scannerPin", row.scanner_pin.clone());
            put_opt(&mut value, "scannerVersion", row.scanner_version.clone());
            put_opt(&mut value, "verdict", row.verdict.clone());
            value
        })
        .collect();
    let approvals: Vec<Value> = details
        .approvals
        .iter()
        .map(|row| {
            let mut value = json!({
                "approvalId": row.approval_id,
                "kind": row.kind,
                "approver": row.approver,
                "status": row.status,
                "permissionDigest": row.permission_digest,
                "createdAt": row.created_at,
                "expiresAt": row.expires_at,
            });
            put_opt(&mut value, "workspaceId", row.workspace_id.clone());
            put_opt(&mut value, "revokedAt", row.revoked_at.clone());
            value
        })
        .collect();
    let history: Vec<Value> = details
        .history
        .iter()
        .map(|event| {
            let mut value = json!({
                "seq": event.seq,
                "toState": event.to_state.as_str(),
                "at": event.at,
            });
            put_opt(
                &mut value,
                "fromState",
                event.from_state.map(|state| state.as_str().to_owned()),
            );
            put_opt(&mut value, "reason", event.reason.clone());
            value
        })
        .collect();
    json!({
        "revision": summary_value(&details.summary),
        "manifest": details.summary.revision.manifest_json,
        "files": details.files.iter().map(file_value).collect::<Vec<_>>(),
        "inspections": inspections,
        "approvals": approvals,
        "history": history,
        "consent": [],
    })
}

fn activation_value(
    registry: &mut SkillRegistry<'_>,
    activation: extalia_core::skills::registry::Activation,
) -> Result<Value, SkillError> {
    Ok(json!({
        "packageId": activation.package_id,
        "revisionId": activation.revision_id,
        "approvalId": activation.approval_id,
        "activatedAt": activation.activated_at,
        "indexGeneration": registry.index_generation()?,
    }))
}

/// Stable wire code and reason of a registry failure.
pub fn refusal(error: &SkillError) -> SkillRefusal {
    match error {
        SkillError::Refused {
            refusal: Refusal::NotADirectory,
            ..
        } => (ErrorCode::NotFound, Some("not_a_directory")),
        SkillError::Refused { refusal, .. } => (ErrorCode::Denied, Some(refusal.as_str())),
        SkillError::Manifest(_) => (ErrorCode::Denied, Some("manifest_invalid")),
        SkillError::NotFound => (ErrorCode::NotFound, None),
        SkillError::InvalidTransition { .. } | SkillError::WrongState(_) => {
            (ErrorCode::Conflict, Some("wrong_state"))
        }
        SkillError::Integrity => (ErrorCode::IntegrityFailure, Some("integrity")),
        SkillError::Denied(
            reason @ ("digest_mismatch"
            | "permission_digest_mismatch"
            | "approval_mismatch"
            | "version_reuse"),
        ) => (ErrorCode::Conflict, Some(reason)),
        SkillError::Denied(reason) => (ErrorCode::Denied, Some(reason)),
        SkillError::InvalidProfile => (ErrorCode::Internal, None),
        SkillError::Corrupt(_) | SkillError::Io(_) | SkillError::Sqlite(_) => {
            (ErrorCode::StorageFailure, None)
        }
    }
}
