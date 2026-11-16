//! Bounded synthetic instruction tests. Native outputs are graded here against
//! immutable fixture assertions; no caller or model supplies a passing verdict.
use super::super::verification::{self, TESTS_FILE, VerificationCase};
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
const RECEIPT_VERSION: &str = "synthetic-declarative-v1";
fn digest(bytes: impl AsRef<[u8]>) -> String {
    crate::sha256::hex_digest(bytes.as_ref())
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationCaseInput {
    pub id: String,
    pub input: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct EvaluationReference {
    pub path: String,
    pub content: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct EvaluationSubject {
    pub subject: String,
    pub instructions: String,
    pub references: Vec<EvaluationReference>,
    pub cases: Vec<EvaluationCaseInput>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationOutput {
    pub case_id: String,
    pub text: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationSubjectOutput {
    pub subject: String,
    pub outputs: Vec<EvaluationOutput>,
}
#[derive(Debug, Clone)]
pub struct PreparedEvaluation {
    revision: Revision,
    baseline: Option<Revision>,
    tests_sha: String,
    cases: Vec<VerificationCase>,
    complete: bool,
    issues: Vec<String>,
    pub subjects: Vec<EvaluationSubject>,
}
impl PreparedEvaluation {
    pub fn revision_id(&self) -> &str {
        &self.revision.revision_id
    }
    pub fn tree_sha256(&self) -> &str {
        &self.revision.tree_sha256
    }
    pub fn baseline(&self) -> Option<(&str, &str)> {
        self.baseline
            .as_ref()
            .map(|b| (b.revision_id.as_str(), b.tree_sha256.as_str()))
    }
}
struct Quality {
    revision: Revision,
    body: String,
    tests_sha: String,
    cases: Vec<VerificationCase>,
    missing: Vec<String>,
    issues: Vec<String>,
    references: Vec<EvaluationReference>,
}
impl Quality {
    fn complete(&self) -> bool {
        self.missing.is_empty() && self.issues.is_empty() && !self.cases.is_empty()
    }
}
// Compact append-only evidence <=512 bytes. Full outputs remain private to the
// invocation; the receipt binds their digest, exact fixtures and baseline tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Evidence(
    String,
    Option<String>,
    String,
    usize,
    usize,
    Option<usize>,
    String,
    String,
    Vec<String>,
);
fn is_generated(conn: &Connection, profile: &str, revision: &str) -> Result<bool, SkillError> {
    Ok(conn.query_row("SELECT p.origin='generated' OR EXISTS(SELECT 1 FROM skill_revision_sources s WHERE s.profile_id=r.profile_id AND s.revision_id=r.revision_id AND s.origin='generated') FROM skill_revisions r JOIN skill_packages p ON p.profile_id=r.profile_id AND p.package_id=r.package_id WHERE r.profile_id=?1 AND r.revision_id=?2",params![profile,revision],|r|r.get(0))?)
}
type StoredEvaluation = (String, Option<String>, String, String);
fn latest(
    conn: &Connection,
    profile: &str,
    revision: &str,
) -> Result<Option<StoredEvaluation>, SkillError> {
    Ok(conn.query_row("SELECT result,baseline_revision_id,evidence_ref,evaluated_at FROM skill_evaluations WHERE profile_id=?1 AND revision_id=?2 ORDER BY evaluation_id DESC LIMIT 1",params![profile,revision],|row|Ok((row.get(0)?,row.get(1)?,row.get::<_,Option<String>>(2)?.unwrap_or_default(),row.get(3)?))).optional()?)
}
fn baseline_matches(
    conn: &Connection,
    profile: &str,
    revision: &Revision,
    baseline: Option<&str>,
    allow_current: bool,
) -> Result<bool, SkillError> {
    let active = active_pointer(conn, profile, &revision.package_id)?;
    Ok(active.as_ref().map(|p| p.revision_id.as_str()) == baseline
        || allow_current
            && active
                .as_ref()
                .is_some_and(|p| p.revision_id == revision.revision_id))
}
pub(super) fn require_generated_evaluation(
    conn: &Connection,
    profile: &str,
    revision: &Revision,
    objects: &super::super::tree::ObjectStore,
    limits: &StagingLimits,
) -> Result<(), SkillError> {
    if !is_generated(conn, profile, &revision.revision_id)? {
        return Ok(());
    }
    let Some((result, baseline, reference, _)) = latest(conn, profile, &revision.revision_id)?
    else {
        return Err(SkillError::Denied("learned_evaluation_required"));
    };
    let receipt: Evidence = serde_json::from_str(&reference)
        .map_err(|_| SkillError::Denied("learned_evaluation_required"))?;
    if result != "passed"
        || receipt.0 != RECEIPT_VERSION
        || receipt.4 == 0
        || receipt.3 != receipt.4
        || !receipt.8.is_empty()
    {
        return Err(SkillError::Denied("learned_evaluation_required"));
    }
    if !baseline_matches(conn, profile, revision, baseline.as_deref(), false)? {
        return Err(SkillError::Denied("learned_evaluation_stale"));
    }
    if let Some(id) = baseline {
        let stored = load_revision(conn, profile, &id)?;
        objects.verify(&stored.tree_sha256, limits)?;
        if Some(stored.tree_sha256) != receipt.1 {
            return Err(SkillError::Denied("learned_evaluation_stale"));
        }
    }
    Ok(())
}
impl SkillRegistry<'_> {
    fn quality(&mut self, revision_id: &str) -> Result<Quality, SkillError> {
        let revision = self.revision(revision_id)?;
        let tree = self.objects.verify(&revision.tree_sha256, &self.limits)?;
        let read = |path: &str| -> Result<Option<Vec<u8>>, SkillError> {
            tree.file(path)
                .map(|f| self.objects.read_file(&tree.sha256, path, f))
                .transpose()
        };
        let body = String::from_utf8(read(SKILL_FILE)?.ok_or(SkillError::Integrity)?)
            .map_err(|_| SkillError::Integrity)?;
        let manifest: Value = serde_json::from_str(&revision.manifest_json)
            .map_err(|_| SkillError::Corrupt("manifest"))?;
        let mut issues = Vec::new();
        for (key, max, valid) in [
            (
                "categories",
                8,
                manifest::is_category_id as fn(&str) -> bool,
            ),
            ("intents", 16, manifest::is_intent as fn(&str) -> bool),
        ] {
            match verification::metadata(&manifest, key, max, valid) {
                Ok(values) => {
                    let raw = body
                        .lines()
                        .skip(1)
                        .take_while(|l| l.trim() != "---")
                        .find_map(|line| line.strip_prefix(&format!("{key}:")));
                    let mirrored = raw
                        .and_then(|v| serde_json::from_str::<Vec<String>>(v.trim()).ok())
                        .map(|v| v.into_iter().collect::<BTreeSet<_>>());
                    if mirrored != Some(values.into_iter().collect()) {
                        issues.push("metadata_mismatch".into());
                    }
                }
                Err(_) => issues.push("metadata_missing".into()),
            }
        }
        let bytes = read(TESTS_FILE)?;
        let tests_sha = bytes.as_ref().map(digest).unwrap_or_else(|| digest([]));
        let cases = bytes
            .as_deref()
            .and_then(|b| verification::parse(b).ok())
            .unwrap_or_default();
        if cases.is_empty() {
            issues.push("fixtures_missing".into());
        }
        let mut references = Vec::new();
        for file in &tree.files {
            if super::super::candidates::reference_path(&file.path) {
                let content =
                    String::from_utf8(self.objects.read_file(&tree.sha256, &file.path, file)?)
                        .map_err(|_| SkillError::Integrity)?;
                if content.trim().is_empty() || !body.contains(&file.path) {
                    issues.push("reference_unlinked".into());
                }
                references.push(EvaluationReference {
                    path: file.path.clone(),
                    content,
                });
            } else if file.executable
                || ![SKILL_FILE, MANIFEST_FILE, TESTS_FILE, "PROVENANCE.md"]
                    .contains(&file.path.as_str())
            {
                issues.push("unsupported_file".into());
            }
        }
        // A path claim never supplies missing reference bytes.
        for fragment in body.split("references/").skip(1) {
            let name: String = fragment
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
                .collect();
            if name.ends_with(".md")
                && !references
                    .iter()
                    .any(|r| r.path == format!("references/{name}"))
            {
                issues.push("reference_missing".into());
            }
        }
        if revision.risk_class != RiskClass::Declarative
            || revision.permissions != Permissions::default()
        {
            issues.push("unsupported_permissions".into());
        }
        issues.sort();
        issues.dedup();
        let missing = verification::missing_sections(&body);
        Ok(Quality {
            revision,
            body,
            tests_sha,
            cases,
            missing,
            issues,
            references,
        })
    }
    pub fn learned_quality(&mut self, revision_id: &str) -> Result<Option<Value>, SkillError> {
        let profile = self.profile.as_str().to_owned();
        if !is_generated(self.conn(), &profile, revision_id)? {
            return Ok(None);
        }
        let quality = self.quality(revision_id)?;
        let mut report = json!({"complete":quality.complete(),"missingSections":quality.missing,"testCount":quality.cases.len()});
        if let Some(pointer) = active_pointer(self.conn(), &profile, &quality.revision.package_id)?
            && pointer.revision_id != revision_id
        {
            let base = load_revision(self.conn(), &profile, &pointer.revision_id)?;
            report["baseline"] =
                json!({"revisionId":base.revision_id,"treeSha256":base.tree_sha256});
        }
        if let Some((status, baseline, reference, at)) = latest(self.conn(), &profile, revision_id)?
            && let Ok(evidence) = serde_json::from_str::<Evidence>(&reference)
            && evidence.0 == RECEIPT_VERSION
        {
            let fresh = quality.tests_sha == evidence.2
                && baseline_matches(
                    self.conn(),
                    &profile,
                    &quality.revision,
                    baseline.as_deref(),
                    true,
                )?;
            let mut value = json!({"revisionId":revision_id,"treeSha256":quality.revision.tree_sha256,"status":if !fresh{"stale"}else if status=="insufficient_evidence"{"insufficient-evidence"}else{&status},"passed":evidence.3,"total":evidence.4,"evaluatedAt":at,"scope":"synthetic-declarative","issues":evidence.8});
            if let Some(base) = baseline {
                value["baselineRevisionId"] = base.into();
            }
            if let Some(sha) = evidence.1 {
                value["baselineTreeSha256"] = sha.into();
            }
            if let Some(passed) = evidence.5 {
                value["baselinePassed"] = passed.into();
            }
            report["evaluation"] = value;
        }
        Ok(Some(report))
    }
    pub fn prepare_evaluation(
        &mut self,
        revision_id: &str,
        tree_sha: &str,
        ctx: &PolicyContext,
        now: i64,
    ) -> Result<PreparedEvaluation, SkillError> {
        let mut revision = self.require(
            revision_id,
            &[
                RevisionState::Validated,
                RevisionState::AwaitingApproval,
                RevisionState::Approved,
            ],
        )?;
        let profile = self.profile.as_str().to_owned();
        if !is_generated(self.conn(), &profile, revision_id)? {
            return Err(SkillError::Denied("learned_candidate_required"));
        }
        if revision.tree_sha256 != tree_sha {
            return Err(SkillError::Denied("digest_mismatch"));
        }
        self.verify_or_revoke(&revision, now)?;
        self.require_attestation(&revision, ctx, now)?;
        if revision.state != RevisionState::Validated {
            let at = format_utc(now);
            let tx = immediate(self.conn())?;
            if active_pointer(&tx, &profile, &revision.package_id)?
                .is_some_and(|p| p.revision_id == revision_id)
            {
                return Err(SkillError::Denied("learned_candidate_required"));
            }
            revoke_approvals(&tx, &profile, revision_id, &at)?;
            set_state(
                &tx,
                &profile,
                revision_id,
                revision.state,
                RevisionState::Validated,
                Some("synthetic-re-evaluation"),
                &at,
            )?;
            tx.commit()?;
            revision.state = RevisionState::Validated;
        }
        let quality = self.quality(revision_id)?;
        let mut issues = quality.issues.clone();
        if !quality.missing.is_empty() {
            issues.push("sections_missing".into());
        }
        let baseline = active_pointer(self.conn(), &profile, &revision.package_id)?
            .map(|p| self.quality(&p.revision_id))
            .transpose()?;
        if let Some(base) = &baseline {
            if base
                .references
                .iter()
                .any(|r| !quality.references.iter().any(|q| q.path == r.path))
            {
                issues.push("baseline_references_removed".into());
            }
            if base.cases.iter().any(|case| !quality.cases.contains(case)) {
                issues.push("baseline_fixtures_changed".into());
            }
            let before: Value = serde_json::from_str(&base.revision.manifest_json)
                .map_err(|_| SkillError::Corrupt("manifest"))?;
            let after: Value = serde_json::from_str(&revision.manifest_json)
                .map_err(|_| SkillError::Corrupt("manifest"))?;
            for key in ["categories", "intents"] {
                if before[key].as_array().is_some_and(|values| {
                    values
                        .iter()
                        .any(|v| !after[key].as_array().is_some_and(|a| a.contains(v)))
                }) {
                    issues.push("baseline_metadata_removed".into());
                }
            }
        }
        if quality.body.encode_utf16().count() > 65536
            || quality.references.len() > 4
            || quality
                .references
                .iter()
                .any(|r| r.content.encode_utf16().count() > 16384)
            || baseline.as_ref().is_some_and(|b| {
                b.body.encode_utf16().count() > 65536
                    || b.references.len() > 4
                    || b.references
                        .iter()
                        .any(|r| r.content.encode_utf16().count() > 16384)
            })
        {
            return Err(SkillError::Denied("evaluation_context_bound"));
        }
        let inputs = quality
            .cases
            .iter()
            .map(|c| EvaluationCaseInput {
                id: c.id.clone(),
                input: c.input.clone(),
            })
            .collect::<Vec<_>>();
        let mut subjects = vec![EvaluationSubject {
            subject: "candidate".into(),
            instructions: verification::instruction_body(&quality.body).to_owned(),
            references: quality.references,
            cases: inputs.clone(),
        }];
        if let Some(base) = &baseline {
            subjects.push(EvaluationSubject {
                subject: "baseline".into(),
                instructions: verification::instruction_body(&base.body).to_owned(),
                references: base.references.clone(),
                cases: inputs,
            });
        }
        Ok(PreparedEvaluation {
            revision,
            baseline: baseline.map(|b| b.revision),
            tests_sha: quality.tests_sha,
            cases: quality.cases,
            complete: issues.is_empty(),
            issues,
            subjects,
        })
    }
    pub fn complete_evaluation(
        &mut self,
        plan: PreparedEvaluation,
        outputs: &[EvaluationSubjectOutput],
        provider: &str,
        model: &str,
        ctx: &PolicyContext,
        now: i64,
    ) -> Result<Value, SkillError> {
        let revision = self.require(&plan.revision.revision_id, &[RevisionState::Validated])?;
        self.verify_or_revoke(&revision, now)?;
        self.require_attestation(&revision, ctx, now)?;
        if revision.tree_sha256 != plan.revision.tree_sha256 {
            return Err(SkillError::Denied("learned_evaluation_stale"));
        }
        if let Some(base) = &plan.baseline {
            self.objects.verify(&base.tree_sha256, &self.limits)?;
        }
        let quality = self.quality(&revision.revision_id)?;
        if quality.tests_sha != plan.tests_sha {
            return Err(SkillError::Denied("learned_evaluation_stale"));
        }
        let mut issues = plan.issues;
        let mut counts = BTreeMap::new();
        let mut seen = BTreeSet::new();
        let mut evidence_outputs = Vec::new();
        if outputs.len() != plan.subjects.len() {
            issues.push("outputs_incomplete".into());
        }
        for subject in outputs {
            if !plan.subjects.iter().any(|s| s.subject == subject.subject)
                || !seen.insert(&subject.subject)
                || subject.outputs.len() != plan.cases.len()
            {
                issues.push("outputs_incomplete".into());
                continue;
            }
            let mut matched = BTreeSet::new();
            let mut passed = 0;
            for output in &subject.outputs {
                let Some(case) = plan.cases.iter().find(|c| c.id == output.case_id) else {
                    issues.push("outputs_incomplete".into());
                    continue;
                };
                if !matched.insert(&output.case_id)
                    || output.text.trim().is_empty()
                    || output.text.encode_utf16().count() > 12000
                {
                    issues.push("outputs_incomplete".into());
                    continue;
                }
                if case
                    .expected_includes
                    .iter()
                    .all(|part| output.text.contains(part))
                    && case
                        .forbidden_includes
                        .iter()
                        .all(|part| !output.text.contains(part))
                {
                    passed += 1;
                }
                evidence_outputs.push(json!([
                    subject.subject,
                    output.case_id,
                    digest(&output.text)
                ]));
            }
            counts.insert(subject.subject.as_str(), passed);
        }
        if provider.trim().is_empty()
            || provider.encode_utf16().count() > 128
            || model.trim().is_empty()
            || model.encode_utf16().count() > 256
        {
            issues.push("provider_unavailable".into());
        }
        issues.sort();
        issues.dedup();
        issues.truncate(4);
        let passed = *counts.get("candidate").unwrap_or(&0);
        let baseline_passed = counts.get("baseline").copied();
        let result = if !plan.complete || !issues.is_empty() || plan.cases.is_empty() {
            "insufficient_evidence"
        } else if passed != plan.cases.len() {
            "failed"
        } else {
            "passed"
        };
        let evidence = Evidence(
            RECEIPT_VERSION.into(),
            plan.baseline.as_ref().map(|b| b.tree_sha256.clone()),
            plan.tests_sha,
            passed,
            plan.cases.len(),
            baseline_passed,
            digest(json!([evidence_outputs, provider, model]).to_string()),
            digest(json!([provider, model]).to_string())[..16].to_owned(),
            issues,
        );
        let encoded = serde_json::to_string(&evidence)
            .map_err(|_| SkillError::Corrupt("evaluation evidence"))?;
        if encoded.len() > 512 {
            return Err(SkillError::Denied("evaluation_evidence_bound"));
        }
        let profile = self.profile.as_str().to_owned();
        let at = format_utc(now);
        let tx = immediate(self.conn())?;
        if load_revision(&tx, &profile, &revision.revision_id)?.state != RevisionState::Validated {
            return Err(SkillError::Denied("learned_evaluation_stale"));
        }
        let baseline_id = plan.baseline.as_ref().map(|b| b.revision_id.as_str());
        if !baseline_matches(&tx, &profile, &revision, baseline_id, false)? {
            return Err(SkillError::Denied("learned_evaluation_stale"));
        }
        tx.execute("INSERT INTO skill_evaluations(profile_id,revision_id,tree_sha256,baseline_revision_id,result,evidence_ref,evaluated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![profile,revision.revision_id,revision.tree_sha256,baseline_id,result,encoded,at])?;
        let state = if result == "passed" {
            set_state(
                &tx,
                &profile,
                &revision.revision_id,
                RevisionState::Validated,
                RevisionState::Evaluating,
                Some("synthetic-declarative"),
                &at,
            )?;
            set_state(
                &tx,
                &profile,
                &revision.revision_id,
                RevisionState::Evaluating,
                RevisionState::Evaluated,
                Some("synthetic-declarative"),
                &at,
            )?;
            set_state(
                &tx,
                &profile,
                &revision.revision_id,
                RevisionState::Evaluated,
                RevisionState::AwaitingApproval,
                Some("tested-user-approval-required"),
                &at,
            )?;
            RevisionState::AwaitingApproval
        } else {
            let reason = if result == "failed" {
                "evaluation-failed"
            } else {
                "evaluation-insufficient-evidence"
            };
            tx.execute("UPDATE skill_revisions SET state_reason=?3,updated_at=?4 WHERE profile_id=?1 AND revision_id=?2",params![profile,revision.revision_id,reason,at])?;
            record_state(
                &tx,
                &profile,
                &revision.revision_id,
                Some(RevisionState::Validated),
                RevisionState::Validated,
                Some(reason),
                &at,
            )?;
            RevisionState::Validated
        };
        tx.commit()?;
        Ok(
            json!({"revisionId":revision.revision_id,"state":state.as_str(),"learnedQuality":self.learned_quality(&revision.revision_id)?.ok_or(SkillError::Integrity)?}),
        )
    }
    pub(super) fn generated(&mut self, revision_id: &str) -> Result<bool, SkillError> {
        let profile = self.profile.as_str().to_owned();
        is_generated(self.conn(), &profile, revision_id)
    }
}
