//! The skill registry on the core store (ADR 0025 §3–§8). A [`SkillRegistry`] is bound to
//! one profile: every query is scoped by that profile id and every object lives under
//! that profile's store, so rows and objects of another profile are never read
//! (ADR 0024). Each state change runs in one `BEGIN IMMEDIATE` transaction together with
//! its append-only audit row; the activation pointer, its history row and the index
//! generation change together.
//!
//! The flow of a revision is `import` → `inspect` → `validate` (or, after a medium finding,
//! a human `review`, see [`super::review`]) → `record_evaluation` →
//! `decide` → `approve` / `approve_auto` → `activate`, then `deactivate`, `rollback` or
//! `revoke`. In this slice the only inspector is `UnavailableInspector`, so `inspect`
//! leaves every package `quarantined` with reason `scanner-unavailable`. Dependency,
//! conflict and compatibility resolution are not built yet: `validate` refuses a revision
//! that declares any (`resolver_unavailable`) instead of skipping the check.
//!
//! Approval expiry (ADR 0026 defaults, see [`policy::DEFAULT_APPROVAL_TTL_MS`]): an approval
//! expires 10 minutes after it is granted unless the caller asks for another expiry, at most
//! [`policy::MAX_APPROVAL_TTL_MS`]. The expiry bounds the window for the revision's first
//! activation. Once an approval has activated its revision (a row in the append-only
//! activation history), it stays the authority for re-activating that same revision
//! (rollback, activation after a deactivation) until it is revoked; the attestation and the
//! bytes are still re-checked every time.
//!
//! [`SkillRegistry::recover_interrupted`] runs when the store is opened: a revision left
//! `inspecting` by a crash goes back to `quarantined` (`inspection-interrupted`); the scan is
//! never replayed implicitly.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use super::inspect::{
    Coverage, InspectionOutcome, InspectionRequest, ScannerIdentity, Severity, SkillInspector,
};
use super::lifecycle::RevisionState;
use super::manifest::{self, Capability, MANIFEST_FILE, Permissions, RiskClass, SKILL_FILE};
use super::policy::{self, Disposition, EvaluationResult, POLICY_VERSION, Route};
use super::tree::{ObjectStore, StagingLimits, Tree};
use super::{Origin, ProfileId, Refusal, SkillError, is_workspace_id, refused};
use crate::adapters::sqlite::CoreStore;
use crate::time::{format_utc, parse_utc};

/// The current scanner identity and policy version every attestation must match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyContext {
    pub scanner: ScannerIdentity,
    pub policy_version: String,
}

impl PolicyContext {
    /// The installed inspector with this build's [`POLICY_VERSION`].
    pub fn current(inspector: &dyn SkillInspector) -> Self {
        Self {
            scanner: inspector.identity(),
            policy_version: POLICY_VERSION.to_owned(),
        }
    }
}

/// Profile-level settings for hybrid activation (ADR 0026 §3). Default: nothing
/// pre-authorized and auto-activation off.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProfileGrants {
    pub preauthorized: Permissions,
    pub auto_activation: bool,
}

/// What [`SkillRegistry::import`] recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReceipt {
    pub package_id: String,
    pub revision_id: String,
    pub tree_sha256: String,
    pub version: String,
    pub state: RevisionState,
    pub state_reason: Option<String>,
    /// False when the same bytes were already a revision of this profile.
    pub created: bool,
}

/// A stored revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub revision_id: String,
    pub package_id: String,
    pub version: String,
    pub tree_sha256: String,
    pub skill_md_sha256: String,
    pub manifest_json: String,
    pub manifest_inferred: bool,
    pub risk_class: RiskClass,
    pub permissions: Permissions,
    pub permission_digest: String,
    pub state: RevisionState,
    pub state_reason: Option<String>,
}

/// What [`SkillRegistry::inspect`] recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectionReceipt {
    pub inspection_id: i64,
    pub outcome: &'static str,
    pub state: RevisionState,
    pub state_reason: Option<String>,
}

/// A user's approval, carrying the digests the UI showed (hash point e).
#[derive(Debug, Clone, Copy)]
pub struct ApprovalRequest<'a> {
    pub revision_id: &'a str,
    pub shown_tree_sha256: &'a str,
    pub shown_permission_digest: &'a str,
    pub workspace_id: Option<&'a str>,
    /// The local user principal, `user:<id>`; nothing else may approve.
    pub approver: &'a str,
    pub expires_at_ms: i64,
}

/// The activation pointer of a package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activation {
    pub package_id: String,
    pub revision_id: String,
    pub approval_id: i64,
    pub activated_at: String,
}

/// One row of the append-only activation history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationEvent {
    pub seq: i64,
    pub action: String,
    pub from_revision_id: Option<String>,
    pub to_revision_id: Option<String>,
    pub approval_id: Option<i64>,
    pub reason: Option<String>,
}

/// The registry of one profile.
#[derive(Debug)]
pub struct SkillRegistry<'s> {
    store: &'s mut CoreStore,
    objects: ObjectStore,
    profile: ProfileId,
    limits: StagingLimits,
}

const LONG_TEXT: usize = 512;

impl<'s> SkillRegistry<'s> {
    /// `data_dir` is the directory that holds `state/core.sqlite`.
    pub fn new(store: &'s mut CoreStore, data_dir: &Path, profile: ProfileId) -> Self {
        Self {
            store,
            objects: ObjectStore::new(data_dir, &profile),
            profile,
            limits: StagingLimits::default(),
        }
    }

    pub fn with_limits(mut self, limits: StagingLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    pub fn object_store(&self) -> &ObjectStore {
        &self.objects
    }

    pub(super) fn conn(&mut self) -> &mut Connection {
        self.store.connection()
    }

    /// Stage `source` into quarantine and record it as a `quarantined` revision. The
    /// manifest and `SKILL.md` are read from the staged object, never from the source.
    /// Importing the same bytes again returns the existing revision unchanged.
    pub fn import(
        &mut self,
        source: &Path,
        origin: Origin,
        source_ref: &str,
        now_ms: i64,
    ) -> Result<ImportReceipt, SkillError> {
        if source_ref.len() > LONG_TEXT {
            return Err(SkillError::Denied("source_ref_too_long"));
        }
        let tree = self.objects.stage(source, &self.limits)?;
        let skill_md_entry = tree
            .file(SKILL_FILE)
            .ok_or_else(|| refused(Refusal::MissingSkillMd, None))?;
        let skill_md = self
            .objects
            .read_file(&tree.sha256, SKILL_FILE, skill_md_entry)?;
        let manifest_bytes = match tree.file(MANIFEST_FILE) {
            Some(entry) => Some(self.objects.read_file(&tree.sha256, MANIFEST_FILE, entry)?),
            None => None,
        };
        let package = manifest::resolve(&tree, manifest_bytes.as_deref(), &skill_md)?;
        let manifest = &package.manifest;
        let revision_id = format!("skr_{}", tree.sha256);
        let at = format_utc(now_ms);
        let profile = self.profile.as_str().to_owned();

        let tx = immediate(self.conn())?;
        if let Some(existing) = load_revision(&tx, &profile, &revision_id).optional_found()? {
            if existing.package_id != manifest.id {
                return Err(SkillError::Corrupt("revision package"));
            }
            return Ok(receipt(existing, false));
        }
        tx.execute(
            "INSERT OR IGNORE INTO skill_packages (profile_id, package_id, origin, source_ref, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![profile, manifest.id, origin.as_str(), source_ref, at],
        )?;
        tx.execute(
            "INSERT INTO skill_revisions (profile_id, revision_id, package_id, version, tree_sha256,
               skill_md_sha256, manifest_json, manifest_inferred, risk_class, permission_digest,
               state, state_reason, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'discovered', NULL, ?11, ?11)",
            params![
                profile,
                revision_id,
                manifest.id,
                manifest.version,
                tree.sha256,
                skill_md_entry.sha256,
                manifest.canonical_json(),
                package.inferred,
                manifest.risk_class.as_str(),
                manifest.permissions.digest(),
                at
            ],
        )?;
        record_state(
            &tx,
            &profile,
            &revision_id,
            None,
            RevisionState::Discovered,
            Some("imported"),
            &at,
        )?;
        insert_details(&tx, &profile, &revision_id, &tree, manifest)?;
        set_state(
            &tx,
            &profile,
            &revision_id,
            RevisionState::Discovered,
            RevisionState::Quarantined,
            Some("awaiting-inspection"),
            &at,
        )?;
        if version_reused(&tx, &profile, &manifest.id, &manifest.version, &revision_id)? {
            set_state(
                &tx,
                &profile,
                &revision_id,
                RevisionState::Quarantined,
                RevisionState::Blocked,
                Some("version_reuse"),
                &at,
            )?;
        }
        let stored = load_revision(&tx, &profile, &revision_id)?;
        tx.commit()?;
        Ok(receipt(stored, true))
    }

    /// The revision, if it belongs to this profile.
    pub fn revision(&mut self, revision_id: &str) -> Result<Revision, SkillError> {
        let profile = self.profile.as_str().to_owned();
        load_revision(self.conn(), &profile, revision_id)
    }

    /// Run the inspector on a `quarantined` revision (or resume an interrupted
    /// `inspecting` one), hashing the object before (b) and after (c) the scan, and apply
    /// the verdict mapping. Every failure keeps the revision quarantined.
    pub fn inspect(
        &mut self,
        revision_id: &str,
        inspector: &dyn SkillInspector,
        policy_version: &str,
        now_ms: i64,
    ) -> Result<InspectionReceipt, SkillError> {
        let revision = self.revision(revision_id)?;
        if !matches!(
            revision.state,
            RevisionState::Quarantined | RevisionState::Inspecting
        ) {
            return Err(SkillError::WrongState(revision.state));
        }
        let identity = inspector.identity();
        if !identity_fits(&identity) || policy_version.is_empty() || policy_version.len() > 128 {
            return Err(SkillError::Denied("scanner_identity_invalid"));
        }
        let profile = self.profile.as_str().to_owned();
        let started = format_utc(now_ms);
        // Hash point (b): before the scan.
        self.verify_or_revoke(&revision, now_ms)?;
        if revision.state == RevisionState::Quarantined {
            let tx = immediate(self.conn())?;
            set_state(
                &tx,
                &profile,
                revision_id,
                RevisionState::Quarantined,
                RevisionState::Inspecting,
                Some("scan-started"),
                &started,
            )?;
            tx.commit()?;
        }
        let object_dir = self.objects.object_dir(&revision.tree_sha256);
        // An unpinned scanner is never run and never attests (ADR 0023 §1–§2).
        let mut outcome = if identity.pin.is_none() {
            InspectionOutcome::Failed(super::inspect::Failure::ScannerUnavailable)
        } else {
            inspector.inspect(&InspectionRequest {
                revision_id,
                tree_sha256: &revision.tree_sha256,
                object_dir: &object_dir,
                policy_version,
            })
        };
        if let InspectionOutcome::Completed {
            report_ref: Some(report),
            ..
        } = &outcome
            && (report.is_empty() || report.len() > LONG_TEXT)
        {
            outcome = InspectionOutcome::Failed(super::inspect::Failure::InvalidOutput);
        }
        // Hash point (c): after the scan.
        let intact = match self.objects.verify(&revision.tree_sha256, &self.limits) {
            Ok(_) => true,
            Err(SkillError::Integrity) => false,
            Err(error) => return Err(error),
        };
        let tx = immediate(self.conn())?;
        let (code, coverage, verdict, report_ref) = match (&outcome, intact) {
            (_, false) => ("integrity", Coverage::None, None, None),
            (InspectionOutcome::Failed(failure), true) => {
                (failure.as_str(), Coverage::None, None, None)
            }
            (
                InspectionOutcome::Completed {
                    verdict,
                    coverage,
                    report_ref,
                },
                true,
            ) => ("completed", *coverage, Some(*verdict), report_ref.clone()),
        };
        tx.execute(
            "INSERT INTO skill_inspections (profile_id, revision_id, tree_sha256, scanner_id,
               scanner_pin, scanner_version, normalizer_version, policy_version, outcome, coverage,
               verdict, report_ref, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                profile,
                revision_id,
                revision.tree_sha256,
                identity.id,
                identity.pin,
                identity.version,
                identity.normalizer_version,
                policy_version,
                code,
                coverage.as_str(),
                verdict.map(Severity::as_str),
                report_ref,
                started,
                format_utc(now_ms)
            ],
        )?;
        let inspection_id = tx.last_insert_rowid();
        if !intact {
            revoke_in_tx(&tx, &profile, revision_id, "integrity", &format_utc(now_ms))?;
            tx.commit()?;
            return Err(SkillError::Integrity);
        }
        let at = format_utc(now_ms);
        let (next, reason) = match policy::disposition(&outcome) {
            Disposition::Quarantine(reason) => (RevisionState::Quarantined, Some(reason)),
            Disposition::Block(reason) => (RevisionState::Blocked, Some(reason)),
            Disposition::Review => (RevisionState::ReviewRequired, Some("finding-medium")),
            Disposition::Pass { conditional: true } => {
                (RevisionState::Inspected, Some("finding-low"))
            }
            Disposition::Pass { conditional: false } => (RevisionState::Inspected, None),
        };
        set_state(
            &tx,
            &profile,
            revision_id,
            RevisionState::Inspecting,
            next,
            reason,
            &at,
        )?;
        tx.commit()?;
        Ok(InspectionReceipt {
            inspection_id,
            outcome: outcome.code(),
            state: next,
            state_reason: reason.map(str::to_owned),
        })
    }

    /// `inspected` → `validated`: re-verify the bytes and the attestation; refuse while the
    /// revision declares dependencies, conflicts or compatibility (no resolver yet).
    /// A `review_required` revision is validated only by an accepted human review
    /// ([`SkillRegistry::review`]).
    pub fn validate(
        &mut self,
        revision_id: &str,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<RevisionState, SkillError> {
        let revision = self.require(revision_id, &[RevisionState::Inspected])?;
        self.verify_or_revoke(&revision, now_ms)?;
        self.require_attestation(&revision, ctx, now_ms)?;
        self.require_resolvable(revision_id)?;
        let profile = self.profile.as_str().to_owned();
        let tx = immediate(self.conn())?;
        set_state(
            &tx,
            &profile,
            revision_id,
            RevisionState::Inspected,
            RevisionState::Validated,
            None,
            &format_utc(now_ms),
        )?;
        tx.commit()?;
        Ok(RevisionState::Validated)
    }

    /// Record an evaluation result for a `validated` revision (hash point d before it is
    /// recorded). The sandbox itself (FR-22) is not built yet; the core, not the worker,
    /// writes the row. `passed` → `evaluated`; `failed` → `blocked`; `insufficient_evidence`
    /// leaves it `validated`.
    pub fn record_evaluation(
        &mut self,
        revision_id: &str,
        result: EvaluationResult,
        baseline_revision_id: Option<&str>,
        evidence_ref: Option<&str>,
        now_ms: i64,
    ) -> Result<RevisionState, SkillError> {
        let revision = self.require(revision_id, &[RevisionState::Validated])?;
        if evidence_ref.is_some_and(|text| text.is_empty() || text.len() > LONG_TEXT) {
            return Err(SkillError::Denied("evidence_ref_invalid"));
        }
        self.verify_or_revoke(&revision, now_ms)?;
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        if let Some(baseline) = baseline_revision_id {
            load_revision(&tx, &profile, baseline)?;
        }
        tx.execute(
            "INSERT INTO skill_evaluations (profile_id, revision_id, tree_sha256, baseline_revision_id,
               result, evidence_ref, evaluated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                profile,
                revision_id,
                revision.tree_sha256,
                baseline_revision_id,
                result.as_str(),
                evidence_ref,
                at
            ],
        )?;
        let state = match result {
            EvaluationResult::Passed => {
                set_state(
                    &tx,
                    &profile,
                    revision_id,
                    RevisionState::Validated,
                    RevisionState::Evaluating,
                    None,
                    &at,
                )?;
                set_state(
                    &tx,
                    &profile,
                    revision_id,
                    RevisionState::Evaluating,
                    RevisionState::Evaluated,
                    None,
                    &at,
                )?;
                RevisionState::Evaluated
            }
            EvaluationResult::Failed => {
                set_state(
                    &tx,
                    &profile,
                    revision_id,
                    RevisionState::Validated,
                    RevisionState::Blocked,
                    Some("evaluation-failed"),
                    &at,
                )?;
                RevisionState::Blocked
            }
            EvaluationResult::InsufficientEvidence => RevisionState::Validated,
        };
        tx.commit()?;
        Ok(state)
    }

    /// Apply the policy to an `evaluated` revision: `auto_eligible` or `awaiting_approval`
    /// (the first reason is recorded as the state reason).
    pub fn decide(
        &mut self,
        revision_id: &str,
        ctx: &PolicyContext,
        grants: &ProfileGrants,
        now_ms: i64,
    ) -> Result<Route, SkillError> {
        let revision = self.require(revision_id, &[RevisionState::Evaluated])?;
        self.verify_or_revoke(&revision, now_ms)?;
        let inspection = self.require_attestation(&revision, ctx, now_ms)?;
        let route = self.route(&revision, &inspection, grants)?;
        let (next, reason) = match &route {
            Route::AutoEligible => (RevisionState::AutoEligible, None),
            Route::AwaitingApproval(reasons) => {
                (RevisionState::AwaitingApproval, reasons.first().copied())
            }
        };
        let profile = self.profile.as_str().to_owned();
        let tx = immediate(self.conn())?;
        set_state(
            &tx,
            &profile,
            revision_id,
            RevisionState::Evaluated,
            next,
            reason,
            &format_utc(now_ms),
        )?;
        tx.commit()?;
        Ok(route)
    }

    /// Record a user's approval bound to the revision, its tree hash, its attestation, its
    /// permission digest, an optional workspace scope and an expiry. The digests the UI
    /// showed must equal the stored ones and the bytes are re-hashed (hash point e).
    pub fn approve(
        &mut self,
        request: &ApprovalRequest<'_>,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<i64, SkillError> {
        let revision = self.require(
            request.revision_id,
            &[RevisionState::AwaitingApproval, RevisionState::AutoEligible],
        )?;
        let principal = request.approver.strip_prefix("user:").unwrap_or_default();
        if principal.is_empty() || request.approver.len() > 128 {
            return Err(SkillError::Denied("approver_invalid"));
        }
        if request.shown_tree_sha256 != revision.tree_sha256 {
            return Err(SkillError::Denied("digest_mismatch"));
        }
        if request.shown_permission_digest != revision.permission_digest {
            return Err(SkillError::Denied("permission_digest_mismatch"));
        }
        if request.workspace_id.is_some_and(|id| !is_workspace_id(id)) {
            return Err(SkillError::Denied("workspace_invalid"));
        }
        self.grant(
            &revision,
            "user",
            request.approver,
            request.workspace_id,
            request.expires_at_ms,
            ctx,
            now_ms,
        )
    }

    /// Record the policy's own approval for an `auto_eligible` revision after re-checking
    /// the route; if it no longer holds the revision moves to `awaiting_approval`.
    pub fn approve_auto(
        &mut self,
        revision_id: &str,
        ctx: &PolicyContext,
        grants: &ProfileGrants,
        expires_at_ms: i64,
        now_ms: i64,
    ) -> Result<i64, SkillError> {
        let revision = self.require(revision_id, &[RevisionState::AutoEligible])?;
        self.verify_or_revoke(&revision, now_ms)?;
        let inspection = self.require_attestation(&revision, ctx, now_ms)?;
        if let Route::AwaitingApproval(reasons) = self.route(&revision, &inspection, grants)? {
            let profile = self.profile.as_str().to_owned();
            let tx = immediate(self.conn())?;
            set_state(
                &tx,
                &profile,
                revision_id,
                RevisionState::AutoEligible,
                RevisionState::AwaitingApproval,
                reasons.first().copied(),
                &format_utc(now_ms),
            )?;
            tx.commit()?;
            return Err(SkillError::Denied("not_auto_eligible"));
        }
        self.grant(
            &revision,
            "auto",
            "policy:auto",
            None,
            expires_at_ms,
            ctx,
            now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn grant(
        &mut self,
        revision: &Revision,
        kind: &str,
        approver: &str,
        workspace_id: Option<&str>,
        expires_at_ms: i64,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<i64, SkillError> {
        if expires_at_ms <= now_ms {
            return Err(SkillError::Denied("approval_expired"));
        }
        if expires_at_ms - now_ms > policy::MAX_APPROVAL_TTL_MS {
            return Err(SkillError::Denied("approval_expiry_too_far"));
        }
        // Hash point (e): the approved digest is the stored object's.
        self.verify_or_revoke(revision, now_ms)?;
        let inspection = self.require_attestation(revision, ctx, now_ms)?;
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        if version_reused(
            &tx,
            &profile,
            &revision.package_id,
            &revision.version,
            &revision.revision_id,
        )? {
            set_state(
                &tx,
                &profile,
                &revision.revision_id,
                revision.state,
                RevisionState::Blocked,
                Some("version_reuse"),
                &at,
            )?;
            tx.commit()?;
            return Err(SkillError::Denied("version_reuse"));
        }
        tx.execute(
            "INSERT INTO skill_approvals (profile_id, revision_id, tree_sha256, inspection_id,
               workspace_id, permission_digest, kind, approver, status, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'granted', ?9, ?10)",
            params![
                profile,
                revision.revision_id,
                revision.tree_sha256,
                inspection.id,
                workspace_id,
                revision.permission_digest,
                kind,
                approver,
                at,
                format_utc(expires_at_ms)
            ],
        )?;
        let approval_id = tx.last_insert_rowid();
        set_state(
            &tx,
            &profile,
            &revision.revision_id,
            revision.state,
            RevisionState::Approved,
            None,
            &at,
        )?;
        tx.commit()?;
        Ok(approval_id)
    }

    /// Point the package at an `approved` revision. Inside one transaction: the approval
    /// must be granted, unexpired and bound to this revision's hash and permission digest;
    /// its attestation must still hold; the object is re-hashed (hash point f). The previous
    /// active revision becomes `superseded`.
    pub fn activate(
        &mut self,
        revision_id: &str,
        approval_id: i64,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<Activation, SkillError> {
        self.switch(
            revision_id,
            approval_id,
            "activate",
            RevisionState::Approved,
            ctx,
            now_ms,
        )
    }

    /// Re-point the package to a `superseded` revision that was active before, with the
    /// approval it was last activated with and the same checks as [`Self::activate`].
    pub fn rollback(
        &mut self,
        package_id: &str,
        to_revision_id: &str,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<Activation, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let approval_id: Option<i64> = self
            .conn()
            .query_row(
                "SELECT approval_id FROM skill_activation_events
                 WHERE profile_id = ?1 AND package_id = ?2 AND to_revision_id = ?3
                 ORDER BY event_seq DESC LIMIT 1",
                params![profile, package_id, to_revision_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(approval_id) = approval_id else {
            return Err(SkillError::Denied("not_previously_active"));
        };
        self.switch(
            to_revision_id,
            approval_id,
            "rollback",
            RevisionState::Superseded,
            ctx,
            now_ms,
        )
    }

    fn switch(
        &mut self,
        revision_id: &str,
        approval_id: i64,
        action: &str,
        required: RevisionState,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<Activation, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now_ms);
        let outcome = {
            let objects = &self.objects;
            let limits = self.limits;
            let tx = immediate(self.store.connection())?;
            let revision = load_revision(&tx, &profile, revision_id)?;
            if revision.state != required {
                return Err(SkillError::WrongState(revision.state));
            }
            let approval = load_approval(&tx, &profile, approval_id)?;
            let consumed = approval_consumed(&tx, &profile, &revision, approval_id)?;
            check_approval(&approval, &revision, now_ms, consumed)?;
            let inspection = load_inspection(&tx, &profile, approval.inspection_id)?
                .ok_or(SkillError::Corrupt("approval inspection"))?;
            match attestation(&inspection, &revision, ctx) {
                Err(reason) => Err(reason),
                Ok(()) => {
                    // Hash point (f): inside the activation transaction.
                    match objects.verify(&revision.tree_sha256, &limits) {
                        Err(SkillError::Integrity) => {
                            drop(tx);
                            return Err(self.integrity_failure(revision_id, now_ms));
                        }
                        Err(error) => return Err(error),
                        Ok(_) => {}
                    }
                    let previous = active_pointer(&tx, &profile, &revision.package_id)?;
                    if let Some(previous) = &previous {
                        let previous_state =
                            load_revision(&tx, &profile, &previous.revision_id)?.state;
                        set_state(
                            &tx,
                            &profile,
                            &previous.revision_id,
                            previous_state,
                            RevisionState::Superseded,
                            Some("superseded"),
                            &at,
                        )?;
                    }
                    tx.execute(
                        "INSERT INTO skill_activations (profile_id, package_id, revision_id, approval_id, activated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT (profile_id, package_id) DO UPDATE SET
                           revision_id = excluded.revision_id, approval_id = excluded.approval_id,
                           activated_at = excluded.activated_at",
                        params![profile, revision.package_id, revision_id, approval_id, at],
                    )?;
                    tx.execute(
                        "INSERT INTO skill_activation_events (profile_id, package_id, action,
                           from_revision_id, to_revision_id, approval_id, reason, at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
                        params![
                            profile,
                            revision.package_id,
                            action,
                            previous.as_ref().map(|previous| &previous.revision_id),
                            revision_id,
                            approval_id,
                            at
                        ],
                    )?;
                    set_state(
                        &tx,
                        &profile,
                        revision_id,
                        required,
                        RevisionState::Active,
                        None,
                        &at,
                    )?;
                    bump_generation(&tx, &profile)?;
                    tx.commit()?;
                    Ok(Activation {
                        package_id: revision.package_id,
                        revision_id: revision_id.to_owned(),
                        approval_id,
                        activated_at: at,
                    })
                }
            }
        };
        match outcome {
            Ok(activation) => Ok(activation),
            Err(reason) => {
                self.requarantine(revision_id, reason, now_ms)?;
                Err(SkillError::Denied(reason))
            }
        }
    }

    /// Clear the package's activation pointer; its revision goes back to `approved`.
    pub fn deactivate(
        &mut self,
        package_id: &str,
        reason: &'static str,
        now_ms: i64,
    ) -> Result<(), SkillError> {
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        let current = active_pointer(&tx, &profile, package_id)?.ok_or(SkillError::NotFound)?;
        let state = load_revision(&tx, &profile, &current.revision_id)?.state;
        set_state(
            &tx,
            &profile,
            &current.revision_id,
            state,
            RevisionState::Approved,
            Some(reason),
            &at,
        )?;
        clear_pointer(
            &tx,
            &profile,
            package_id,
            &current.revision_id,
            "deactivate",
            reason,
            &at,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Revoke a revision (terminal): its approvals are revoked and, if it is active, the
    /// pointer is cleared with a `revoke` history row.
    pub fn revoke(
        &mut self,
        revision_id: &str,
        reason: &'static str,
        now_ms: i64,
    ) -> Result<(), SkillError> {
        let profile = self.profile.as_str().to_owned();
        let tx = immediate(self.conn())?;
        let state = load_revision(&tx, &profile, revision_id)?.state;
        if state.terminal() {
            return Err(SkillError::WrongState(state));
        }
        revoke_in_tx(&tx, &profile, revision_id, reason, &format_utc(now_ms))?;
        tx.commit()?;
        Ok(())
    }

    /// Crash recovery on open: every revision of this profile left `inspecting` (the scan
    /// was interrupted) goes back to `quarantined` with reason `inspection-interrupted`, in
    /// one transaction. Nothing is re-run; a later `inspect` starts a new scan. Returns
    /// the recovered revision ids.
    pub fn recover_interrupted(&mut self, now_ms: i64) -> Result<Vec<String>, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        let ids: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT revision_id FROM skill_revisions
                 WHERE profile_id = ?1 AND state = 'inspecting' ORDER BY revision_id",
            )?;
            statement
                .query_map([&profile], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for id in &ids {
            set_state(
                &tx,
                &profile,
                id,
                RevisionState::Inspecting,
                RevisionState::Quarantined,
                Some("inspection-interrupted"),
                &at,
            )?;
        }
        tx.commit()?;
        Ok(ids)
    }

    /// Mark the package's active revision `deprecated` (ADR 0025 §4: still active until a
    /// newer revision supersedes it or it is deactivated). The activation pointer and the
    /// index generation do not change.
    pub fn deprecate(&mut self, package_id: &str, now_ms: i64) -> Result<String, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let tx = immediate(self.conn())?;
        let pointer = active_pointer(&tx, &profile, package_id)?.ok_or(SkillError::NotFound)?;
        let state = load_revision(&tx, &profile, &pointer.revision_id)?.state;
        if state != RevisionState::Active {
            return Err(SkillError::WrongState(state));
        }
        set_state(
            &tx,
            &profile,
            &pointer.revision_id,
            RevisionState::Active,
            RevisionState::Deprecated,
            Some("deprecated"),
            &format_utc(now_ms),
        )?;
        tx.commit()?;
        Ok(pointer.revision_id)
    }

    /// Move every revision whose attestation no longer holds (scanner pin or version, or
    /// policy version changed) back to `quarantined`; returns their ids.
    pub fn invalidate_stale(
        &mut self,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<Vec<String>, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let ids: Vec<String> = {
            let conn = self.conn();
            let mut statement = conn.prepare(
                "SELECT revision_id FROM skill_revisions WHERE profile_id = ?1 ORDER BY revision_id",
            )?;
            statement
                .query_map([&profile], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut stale = Vec::new();
        for id in ids {
            let revision = self.revision(&id)?;
            if !revision.state.attested() {
                continue;
            }
            let latest = latest_inspection(self.conn(), &profile, &id)?;
            let reason = match latest {
                Some(inspection) => attestation(&inspection, &revision, ctx).err(),
                None => Some("attestation_missing"),
            };
            if let Some(reason) = reason {
                self.requarantine(&id, reason, now_ms)?;
                stale.push(id);
            }
        }
        Ok(stale)
    }

    /// Read a file of the package's active revision for execution (hash point g): the
    /// attestation must still hold and the bytes must equal the recorded per-file digest.
    /// A mismatch revokes the revision; there is no fallback to any other copy.
    pub fn read_active_file(
        &mut self,
        package_id: &str,
        path: &str,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<Vec<u8>, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let pointer =
            active_pointer(self.conn(), &profile, package_id)?.ok_or(SkillError::NotFound)?;
        let revision = self.revision(&pointer.revision_id)?;
        if !matches!(
            revision.state,
            RevisionState::Active | RevisionState::Deprecated
        ) {
            return Err(SkillError::Corrupt("activation pointer state"));
        }
        let approval = load_approval(self.conn(), &profile, pointer.approval_id)?;
        let inspection = load_inspection(self.conn(), &profile, approval.inspection_id)?
            .ok_or(SkillError::Corrupt("approval inspection"))?;
        if let Err(reason) = attestation(&inspection, &revision, ctx) {
            self.requarantine(&revision.revision_id, reason, now_ms)?;
            return Err(SkillError::Denied(reason));
        }
        let entry = self
            .conn()
            .query_row(
                "SELECT size, sha256, executable FROM skill_files
                 WHERE profile_id = ?1 AND revision_id = ?2 AND path = ?3",
                params![profile, revision.revision_id, path],
                |row| {
                    Ok(super::tree::TreeFile {
                        path: path.to_owned(),
                        size: row.get::<_, i64>(0)?.try_into().unwrap_or(u64::MAX),
                        sha256: row.get(1)?,
                        executable: row.get(2)?,
                    })
                },
            )
            .optional()?
            .ok_or(SkillError::NotFound)?;
        match self.objects.read_file(&revision.tree_sha256, path, &entry) {
            Err(SkillError::Integrity) => {
                Err(self.integrity_failure(&revision.revision_id, now_ms))
            }
            other => other,
        }
    }

    /// The package's activation pointer.
    pub fn active(&mut self, package_id: &str) -> Result<Option<Activation>, SkillError> {
        let profile = self.profile.as_str().to_owned();
        active_pointer(self.conn(), &profile, package_id)
    }

    /// The package's activation history, oldest first.
    pub fn history(&mut self, package_id: &str) -> Result<Vec<ActivationEvent>, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT event_seq, action, from_revision_id, to_revision_id, approval_id, reason
             FROM skill_activation_events WHERE profile_id = ?1 AND package_id = ?2
             ORDER BY event_seq",
        )?;
        let rows = statement.query_map(params![profile, package_id], |row| {
            Ok(ActivationEvent {
                seq: row.get(0)?,
                action: row.get(1)?,
                from_revision_id: row.get(2)?,
                to_revision_id: row.get(3)?,
                approval_id: row.get(4)?,
                reason: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The profile's skill index generation (0 before the first activation change).
    pub fn index_generation(&mut self) -> Result<i64, SkillError> {
        let profile = self.profile.as_str().to_owned();
        Ok(self
            .conn()
            .query_row(
                "SELECT generation FROM skill_index_generation WHERE profile_id = ?1",
                [&profile],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    pub(super) fn require(
        &mut self,
        revision_id: &str,
        states: &[RevisionState],
    ) -> Result<Revision, SkillError> {
        let revision = self.revision(revision_id)?;
        if states.contains(&revision.state) {
            Ok(revision)
        } else {
            Err(SkillError::WrongState(revision.state))
        }
    }

    /// Dependency, conflict and compatibility resolution are not built yet: a revision that
    /// declares any is refused (`resolver_unavailable`) instead of skipping the check. Every
    /// way into `validated` (validation and an accepted review) runs this.
    pub(super) fn require_resolvable(&mut self, revision_id: &str) -> Result<(), SkillError> {
        let profile = self.profile.as_str().to_owned();
        let declared: i64 = self.conn().query_row(
            "SELECT (SELECT count(*) FROM skill_dependencies WHERE profile_id = ?1 AND revision_id = ?2)
                  + (SELECT count(*) FROM skill_conflicts WHERE profile_id = ?1 AND revision_id = ?2)
                  + (SELECT count(*) FROM skill_compatibility WHERE profile_id = ?1 AND revision_id = ?2)",
            params![profile, revision_id],
            |row| row.get(0),
        )?;
        if declared > 0 {
            return Err(SkillError::Denied("resolver_unavailable"));
        }
        Ok(())
    }

    fn route(
        &mut self,
        revision: &Revision,
        inspection: &InspectionRow,
        grants: &ProfileGrants,
    ) -> Result<Route, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let evaluation: Option<String> = self
            .conn()
            .query_row(
                "SELECT result FROM skill_evaluations WHERE profile_id = ?1 AND revision_id = ?2
                 ORDER BY evaluation_id DESC LIMIT 1",
                params![profile, revision.revision_id],
                |row| row.get(0),
            )
            .optional()?;
        let previous = match active_pointer(self.conn(), &profile, &revision.package_id)? {
            Some(pointer) => {
                Some(load_revision(self.conn(), &profile, &pointer.revision_id)?.permissions)
            }
            None => None,
        };
        Ok(policy::route(&policy::RouteFacts {
            attestation_valid: true,
            verdict: inspection
                .verdict
                .ok_or(SkillError::Corrupt("inspection verdict"))?,
            risk_class: revision.risk_class,
            permissions: &revision.permissions,
            previous: previous.as_ref(),
            preauthorized: &grants.preauthorized,
            evaluation: evaluation.as_deref().and_then(EvaluationResult::parse),
            auto_activation: grants.auto_activation,
        }))
    }

    /// The latest inspection, if it still attests this revision; otherwise the revision
    /// is moved back to `quarantined` and the reason returned.
    pub(super) fn require_attestation(
        &mut self,
        revision: &Revision,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<InspectionRow, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let latest = latest_inspection(self.conn(), &profile, &revision.revision_id)?;
        let reason = match &latest {
            Some(inspection) => attestation(inspection, revision, ctx).err(),
            None => Some("attestation_missing"),
        };
        match (latest, reason) {
            (Some(inspection), None) => Ok(inspection),
            (_, reason) => {
                let reason = reason.unwrap_or("attestation_missing");
                self.requarantine(&revision.revision_id, reason, now_ms)?;
                Err(SkillError::Denied(reason))
            }
        }
    }

    /// Stale attestation: back to `quarantined`, approvals revoked, pointer cleared.
    fn requarantine(
        &mut self,
        revision_id: &str,
        reason: &'static str,
        now_ms: i64,
    ) -> Result<(), SkillError> {
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        let revision = load_revision(&tx, &profile, revision_id)?;
        if !revision.state.can_transition_to(RevisionState::Quarantined) {
            return Ok(());
        }
        revoke_approvals(&tx, &profile, revision_id, &at)?;
        if let Some(pointer) = active_pointer(&tx, &profile, &revision.package_id)?
            && pointer.revision_id == revision_id
        {
            clear_pointer(
                &tx,
                &profile,
                &revision.package_id,
                revision_id,
                "deactivate",
                reason,
                &at,
            )?;
        }
        set_state(
            &tx,
            &profile,
            revision_id,
            revision.state,
            RevisionState::Quarantined,
            Some(reason),
            &at,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn verify_or_revoke(
        &mut self,
        revision: &Revision,
        now_ms: i64,
    ) -> Result<Tree, SkillError> {
        match self.objects.verify(&revision.tree_sha256, &self.limits) {
            Err(SkillError::Integrity) => {
                Err(self.integrity_failure(&revision.revision_id, now_ms))
            }
            other => other,
        }
    }

    /// Revoke with reason `integrity` and return [`SkillError::Integrity`].
    fn integrity_failure(&mut self, revision_id: &str, now_ms: i64) -> SkillError {
        let profile = self.profile.as_str().to_owned();
        let result = (|| -> Result<(), SkillError> {
            let tx = immediate(self.conn())?;
            let state = load_revision(&tx, &profile, revision_id)?.state;
            if !state.terminal() {
                revoke_in_tx(&tx, &profile, revision_id, "integrity", &format_utc(now_ms))?;
            }
            tx.commit()?;
            Ok(())
        })();
        match result {
            Ok(()) => SkillError::Integrity,
            Err(error) => error,
        }
    }
}

fn receipt(revision: Revision, created: bool) -> ImportReceipt {
    ImportReceipt {
        package_id: revision.package_id,
        revision_id: revision.revision_id,
        tree_sha256: revision.tree_sha256,
        version: revision.version,
        state: revision.state,
        state_reason: revision.state_reason,
        created,
    }
}

fn identity_fits(identity: &ScannerIdentity) -> bool {
    let fits = |text: &Option<String>, max: usize| {
        text.as_ref()
            .is_none_or(|text| !text.is_empty() && text.len() <= max)
    };
    !identity.id.is_empty()
        && identity.id.len() <= 128
        && fits(&identity.pin, 256)
        && fits(&identity.version, 128)
        && fits(&identity.normalizer_version, 128)
}

pub(super) fn immediate(conn: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
}

/// `NotFound` → `Ok(None)` for lookups that may miss.
trait OptionalFound<T> {
    fn optional_found(self) -> Result<Option<T>, SkillError>;
}

impl<T> OptionalFound<T> for Result<T, SkillError> {
    fn optional_found(self) -> Result<Option<T>, SkillError> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(SkillError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

pub(super) fn load_revision(
    conn: &Connection,
    profile: &str,
    revision_id: &str,
) -> Result<Revision, SkillError> {
    let row = conn
        .query_row(
            "SELECT package_id, version, tree_sha256, skill_md_sha256, manifest_json, manifest_inferred,
                    risk_class, permission_digest, state, state_reason
             FROM skill_revisions WHERE profile_id = ?1 AND revision_id = ?2",
            params![profile, revision_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or(SkillError::NotFound)?;
    let (
        package_id,
        version,
        tree_sha256,
        skill_md_sha256,
        manifest_json,
        inferred,
        risk,
        digest,
        state,
        reason,
    ) = row;
    let mut statement = conn.prepare(
        "SELECT capability, scope FROM skill_permissions WHERE profile_id = ?1 AND revision_id = ?2",
    )?;
    let entries = statement
        .query_map(params![profile, revision_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut parsed = Vec::with_capacity(entries.len());
    for (capability, scope) in entries {
        parsed.push((
            Capability::parse(&capability).ok_or(SkillError::Corrupt("permission capability"))?,
            scope,
        ));
    }
    let permissions = Permissions::from_entries(parsed);
    if permissions.digest() != digest {
        return Err(SkillError::Corrupt("permission digest"));
    }
    Ok(Revision {
        revision_id: revision_id.to_owned(),
        package_id,
        version,
        tree_sha256,
        skill_md_sha256,
        manifest_json,
        manifest_inferred: inferred,
        risk_class: RiskClass::parse(&risk).ok_or(SkillError::Corrupt("risk class"))?,
        permissions,
        permission_digest: digest,
        state: RevisionState::parse(&state).ok_or(SkillError::Corrupt("revision state"))?,
        state_reason: reason,
    })
}

fn insert_details(
    tx: &Transaction<'_>,
    profile: &str,
    revision_id: &str,
    tree: &Tree,
    manifest: &manifest::Manifest,
) -> Result<(), SkillError> {
    for file in &tree.files {
        tx.execute(
            "INSERT INTO skill_files (profile_id, revision_id, path, size, sha256, executable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                profile,
                revision_id,
                file.path,
                i64::try_from(file.size).map_err(|_| SkillError::Corrupt("file size"))?,
                file.sha256,
                file.executable
            ],
        )?;
    }
    for (capability, scope) in manifest.permissions.entries() {
        tx.execute(
            "INSERT INTO skill_permissions (profile_id, revision_id, capability, scope) VALUES (?1, ?2, ?3, ?4)",
            params![profile, revision_id, capability.as_str(), scope],
        )?;
    }
    for (id, range) in &manifest.dependencies {
        tx.execute(
            "INSERT INTO skill_dependencies (profile_id, revision_id, required_package_id, version_range)
             VALUES (?1, ?2, ?3, ?4)",
            params![profile, revision_id, id, range],
        )?;
    }
    for (id, range) in &manifest.conflicts {
        tx.execute(
            "INSERT INTO skill_conflicts (profile_id, revision_id, conflicting_package_id, version_range)
             VALUES (?1, ?2, ?3, ?4)",
            params![profile, revision_id, id, range],
        )?;
    }
    for (fact, range) in &manifest.compatibility {
        tx.execute(
            "INSERT INTO skill_compatibility (profile_id, revision_id, fact_id, version_range)
             VALUES (?1, ?2, ?3, ?4)",
            params![profile, revision_id, fact, range],
        )?;
    }
    for category in &manifest.categories {
        let mut parent: Option<String> = None;
        let mut path = String::new();
        for segment in category.split('.') {
            if !path.is_empty() {
                path.push('.');
            }
            path.push_str(segment);
            tx.execute(
                "INSERT OR IGNORE INTO skill_categories (profile_id, category_id, parent_id) VALUES (?1, ?2, ?3)",
                params![profile, path, parent],
            )?;
            parent = Some(path.clone());
        }
        tx.execute(
            "INSERT INTO skill_category_map (profile_id, revision_id, category_id) VALUES (?1, ?2, ?3)",
            params![profile, revision_id, category],
        )?;
    }
    for intent in &manifest.intents {
        tx.execute(
            "INSERT INTO skill_intents (profile_id, revision_id, intent) VALUES (?1, ?2, ?3)",
            params![profile, revision_id, intent],
        )?;
    }
    Ok(())
}

fn record_state(
    tx: &Transaction<'_>,
    profile: &str,
    revision_id: &str,
    from: Option<RevisionState>,
    to: RevisionState,
    reason: Option<&str>,
    at: &str,
) -> Result<(), SkillError> {
    tx.execute(
        "INSERT INTO skill_revision_events (profile_id, revision_id, from_state, to_state, reason, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![profile, revision_id, from.map(RevisionState::as_str), to.as_str(), reason, at],
    )?;
    Ok(())
}

/// Apply one table-checked transition with its audit row; the row must still be `from`.
pub(super) fn set_state(
    tx: &Transaction<'_>,
    profile: &str,
    revision_id: &str,
    from: RevisionState,
    to: RevisionState,
    reason: Option<&str>,
    at: &str,
) -> Result<(), SkillError> {
    if !from.can_transition_to(to) {
        return Err(SkillError::InvalidTransition { from, to });
    }
    let changed = tx.execute(
        "UPDATE skill_revisions SET state = ?1, state_reason = ?2, updated_at = ?3
         WHERE profile_id = ?4 AND revision_id = ?5 AND state = ?6",
        params![to.as_str(), reason, at, profile, revision_id, from.as_str()],
    )?;
    if changed != 1 {
        return Err(SkillError::Corrupt("revision state changed concurrently"));
    }
    record_state(tx, profile, revision_id, Some(from), to, reason, at)
}

fn revoke_approvals(
    tx: &Transaction<'_>,
    profile: &str,
    revision_id: &str,
    at: &str,
) -> Result<(), SkillError> {
    tx.execute(
        "UPDATE skill_approvals SET status = 'revoked', revoked_at = ?1
         WHERE profile_id = ?2 AND revision_id = ?3 AND status = 'granted'",
        params![at, profile, revision_id],
    )?;
    Ok(())
}

fn revoke_in_tx(
    tx: &Transaction<'_>,
    profile: &str,
    revision_id: &str,
    reason: &str,
    at: &str,
) -> Result<(), SkillError> {
    let revision = load_revision(tx, profile, revision_id)?;
    revoke_approvals(tx, profile, revision_id, at)?;
    if let Some(pointer) = active_pointer(tx, profile, &revision.package_id)?
        && pointer.revision_id == revision_id
    {
        clear_pointer(
            tx,
            profile,
            &revision.package_id,
            revision_id,
            "revoke",
            reason,
            at,
        )?;
    }
    set_state(
        tx,
        profile,
        revision_id,
        revision.state,
        RevisionState::Revoked,
        Some(reason),
        at,
    )
}

fn clear_pointer(
    tx: &Transaction<'_>,
    profile: &str,
    package_id: &str,
    revision_id: &str,
    action: &str,
    reason: &str,
    at: &str,
) -> Result<(), SkillError> {
    tx.execute(
        "DELETE FROM skill_activations WHERE profile_id = ?1 AND package_id = ?2 AND revision_id = ?3",
        params![profile, package_id, revision_id],
    )?;
    tx.execute(
        "INSERT INTO skill_activation_events (profile_id, package_id, action, from_revision_id,
           to_revision_id, approval_id, reason, at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)",
        params![profile, package_id, action, revision_id, reason, at],
    )?;
    bump_generation(tx, profile)
}

fn bump_generation(tx: &Transaction<'_>, profile: &str) -> Result<(), SkillError> {
    tx.execute(
        "INSERT INTO skill_index_generation (profile_id, generation) VALUES (?1, 1)
         ON CONFLICT (profile_id) DO UPDATE SET generation = generation + 1",
        [profile],
    )?;
    Ok(())
}

pub(super) fn active_pointer(
    conn: &Connection,
    profile: &str,
    package_id: &str,
) -> Result<Option<Activation>, SkillError> {
    Ok(conn
        .query_row(
            "SELECT revision_id, approval_id, activated_at FROM skill_activations
             WHERE profile_id = ?1 AND package_id = ?2",
            params![profile, package_id],
            |row| {
                Ok(Activation {
                    package_id: package_id.to_owned(),
                    revision_id: row.get(0)?,
                    approval_id: row.get(1)?,
                    activated_at: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Another revision of the package with the same version is approved or later.
fn version_reused(
    conn: &Connection,
    profile: &str,
    package_id: &str,
    version: &str,
    revision_id: &str,
) -> Result<bool, SkillError> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM skill_revisions
         WHERE profile_id = ?1 AND package_id = ?2 AND version = ?3 AND revision_id <> ?4
           AND state IN ('approved', 'active', 'superseded', 'deprecated')",
        params![profile, package_id, version, revision_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[derive(Debug, Clone)]
pub(super) struct InspectionRow {
    pub(super) id: i64,
    tree_sha256: String,
    scanner: ScannerIdentity,
    policy_version: String,
    outcome: String,
    coverage: Coverage,
    verdict: Option<Severity>,
}

const INSPECTION_COLUMNS: &str =
    "inspection_id, tree_sha256, scanner_id, scanner_pin, scanner_version,
    normalizer_version, policy_version, outcome, coverage, verdict";

fn inspection_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(InspectionRow, String, Option<String>)> {
    let coverage: String = row.get(8)?;
    let verdict: Option<String> = row.get(9)?;
    Ok((
        InspectionRow {
            id: row.get(0)?,
            tree_sha256: row.get(1)?,
            scanner: ScannerIdentity {
                id: row.get(2)?,
                pin: row.get(3)?,
                version: row.get(4)?,
                normalizer_version: row.get(5)?,
            },
            policy_version: row.get(6)?,
            outcome: row.get(7)?,
            coverage: Coverage::None,
            verdict: None,
        },
        coverage,
        verdict,
    ))
}

fn finish_inspection(
    found: Option<(InspectionRow, String, Option<String>)>,
) -> Result<Option<InspectionRow>, SkillError> {
    let Some((mut row, coverage, verdict)) = found else {
        return Ok(None);
    };
    row.coverage = Coverage::parse(&coverage).ok_or(SkillError::Corrupt("inspection coverage"))?;
    row.verdict = match verdict {
        Some(verdict) => {
            Some(Severity::parse(&verdict).ok_or(SkillError::Corrupt("inspection verdict"))?)
        }
        None => None,
    };
    Ok(Some(row))
}

pub(super) fn latest_inspection(
    conn: &Connection,
    profile: &str,
    revision_id: &str,
) -> Result<Option<InspectionRow>, SkillError> {
    let found = conn
        .query_row(
            &format!(
                "SELECT {INSPECTION_COLUMNS} FROM skill_inspections
                 WHERE profile_id = ?1 AND revision_id = ?2 ORDER BY inspection_id DESC LIMIT 1"
            ),
            params![profile, revision_id],
            inspection_row,
        )
        .optional()?;
    finish_inspection(found)
}

fn load_inspection(
    conn: &Connection,
    profile: &str,
    inspection_id: i64,
) -> Result<Option<InspectionRow>, SkillError> {
    let found = conn
        .query_row(
            &format!(
                "SELECT {INSPECTION_COLUMNS} FROM skill_inspections
                 WHERE profile_id = ?1 AND inspection_id = ?2"
            ),
            params![profile, inspection_id],
            inspection_row,
        )
        .optional()?;
    finish_inspection(found)
}

fn attestation(
    inspection: &InspectionRow,
    revision: &Revision,
    ctx: &PolicyContext,
) -> Result<(), &'static str> {
    policy::check_attestation(
        &policy::Attestation {
            tree_sha256: &inspection.tree_sha256,
            scanner: &inspection.scanner,
            policy_version: &inspection.policy_version,
            completed: inspection.outcome == "completed",
            coverage: inspection.coverage,
            verdict: inspection.verdict,
        },
        &policy::Current {
            tree_sha256: &revision.tree_sha256,
            scanner: &ctx.scanner,
            policy_version: &ctx.policy_version,
        },
    )
}

#[derive(Debug, Clone)]
struct ApprovalRow {
    revision_id: String,
    tree_sha256: String,
    inspection_id: i64,
    permission_digest: String,
    status: String,
    expires_at: String,
}

fn load_approval(
    conn: &Connection,
    profile: &str,
    approval_id: i64,
) -> Result<ApprovalRow, SkillError> {
    conn.query_row(
        "SELECT revision_id, tree_sha256, inspection_id, permission_digest, status, expires_at
         FROM skill_approvals WHERE profile_id = ?1 AND approval_id = ?2",
        params![profile, approval_id],
        |row| {
            Ok(ApprovalRow {
                revision_id: row.get(0)?,
                tree_sha256: row.get(1)?,
                inspection_id: row.get(2)?,
                permission_digest: row.get(3)?,
                status: row.get(4)?,
                expires_at: row.get(5)?,
            })
        },
    )
    .optional()?
    .ok_or(SkillError::NotFound)
}

/// Whether this approval already activated this revision (the history records it).
fn approval_consumed(
    conn: &Connection,
    profile: &str,
    revision: &Revision,
    approval_id: i64,
) -> Result<bool, SkillError> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM skill_activation_events
         WHERE profile_id = ?1 AND package_id = ?2 AND to_revision_id = ?3 AND approval_id = ?4",
        params![
            profile,
            revision.package_id,
            revision.revision_id,
            approval_id
        ],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// `consumed`: the approval already activated this revision, so its expiry (the window
/// for the first activation) no longer applies; status, binding and digests still do.
fn check_approval(
    approval: &ApprovalRow,
    revision: &Revision,
    now_ms: i64,
    consumed: bool,
) -> Result<(), SkillError> {
    if approval.revision_id != revision.revision_id || approval.tree_sha256 != revision.tree_sha256
    {
        return Err(SkillError::Denied("approval_mismatch"));
    }
    if approval.permission_digest != revision.permission_digest {
        return Err(SkillError::Denied("permission_digest_mismatch"));
    }
    if approval.status != "granted" {
        return Err(SkillError::Denied("approval_revoked"));
    }
    let expires = parse_utc(&approval.expires_at).ok_or(SkillError::Corrupt("approval expiry"))?;
    if !consumed && expires <= now_ms {
        return Err(SkillError::Denied("approval_expired"));
    }
    Ok(())
}
