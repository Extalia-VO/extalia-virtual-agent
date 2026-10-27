//! Evidence records and L1 experience capture (module documentation of [`super`]).

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;

use super::{
    Basis, Claim, EvidenceKind, LEARNING_PRINCIPAL, Learning, LearningError, MAX_EVIDENCE_PER_TASK,
    MAX_EXCERPT_BYTES, MAX_REF_BYTES, MAX_SUMMARY_BYTES, Outcome, TrustStatus, bounded,
    extalia_principal, is_line, is_sha256, is_text, mask,
};
use crate::mission::{MissionState, Task, TaskState, contract};
use crate::skills::review::is_user_principal;
use crate::time::format_utc;

/// Evidence about one task of a native mission in this profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceInput<'a> {
    pub mission_id: &'a str,
    pub task_id: &'a str,
    /// `test_gate`, `user_confirmation` or `observed_claim`; `task_result` is written by
    /// [`Learning::capture_mission`] only.
    pub kind: EvidenceKind,
    /// What the evidence asserts about the task's outcome.
    pub claim: Claim,
    /// Lowercase hex SHA-256 of the artifact (gate log, confirmed result, observed excerpt).
    pub digest: &'a str,
    /// Where the artifact is (for example `gate:<proposal-id>` or `observed:<event-id>`); one
    /// line, masked, at most [`super::MAX_REF_BYTES`] bytes.
    pub reference: &'a str,
    /// A short excerpt; masked and cut to [`super::MAX_EXCERPT_BYTES`] bytes.
    pub excerpt: Option<&'a str>,
    /// `user:<id>` for a user confirmation, `extalia:<component>` otherwise (for an observed
    /// claim: the observer that recorded it, never the observed agent).
    pub recorded_by: &'a str,
}

/// A stored evidence record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceRecord {
    pub id: i64,
    pub mission_id: String,
    pub task_id: String,
    pub kind: EvidenceKind,
    pub claim: Claim,
    pub trust: TrustStatus,
    pub digest: String,
    pub reference: String,
    pub excerpt: Option<String>,
    pub masked_count: u32,
    pub recorded_by: String,
    pub observed_at: String,
}

/// A stored L1 experience.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Experience {
    pub id: i64,
    pub workspace_id: String,
    pub mission_id: String,
    pub task_id: String,
    /// The task row's digest when it was captured (the revision the experience describes).
    pub task_digest: String,
    pub agent_id: Option<String>,
    pub task_state: TaskState,
    pub outcome: Outcome,
    pub basis: Basis,
    pub summary: String,
    pub masked_count: u32,
    pub evidence_ids: Vec<i64>,
    pub created_at: String,
}

/// Result of [`Learning::capture_mission`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureReport {
    pub mission_id: String,
    /// Experiences written by this call (0 on a repeated capture).
    pub created: usize,
    /// Every experience of the mission, by task id.
    pub experiences: Vec<Experience>,
    /// Tasks without a result (`cancelled`, `unknown`, never started), by task id.
    pub skipped: Vec<String>,
}

const EVIDENCE_COLUMNS: &str = "evidence_id, mission_id, task_id, kind, claim, trust_status, digest, ref, excerpt, masked_count, recorded_by, observed_at";

fn evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawEvidence> {
    Ok(RawEvidence {
        id: row.get(0)?,
        mission_id: row.get(1)?,
        task_id: row.get(2)?,
        kind: row.get(3)?,
        claim: row.get(4)?,
        trust: row.get(5)?,
        digest: row.get(6)?,
        reference: row.get(7)?,
        excerpt: row.get(8)?,
        masked_count: row.get(9)?,
        recorded_by: row.get(10)?,
        observed_at: row.get(11)?,
    })
}

struct RawEvidence {
    id: i64,
    mission_id: String,
    task_id: String,
    kind: String,
    claim: String,
    trust: String,
    digest: String,
    reference: String,
    excerpt: Option<String>,
    masked_count: i64,
    recorded_by: String,
    observed_at: String,
}

impl RawEvidence {
    fn decode(self) -> Result<EvidenceRecord, LearningError> {
        let corrupt = || LearningError::Corrupt("evidence row");
        let kind = EvidenceKind::parse(&self.kind).ok_or_else(corrupt)?;
        let trust = TrustStatus::parse(&self.trust).ok_or_else(corrupt)?;
        if kind.trust() != trust {
            return Err(corrupt());
        }
        Ok(EvidenceRecord {
            id: self.id,
            mission_id: self.mission_id,
            task_id: self.task_id,
            kind,
            claim: Claim::parse(&self.claim).ok_or_else(corrupt)?,
            trust,
            digest: self.digest,
            reference: self.reference,
            excerpt: self.excerpt,
            masked_count: u32::try_from(self.masked_count).map_err(|_| corrupt())?,
            recorded_by: self.recorded_by,
            observed_at: self.observed_at,
        })
    }
}

/// Every evidence record of a task, oldest first.
pub(super) fn task_evidence(
    conn: &rusqlite::Connection,
    profile: &str,
    task_id: &str,
) -> Result<Vec<EvidenceRecord>, LearningError> {
    conn.prepare(&format!(
        "SELECT {EVIDENCE_COLUMNS} FROM learning_evidence WHERE profile_id = ?1 AND task_id = ?2 ORDER BY evidence_id"
    ))?
    .query_map(params![profile, task_id], evidence_row)?
    .map(|row| row.map_err(LearningError::from).and_then(RawEvidence::decode))
    .collect()
}

/// Outcome and basis of a task with a result, from its verified evidence only. Unverified
/// (native report) and untrusted (observed) evidence never change the reported outcome.
pub(super) fn derive(task_state: TaskState, evidence: &[EvidenceRecord]) -> (Outcome, Basis) {
    let reported = if task_state == TaskState::Completed {
        Outcome::Success
    } else {
        Outcome::Failure
    };
    let verified: Vec<&EvidenceRecord> = evidence
        .iter()
        .filter(|record| record.trust == TrustStatus::Verified)
        .collect();
    let Some(first) = verified.first() else {
        return (reported, Basis::Unverified);
    };
    if verified.iter().any(|record| record.claim != first.claim) {
        return (Outcome::Disputed, Basis::Unverified);
    }
    let outcome = match first.claim {
        Claim::Success => Outcome::Success,
        Claim::Failure => Outcome::Failure,
    };
    let basis = if verified
        .iter()
        .any(|record| record.kind == EvidenceKind::TestGate)
    {
        Basis::VerifiedByExtalia
    } else {
        Basis::UserConfirmed
    };
    (outcome, basis)
}

/// The mission and task exist in this profile and the task belongs to the mission.
fn check_task(
    tx: &Transaction<'_>,
    profile: &str,
    mission_id: &str,
    task_id: &str,
) -> Result<(), LearningError> {
    let found: Option<String> = tx
        .query_row(
            "SELECT mission_id FROM tasks WHERE profile_id = ?1 AND task_id = ?2",
            params![profile, task_id],
            |row| row.get(0),
        )
        .optional()?;
    if found.as_deref() == Some(mission_id) {
        Ok(())
    } else {
        Err(LearningError::NotFound)
    }
}

fn load_experiences(
    conn: &rusqlite::Connection,
    profile: &str,
    filter: &str,
    key: &dyn rusqlite::ToSql,
) -> Result<Vec<Experience>, LearningError> {
    let mut statement = conn.prepare(&format!(
        "SELECT experience_id, workspace_id, mission_id, task_id, task_digest, agent_id, task_state,
                outcome, basis, summary, masked_count, created_at
         FROM learning_experiences WHERE profile_id = ?1 AND {filter} ORDER BY task_id"
    ))?;
    let rows = statement
        .query_map(params![profile, key], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                [
                    row.get::<_, String>(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ],
                row.get::<_, Option<String>>(5)?,
                [
                    row.get::<_, String>(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ],
                row.get::<_, i64>(10)?,
                row.get::<_, String>(11)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut links = conn.prepare(
        "SELECT evidence_id FROM learning_experience_evidence
         WHERE profile_id = ?1 AND experience_id = ?2 ORDER BY evidence_id",
    )?;
    let corrupt = || LearningError::Corrupt("experience row");
    rows.into_iter()
        .map(
            |(
                id,
                [workspace_id, mission_id, task_id, task_digest],
                agent_id,
                texts,
                masked,
                at,
            )| {
                let [task_state, outcome, basis, summary] = texts;
                let evidence_ids = links
                    .query_map(params![profile, id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<i64>>>()?;
                Ok(Experience {
                    id,
                    workspace_id,
                    mission_id,
                    task_id,
                    task_digest,
                    agent_id,
                    task_state: TaskState::parse(&task_state).ok_or_else(corrupt)?,
                    outcome: Outcome::parse(&outcome).ok_or_else(corrupt)?,
                    basis: Basis::parse(&basis).ok_or_else(corrupt)?,
                    summary,
                    masked_count: u32::try_from(masked).map_err(|_| corrupt())?,
                    evidence_ids,
                    created_at: at,
                })
            },
        )
        .collect()
}

/// Experiences by id, in the order asked; any id outside this profile is `NotFound`.
pub(super) fn experiences_by_id(
    conn: &rusqlite::Connection,
    profile: &str,
    ids: &[i64],
) -> Result<Vec<Experience>, LearningError> {
    ids.iter()
        .map(|id| {
            load_experiences(conn, profile, "experience_id = ?2", id)?
                .pop()
                .ok_or(LearningError::NotFound)
        })
        .collect()
}

/// The bounded, masked summary of a task: structured fields only, never model prose.
fn summary(
    task: &Task,
    outcome: Outcome,
    basis: Basis,
    evidence: &[EvidenceRecord],
) -> (String, usize) {
    let mut text = format!(
        "Task {} of mission {}: {} after {} attempt(s).\nOutcome: {} ({}).\n",
        task.id,
        task.mission_id,
        task.state.as_str(),
        task.attempt,
        outcome.as_str(),
        basis.as_str()
    );
    if !task.requirements.is_empty() {
        text.push_str("Requirements:\n");
        for requirement in &task.requirements {
            text.push_str("- ");
            text.push_str(requirement.trim());
            text.push('\n');
        }
    }
    text.push_str("Evidence:\n");
    for record in evidence {
        text.push_str(&format!(
            "- {} {} ({}): {}\n",
            record.kind.as_str(),
            record.claim.as_str(),
            record.trust.as_str(),
            record.reference
        ));
    }
    // Mask first, then cut: cutting first could split a credential so that it no longer
    // matches a pattern.
    let (masked, count) = mask(&text);
    (bounded(&masked, MAX_SUMMARY_BYTES), count)
}

impl Learning<'_> {
    /// Append evidence about a task (module documentation). Recording the same kind and
    /// digest for a task again returns the stored record; a different claim for the same
    /// digest is refused.
    pub fn record_evidence(
        &mut self,
        input: &EvidenceInput<'_>,
        now_ms: i64,
    ) -> Result<EvidenceRecord, LearningError> {
        let recorded_by = match input.kind {
            EvidenceKind::TaskResult => {
                return Err(LearningError::Denied("task_result_is_captured"));
            }
            EvidenceKind::UserConfirmation if is_user_principal(input.recorded_by) => {
                input.recorded_by.to_owned()
            }
            EvidenceKind::UserConfirmation => {
                return Err(LearningError::Denied("principal_not_user"));
            }
            EvidenceKind::TestGate | EvidenceKind::ObservedClaim => input
                .recorded_by
                .strip_prefix("extalia:")
                .and_then(extalia_principal)
                .ok_or(LearningError::Denied("principal_not_extalia"))?,
        };
        if !is_sha256(input.digest) {
            return Err(LearningError::Denied("invalid_digest"));
        }
        if !is_line(input.reference) {
            return Err(LearningError::Denied("invalid_reference"));
        }
        let (reference, mut masked) = mask(input.reference.trim());
        if reference.len() > MAX_REF_BYTES {
            return Err(LearningError::Denied("reference_too_long"));
        }
        let excerpt = match input.excerpt {
            Some(text) if !is_text(text) => return Err(LearningError::Denied("invalid_excerpt")),
            Some(text) => {
                let (text, count) = mask(text);
                masked += count;
                Some(bounded(&text, MAX_EXCERPT_BYTES))
            }
            None => None,
        };
        let profile = self.profile.as_str().to_owned();
        let tx = self
            .conn()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_task(&tx, &profile, input.mission_id, input.task_id)?;
        let existing = task_evidence(&tx, &profile, input.task_id)?;
        if let Some(found) = existing
            .iter()
            .find(|record| record.kind == input.kind && record.digest == input.digest)
        {
            return if found.claim == input.claim {
                Ok(found.clone())
            } else {
                Err(LearningError::Denied("evidence_conflict"))
            };
        }
        if existing.len() >= MAX_EVIDENCE_PER_TASK {
            return Err(LearningError::Denied("too_much_evidence"));
        }
        let id = insert_evidence(
            &tx,
            &profile,
            NewEvidence {
                mission_id: input.mission_id,
                task_id: input.task_id,
                kind: input.kind,
                claim: input.claim,
                digest: input.digest,
                reference: &reference,
                excerpt: excerpt.as_deref(),
                masked,
                recorded_by: &recorded_by,
            },
            &format_utc(now_ms),
        )?;
        let record = load_evidence(&tx, &profile, id)?;
        tx.commit()?;
        Ok(record)
    }

    /// Every evidence record of a task in this profile, oldest first.
    pub fn evidence(&mut self, task_id: &str) -> Result<Vec<EvidenceRecord>, LearningError> {
        let profile = self.profile.as_str().to_owned();
        task_evidence(self.conn(), &profile, task_id)
    }

    /// The experiences of a mission in this profile, by task id.
    pub fn experiences(&mut self, mission_id: &str) -> Result<Vec<Experience>, LearningError> {
        let profile = self.profile.as_str().to_owned();
        load_experiences(self.conn(), &profile, "mission_id = ?2", &mission_id)
    }

    /// Capture the L1 experiences of a finished native mission (module documentation).
    pub fn capture_mission(
        &mut self,
        mission_id: &str,
        now_ms: i64,
    ) -> Result<CaptureReport, LearningError> {
        let profile = self.profile.as_str().to_owned();
        let now = format_utc(now_ms);
        let tx = self
            .conn()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mission: Option<(String, String)> = tx
            .query_row(
                "SELECT workspace_id, state FROM missions WHERE profile_id = ?1 AND mission_id = ?2",
                params![profile, mission_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (workspace_id, state) = mission.ok_or(LearningError::NotFound)?;
        let state = MissionState::parse(&state).ok_or(LearningError::Corrupt("mission row"))?;
        if !state.terminal() {
            return Err(LearningError::Denied("mission_not_finished"));
        }
        let tasks: Vec<(String, String, String)> = tx
            .prepare(
                "SELECT task_id, digest, payload FROM tasks
                 WHERE profile_id = ?1 AND mission_id = ?2 ORDER BY task_id",
            )?
            .query_map(params![profile, mission_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut created = 0;
        let mut skipped = Vec::new();
        for (task_id, digest, payload) in tasks {
            let value: Value =
                serde_json::from_str(&payload).map_err(|_| LearningError::Corrupt("task row"))?;
            let task = contract::task(&value, "task", &mut Vec::new())
                .filter(|task| task.id == task_id && task.mission_id == mission_id)
                .ok_or(LearningError::Corrupt("task row"))?;
            if !matches!(task.state, TaskState::Completed | TaskState::Failed) {
                skipped.push(task_id);
                continue;
            }
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM learning_experiences
                 WHERE profile_id = ?1 AND mission_id = ?2 AND task_id = ?3)",
                params![profile, mission_id, task_id],
                |row| row.get(0),
            )?;
            if exists {
                continue;
            }
            let claim = if task.state == TaskState::Completed {
                Claim::Success
            } else {
                Claim::Failure
            };
            let reference = format!("task:{task_id}");
            if !task_evidence(&tx, &profile, &task_id)?
                .iter()
                .any(|record| record.kind == EvidenceKind::TaskResult && record.digest == digest)
            {
                insert_evidence(
                    &tx,
                    &profile,
                    NewEvidence {
                        mission_id,
                        task_id: &task_id,
                        kind: EvidenceKind::TaskResult,
                        claim,
                        digest: &digest,
                        reference: &reference,
                        excerpt: None,
                        masked: 0,
                        recorded_by: LEARNING_PRINCIPAL,
                    },
                    &now,
                )?;
            }
            let evidence = task_evidence(&tx, &profile, &task_id)?;
            let (outcome, basis) = derive(task.state, &evidence);
            let (text, masked) = summary(&task, outcome, basis, &evidence);
            tx.execute(
                "INSERT INTO learning_experiences (profile_id, workspace_id, mission_id, task_id,
                   task_digest, agent_id, origin, task_state, outcome, basis, summary, masked_count, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'native', ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    profile,
                    workspace_id,
                    mission_id,
                    task_id,
                    digest,
                    task.assigned_agent_id,
                    task.state.as_str(),
                    outcome.as_str(),
                    basis.as_str(),
                    text,
                    masked as i64,
                    now
                ],
            )?;
            let experience_id = tx.last_insert_rowid();
            for record in &evidence {
                tx.execute(
                    "INSERT INTO learning_experience_evidence (profile_id, experience_id, evidence_id)
                     VALUES (?1, ?2, ?3)",
                    params![profile, experience_id, record.id],
                )?;
            }
            created += 1;
        }
        let experiences = load_experiences(&tx, &profile, "mission_id = ?2", &mission_id)?;
        tx.commit()?;
        Ok(CaptureReport {
            mission_id: mission_id.to_owned(),
            created,
            experiences,
            skipped,
        })
    }
}

struct NewEvidence<'a> {
    mission_id: &'a str,
    task_id: &'a str,
    kind: EvidenceKind,
    claim: Claim,
    digest: &'a str,
    reference: &'a str,
    excerpt: Option<&'a str>,
    masked: usize,
    recorded_by: &'a str,
}

fn insert_evidence(
    tx: &Transaction<'_>,
    profile: &str,
    evidence: NewEvidence<'_>,
    now: &str,
) -> Result<i64, LearningError> {
    tx.execute(
        "INSERT INTO learning_evidence (profile_id, mission_id, task_id, kind, claim, trust_status,
           digest, ref, excerpt, masked_count, recorded_by, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            profile,
            evidence.mission_id,
            evidence.task_id,
            evidence.kind.as_str(),
            evidence.claim.as_str(),
            evidence.kind.trust().as_str(),
            evidence.digest,
            evidence.reference,
            evidence.excerpt,
            evidence.masked as i64,
            evidence.recorded_by,
            now
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

fn load_evidence(
    conn: &rusqlite::Connection,
    profile: &str,
    id: i64,
) -> Result<EvidenceRecord, LearningError> {
    conn.query_row(
        &format!(
            "SELECT {EVIDENCE_COLUMNS} FROM learning_evidence WHERE profile_id = ?1 AND evidence_id = ?2"
        ),
        params![profile, id],
        evidence_row,
    )
    .optional()?
    .ok_or(LearningError::NotFound)?
    .decode()
}
