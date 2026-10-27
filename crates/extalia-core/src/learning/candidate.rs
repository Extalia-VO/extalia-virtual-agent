//! L2/L3 candidate proposals and the user's decisions (module documentation of [`super`]).

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};

use super::capture::{derive, experiences_by_id, task_evidence};
use super::{
    Basis, CandidateKind, CandidateState, DecisionAction, Experience, KNOWLEDGE_FOLDERS,
    LEARNING_PRINCIPAL, Learning, LearningError, MAX_CANDIDATE_EXPERIENCES, MAX_FINDING_BYTES,
    MAX_OPEN_CANDIDATES, MAX_PROPOSAL_BYTES, MAX_RATIONALE_BYTES, MAX_TITLE_BYTES,
    MIN_VERIFIED_EXPERIENCES, Outcome, SKILL_INBOX_DIR, bounded, extalia_principal, is_line,
    is_text, mask,
};
use crate::knowledge::vault::set_mode;
use crate::knowledge::write::validate_note_path;
use crate::knowledge::{
    Author, ConflictReason, Expected, History, Vault, WriteOutcome, read_note, write_note,
};
use crate::sha256::hex_digest;
use crate::skills::is_package_name;
use crate::skills::manifest::parse_front_matter;
use crate::skills::review::is_user_principal;
use crate::time::format_utc;

const PRIVATE_FILE_MODE: u32 = 0o600;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const SKILL_FILE: &str = "SKILL.md";
/// Characters of a decision note (as for skill reviews).
const MAX_NOTE_CHARS: usize = 2_000;
/// The component name used for note writes ([`Author::Extalia`]).
const WRITE_COMPONENT: &str = "learning";

/// A managed-note proposal (L2). Nothing is written until the user accepts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeProposal<'a> {
    /// One line, at most [`super::MAX_TITLE_BYTES`] bytes.
    pub title: &'a str,
    /// The finding (inferred text; it gains no trust from being proposed), at most
    /// [`super::MAX_FINDING_BYTES`] bytes.
    pub finding: &'a str,
    /// Vault-relative note path below one of [`KNOWLEDGE_FOLDERS`]; default
    /// `Knowledge/<slug of the title>.md`.
    pub target_path: Option<&'a str>,
    /// The experiences the finding relies on (this profile only).
    pub experience_ids: &'a [i64],
    pub rationale: &'a str,
    /// The proposing Extalia component (`^[a-z][a-z0-9-]{0,31}$`).
    pub component: &'a str,
}

/// A skill package proposal (L3): a Markdown-only `SKILL.md`, no manifest and therefore no
/// declared permissions. It never enters the skill tables here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillProposal<'a> {
    /// The package name (`^[a-z0-9][a-z0-9-]{0,63}$`).
    pub name: &'a str,
    /// One line, at most [`super::MAX_TITLE_BYTES`] bytes.
    pub description: &'a str,
    /// At most [`super::MAX_FINDING_BYTES`] bytes.
    pub instructions: &'a str,
    pub experience_ids: &'a [i64],
    pub rationale: &'a str,
    pub component: &'a str,
}

/// How strong a candidate's basis is ([`assess`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Assessment {
    /// Experiences with a verified successful outcome.
    pub verified: u32,
    /// All experiences cited.
    pub samples: u32,
    /// `None`: sufficient. Otherwise why the candidate is `insufficient_evidence`.
    pub reason: Option<&'static str>,
}

/// `insufficient_evidence` rules (ADR 0027 §5, ADR 0029 §6), in this order:
/// `disputed_evidence` (verified evidence disagrees about an outcome),
/// `no_verified_evidence` (no verified success at all: only native reports or observed
/// claims), `too_few_verified` (fewer than [`MIN_VERIFIED_EXPERIENCES`] verified successes)
/// and `contradicted` (at least as many verified failures as verified successes).
pub fn assess(outcomes: &[(Outcome, Basis)]) -> Assessment {
    let count = |wanted: Outcome| {
        outcomes
            .iter()
            .filter(|(outcome, basis)| *outcome == wanted && basis.verified())
            .count() as u32
    };
    let (successes, failures) = (count(Outcome::Success), count(Outcome::Failure));
    let reason = if outcomes
        .iter()
        .any(|(outcome, _)| *outcome == Outcome::Disputed)
    {
        Some("disputed_evidence")
    } else if successes == 0 {
        Some("no_verified_evidence")
    } else if successes < MIN_VERIFIED_EXPERIENCES {
        Some("too_few_verified")
    } else if failures >= successes {
        Some("contradicted")
    } else {
        None
    };
    Assessment {
        verified: successes,
        samples: outcomes.len() as u32,
        reason,
    }
}

/// A stored candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: i64,
    pub kind: CandidateKind,
    pub state: CandidateState,
    /// Knowledge: the vault-relative note path. Skill: the package name.
    pub target_ref: String,
    /// Knowledge: the note's SHA-256 the proposal was built against (`None`: absent).
    pub base_sha256: Option<String>,
    /// The proposed note or `SKILL.md`.
    pub proposal: String,
    /// SHA-256 of `proposal`; every decision must cite it.
    pub proposal_digest: String,
    pub rationale: String,
    /// The `insufficient_evidence` reason code.
    pub reason: Option<String>,
    pub verified_count: u32,
    pub sample_count: u32,
    pub proposed_by: String,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub decided_by: Option<String>,
    pub experience_ids: Vec<i64>,
    pub evidence_ids: Vec<i64>,
    /// Skill: the package directory an accept stages, relative to
    /// `<data>/profiles/<profile-id>/` (`skill-inbox/<name>-<12 hex of the digest>`).
    pub staging_ref: Option<String>,
}

/// A record of the decision history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionRecord {
    pub id: i64,
    pub action: DecisionAction,
    pub from_state: Option<CandidateState>,
    pub to_state: CandidateState,
    pub principal: String,
    pub proposal_digest: String,
    pub outcome_ref: Option<String>,
    pub note: Option<String>,
    pub at: String,
}

/// The local user's decision on a candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionRequest<'a> {
    pub candidate_id: i64,
    /// `user:<id>`; agents, models, Extalia components and policies cannot decide.
    pub principal: &'a str,
    /// The proposal digest the user was shown.
    pub proposal_digest: &'a str,
    pub note: Option<&'a str>,
}

/// What a decision did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionOutcome {
    Rejected,
    /// A knowledge candidate was accepted: the managed note now has `sha256`.
    Written {
        path: String,
        sha256: String,
    },
    /// A skill candidate was accepted: its package waits in the inbox for the W3 import.
    Staged {
        package_dir: PathBuf,
        staging_ref: String,
    },
    /// Nothing was replaced; the proposal is the conflict copy at `conflict_path` and the
    /// candidate stays `proposed`.
    Conflict {
        conflict_path: String,
        reason: ConflictReason,
    },
    /// The evidence no longer suffices: the candidate is now `insufficient_evidence`.
    Revalidated {
        reason: &'static str,
    },
}

const CANDIDATE_COLUMNS: &str = "candidate_id, kind, state, target_ref, base_sha256, proposal, proposal_digest, rationale, reason, verified_count, sample_count, proposed_by, created_at, decided_at, decided_by";

fn load_candidate(
    conn: &rusqlite::Connection,
    profile: &str,
    id: i64,
) -> Result<Candidate, LearningError> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {CANDIDATE_COLUMNS} FROM learning_candidates WHERE profile_id = ?1 AND candidate_id = ?2"
            ),
            params![profile, id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    [
                        row.get::<_, String>(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ],
                    row.get::<_, Option<String>>(4)?,
                    [
                        row.get::<_, String>(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ],
                    row.get::<_, Option<String>>(8)?,
                    (row.get::<_, i64>(9)?, row.get::<_, i64>(10)?),
                    [row.get::<_, String>(11)?, row.get(12)?],
                    [
                        row.get::<_, Option<String>>(13)?,
                        row.get(14)?,
                    ],
                ))
            },
        )
        .optional()?
        .ok_or(LearningError::NotFound)?;
    let (id, [kind, state, target_ref], base_sha256, texts, reason, counts, by, decided) = row;
    let [proposal, proposal_digest, rationale] = texts;
    let [proposed_by, created_at] = by;
    let [decided_at, decided_by] = decided;
    let corrupt = || LearningError::Corrupt("candidate row");
    let kind = CandidateKind::parse(&kind).ok_or_else(corrupt)?;
    let ids = |table: &str, column: &str| -> Result<Vec<i64>, LearningError> {
        Ok(conn
            .prepare(&format!(
                "SELECT {column} FROM {table} WHERE profile_id = ?1 AND candidate_id = ?2 ORDER BY {column}"
            ))?
            .query_map(params![profile, id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?)
    };
    let staging_ref = (kind == CandidateKind::Skill)
        .then(|| staging_ref(&target_ref, &proposal_digest))
        .flatten();
    Ok(Candidate {
        id,
        kind,
        state: CandidateState::parse(&state).ok_or_else(corrupt)?,
        target_ref,
        base_sha256,
        proposal,
        proposal_digest,
        rationale,
        reason,
        verified_count: u32::try_from(counts.0).map_err(|_| corrupt())?,
        sample_count: u32::try_from(counts.1).map_err(|_| corrupt())?,
        proposed_by,
        created_at,
        decided_at,
        decided_by,
        experience_ids: ids("learning_candidate_experiences", "experience_id")?,
        evidence_ids: ids("learning_candidate_evidence", "evidence_id")?,
        staging_ref,
    })
}

/// `skill-inbox/<name>-<first 12 hex of the proposal digest>`.
fn staging_ref(name: &str, digest: &str) -> Option<String> {
    (is_package_name(name) && digest.len() == 64)
        .then(|| format!("{SKILL_INBOX_DIR}/{name}-{}", &digest[..12]))
}

/// A lowercase ASCII slug of at most 64 bytes (`finding` when nothing is left).
fn slug(title: &str) -> String {
    let mut out = String::new();
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 64 {
            break;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "finding".to_owned()
    } else {
        out.to_owned()
    }
}

fn evidence_lines(experiences: &[(Experience, Outcome, Basis)]) -> String {
    experiences
        .iter()
        .map(|(experience, outcome, basis)| {
            format!(
                "- Mission {}, task {}: {} ({})\n",
                experience.mission_id,
                experience.task_id,
                outcome.as_str(),
                basis.as_str()
            )
        })
        .collect()
}

/// Validated, masked free text.
fn text_field(
    text: &str,
    max: usize,
    one_line: bool,
    invalid: &'static str,
) -> Result<String, LearningError> {
    let valid = if one_line {
        is_line(text)
    } else {
        is_text(text)
    };
    if !valid || text.len() > max {
        return Err(LearningError::Denied(invalid));
    }
    Ok(mask(text.trim()).0)
}

fn valid_ids(ids: &[i64]) -> Result<(), LearningError> {
    let unique: BTreeSet<_> = ids.iter().collect();
    if ids.is_empty() || ids.len() > MAX_CANDIDATE_EXPERIENCES || unique.len() != ids.len() {
        return Err(LearningError::Denied("invalid_experience_ids"));
    }
    Ok(())
}

struct NewCandidate {
    kind: CandidateKind,
    target_ref: String,
    base_sha256: Option<String>,
    proposal: String,
    rationale: String,
    proposed_by: String,
    assessment: Assessment,
    experiences: Vec<Experience>,
}

impl Learning<'_> {
    /// One candidate of this profile.
    pub fn candidate(&mut self, candidate_id: i64) -> Result<Candidate, LearningError> {
        let profile = self.profile.as_str().to_owned();
        load_candidate(self.conn(), &profile, candidate_id)
    }

    /// The newest candidates of this profile (at most 200), optionally in one state.
    pub fn candidates(
        &mut self,
        state: Option<CandidateState>,
    ) -> Result<Vec<Candidate>, LearningError> {
        let profile = self.profile.as_str().to_owned();
        let conn = self.conn();
        let ids: Vec<i64> = conn
            .prepare(
                "SELECT candidate_id FROM learning_candidates
                 WHERE profile_id = ?1 AND (?2 IS NULL OR state = ?2)
                 ORDER BY candidate_id DESC LIMIT 200",
            )?
            .query_map(params![profile, state.map(CandidateState::as_str)], |row| {
                row.get(0)
            })?
            .collect::<rusqlite::Result<_>>()?;
        ids.into_iter()
            .map(|id| load_candidate(conn, &profile, id))
            .collect()
    }

    /// The decision history of a candidate, oldest first.
    pub fn decisions(&mut self, candidate_id: i64) -> Result<Vec<DecisionRecord>, LearningError> {
        let profile = self.profile.as_str().to_owned();
        let conn = self.conn();
        load_candidate(conn, &profile, candidate_id)?;
        let rows = conn
            .prepare(
                "SELECT decision_id, action, from_state, to_state, principal, proposal_digest,
                        outcome_ref, note, at
                 FROM learning_candidate_decisions WHERE profile_id = ?1 AND candidate_id = ?2
                 ORDER BY decision_id",
            )?
            .query_map(params![profile, candidate_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    [row.get::<_, String>(4)?, row.get(5)?, row.get(8)?],
                    [row.get::<_, Option<String>>(6)?, row.get(7)?],
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let corrupt = || LearningError::Corrupt("decision row");
        rows.into_iter()
            .map(
                |(id, action, from, to, [principal, proposal_digest, at], [outcome_ref, note])| {
                    Ok(DecisionRecord {
                        id,
                        action: DecisionAction::parse(&action).ok_or_else(corrupt)?,
                        from_state: match from {
                            Some(from) => Some(CandidateState::parse(&from).ok_or_else(corrupt)?),
                            None => None,
                        },
                        to_state: CandidateState::parse(&to).ok_or_else(corrupt)?,
                        principal,
                        proposal_digest,
                        outcome_ref,
                        note,
                        at,
                    })
                },
            )
            .collect()
    }

    /// Experiences with their outcome and basis derived from the evidence recorded *now*
    /// (revalidation: evidence added after capture counts, for and against).
    fn current_basis(
        &mut self,
        ids: &[i64],
    ) -> Result<Vec<(Experience, Outcome, Basis)>, LearningError> {
        let profile = self.profile.as_str().to_owned();
        let conn = self.conn();
        experiences_by_id(conn, &profile, ids)?
            .into_iter()
            .map(|experience| {
                let evidence = task_evidence(conn, &profile, &experience.task_id)?;
                let (outcome, basis) = derive(experience.task_state, &evidence);
                Ok((experience, outcome, basis))
            })
            .collect()
    }

    /// Propose a managed-note update (L2). Reads the target note but writes nothing.
    pub fn propose_knowledge(
        &mut self,
        vault: &Vault,
        proposal: &KnowledgeProposal<'_>,
        now_ms: i64,
    ) -> Result<Candidate, LearningError> {
        if vault.profile() != &self.profile {
            return Err(LearningError::WrongProfile);
        }
        let proposed_by = extalia_principal(proposal.component)
            .ok_or(LearningError::Denied("invalid_component"))?;
        let title = text_field(proposal.title, MAX_TITLE_BYTES, true, "invalid_title")?;
        let finding = text_field(
            proposal.finding,
            MAX_FINDING_BYTES,
            false,
            "invalid_finding",
        )?;
        let rationale = rationale(proposal.rationale)?;
        valid_ids(proposal.experience_ids)?;
        let slug = slug(&title);
        let target = match proposal.target_path {
            Some(path) => path.to_owned(),
            None => format!("Knowledge/{slug}.md"),
        };
        validate_note_path(&target, vault.limits())
            .map_err(|_| LearningError::Denied("invalid_target_path"))?;
        if !KNOWLEDGE_FOLDERS
            .iter()
            .any(|folder| target.split('/').next() == Some(folder) && target.contains('/'))
        {
            return Err(LearningError::Denied("target_folder_not_allowed"));
        }
        let basis = self.current_basis(proposal.experience_ids)?;
        let assessment = assess(
            &basis
                .iter()
                .map(|(_, outcome, basis)| (*outcome, *basis))
                .collect::<Vec<_>>(),
        );
        let evidence = evidence_lines(&basis);
        let current = read_note(vault, &target)?;
        let content = match &current {
            // Merge into an Extalia-managed note: keep every line (human edits included).
            Some(note) if note.managed => {
                let mut text = note.text.clone();
                if !text.ends_with('\n') {
                    text.push('\n');
                }
                format!(
                    "{text}\n## {title} (learned {})\n\n{finding}\n\nEvidence:\n\n{evidence}",
                    &format_utc(now_ms)[..10]
                )
            }
            // A new note, or a standalone managed proposal next to a user note (an accept
            // then becomes a conflict copy: Extalia never replaces a user's note).
            _ => {
                let tasks: Vec<&str> = basis
                    .iter()
                    .map(|(experience, _, _)| experience.task_id.as_str())
                    .collect();
                let verification = if assessment.reason.is_none() {
                    "verified"
                } else {
                    "unverified"
                };
                format!(
                    "---\nid: know.{slug}\nkind: knowledge\nprofile: {}\nverification: {verification}\n\
                     source_task_ids: [{}]\nmanaged_by: extalia\nsource: learning\n---\n\
                     # {title}\n\n{finding}\n\n## Evidence\n\n{evidence}",
                    self.profile.as_str(),
                    tasks.join(", ")
                )
            }
        };
        if content.len() > MAX_PROPOSAL_BYTES
            || content.len() as u64 > vault.limits().max_file_bytes
        {
            return Err(LearningError::Denied("proposal_too_large"));
        }
        self.insert_candidate(
            NewCandidate {
                kind: CandidateKind::Knowledge,
                target_ref: target,
                base_sha256: current.map(|note| note.sha256),
                proposal: content,
                rationale,
                proposed_by,
                assessment,
                experiences: basis
                    .into_iter()
                    .map(|(experience, _, _)| experience)
                    .collect(),
            },
            now_ms,
        )
    }

    /// Propose a skill package (L3). Writes nothing and never touches the skill tables.
    pub fn propose_skill(
        &mut self,
        proposal: &SkillProposal<'_>,
        now_ms: i64,
    ) -> Result<Candidate, LearningError> {
        let proposed_by = extalia_principal(proposal.component)
            .ok_or(LearningError::Denied("invalid_component"))?;
        if !is_package_name(proposal.name) {
            return Err(LearningError::Denied("invalid_skill_name"));
        }
        let description = text_field(
            proposal.description,
            MAX_TITLE_BYTES,
            true,
            "invalid_description",
        )?;
        let instructions = text_field(
            proposal.instructions,
            MAX_FINDING_BYTES,
            false,
            "invalid_instructions",
        )?;
        let rationale = rationale(proposal.rationale)?;
        valid_ids(proposal.experience_ids)?;
        let basis = self.current_basis(proposal.experience_ids)?;
        let assessment = assess(
            &basis
                .iter()
                .map(|(_, outcome, basis)| (*outcome, *basis))
                .collect::<Vec<_>>(),
        );
        let content = format!(
            "---\nname: {}\ndescription: {description}\n---\n{instructions}\n\n## Provenance\n\n\
             Proposed by {proposed_by} from {} experience(s). Not active: it must be imported, \
             inspected and approved like any other skill.\n\n{}",
            proposal.name,
            basis.len(),
            evidence_lines(&basis)
        );
        if content.len() > MAX_PROPOSAL_BYTES || parse_front_matter(content.as_bytes()).is_err() {
            return Err(LearningError::Denied("invalid_skill_md"));
        }
        self.insert_candidate(
            NewCandidate {
                kind: CandidateKind::Skill,
                target_ref: proposal.name.to_owned(),
                base_sha256: None,
                proposal: content,
                rationale,
                proposed_by,
                assessment,
                experiences: basis
                    .into_iter()
                    .map(|(experience, _, _)| experience)
                    .collect(),
            },
            now_ms,
        )
    }

    fn insert_candidate(
        &mut self,
        new: NewCandidate,
        now_ms: i64,
    ) -> Result<Candidate, LearningError> {
        let profile = self.profile.as_str().to_owned();
        let now = format_utc(now_ms);
        let digest = hex_digest(new.proposal.as_bytes());
        let state = if new.assessment.reason.is_some() {
            CandidateState::InsufficientEvidence
        } else {
            CandidateState::Proposed
        };
        let tx = self
            .conn()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let open: Option<(i64, String, String)> = tx
            .query_row(
                "SELECT candidate_id, state, proposal_digest FROM learning_candidates
                 WHERE profile_id = ?1 AND kind = ?2 AND target_ref = ?3
                   AND state IN ('proposed', 'insufficient_evidence')",
                params![profile, new.kind.as_str(), new.target_ref],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((id, open_state, open_digest)) = &open {
            if *open_digest == digest && open_state.as_str() == state.as_str() {
                // The same proposal again: idempotent.
                let candidate = load_candidate(&tx, &profile, *id)?;
                return Ok(candidate);
            }
            let from =
                CandidateState::parse(open_state).ok_or(LearningError::Corrupt("candidate row"))?;
            decide(
                &tx,
                &profile,
                Transition {
                    candidate_id: *id,
                    action: DecisionAction::Supersede,
                    from: Some(from),
                    to: CandidateState::Superseded,
                    principal: LEARNING_PRINCIPAL,
                    digest: open_digest,
                    outcome_ref: None,
                    note: None,
                    reason: None,
                },
                &now,
            )?;
        } else {
            let open_count: i64 = tx.query_row(
                "SELECT count(*) FROM learning_candidates
                 WHERE profile_id = ?1 AND state IN ('proposed', 'insufficient_evidence')",
                [&profile],
                |row| row.get(0),
            )?;
            if open_count as usize >= MAX_OPEN_CANDIDATES {
                return Err(LearningError::Denied("too_many_open_candidates"));
            }
        }
        tx.execute(
            "INSERT INTO learning_candidates (profile_id, kind, state, target_ref, base_sha256,
               proposal, proposal_digest, rationale, reason, verified_count, sample_count,
               proposed_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                profile,
                new.kind.as_str(),
                state.as_str(),
                new.target_ref,
                new.base_sha256,
                new.proposal,
                digest,
                new.rationale,
                new.assessment.reason,
                new.assessment.verified,
                new.assessment.samples,
                new.proposed_by,
                now
            ],
        )?;
        let id = tx.last_insert_rowid();
        decide(
            &tx,
            &profile,
            Transition {
                candidate_id: id,
                action: DecisionAction::Propose,
                from: None,
                to: state,
                principal: &new.proposed_by,
                digest: &digest,
                outcome_ref: None,
                note: None,
                reason: None,
            },
            &now,
        )?;
        let mut evidence = BTreeSet::new();
        for experience in &new.experiences {
            tx.execute(
                "INSERT INTO learning_candidate_experiences (profile_id, candidate_id, experience_id)
                 VALUES (?1, ?2, ?3)",
                params![profile, id, experience.id],
            )?;
            evidence.extend(experience.evidence_ids.iter().copied());
        }
        for evidence_id in evidence {
            tx.execute(
                "INSERT INTO learning_candidate_evidence (profile_id, candidate_id, evidence_id)
                 VALUES (?1, ?2, ?3)",
                params![profile, id, evidence_id],
            )?;
        }
        let candidate = load_candidate(&tx, &profile, id)?;
        tx.commit()?;
        Ok(candidate)
    }

    /// The candidate a request names, after the checks every decision shares.
    fn decidable(
        &mut self,
        request: &DecisionRequest<'_>,
        kind: Option<CandidateKind>,
    ) -> Result<Candidate, LearningError> {
        if !is_user_principal(request.principal) {
            return Err(LearningError::Denied("principal_not_user"));
        }
        if let Some(note) = request.note
            && (!is_text(note) || note.chars().count() > MAX_NOTE_CHARS)
        {
            return Err(LearningError::Denied("invalid_note"));
        }
        let candidate = self.candidate(request.candidate_id)?;
        if kind.is_some_and(|kind| kind != candidate.kind) {
            return Err(LearningError::Denied("wrong_kind"));
        }
        if request.proposal_digest != candidate.proposal_digest {
            return Err(LearningError::Denied("proposal_digest_mismatch"));
        }
        let allowed = match kind {
            Some(_) => candidate.state == CandidateState::Proposed,
            None => candidate.state.open(),
        };
        if !allowed {
            return Err(LearningError::WrongState(candidate.state));
        }
        Ok(candidate)
    }

    /// Record a decision of the user, or of the core for revalidation, in one transaction.
    fn record(
        &mut self,
        candidate: &Candidate,
        transition: Transition<'_>,
        now_ms: i64,
    ) -> Result<(), LearningError> {
        let profile = self.profile.as_str().to_owned();
        let tx = self
            .conn()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Single writer per store (ADR 0019): still re-check inside the transaction.
        let state: String = tx.query_row(
            "SELECT state FROM learning_candidates WHERE profile_id = ?1 AND candidate_id = ?2",
            params![profile, candidate.id],
            |row| row.get(0),
        )?;
        if state != candidate.state.as_str() {
            return Err(LearningError::Denied("candidate_changed"));
        }
        decide(&tx, &profile, transition, &format_utc(now_ms))?;
        tx.commit()?;
        Ok(())
    }

    /// `proposed` → `insufficient_evidence` when the current evidence no longer suffices.
    fn revalidate(
        &mut self,
        candidate: &Candidate,
        now_ms: i64,
    ) -> Result<Option<&'static str>, LearningError> {
        let basis = self.current_basis(&candidate.experience_ids)?;
        let assessment = assess(
            &basis
                .iter()
                .map(|(_, outcome, basis)| (*outcome, *basis))
                .collect::<Vec<_>>(),
        );
        let Some(reason) = assessment.reason else {
            return Ok(None);
        };
        self.record(
            candidate,
            Transition {
                candidate_id: candidate.id,
                action: DecisionAction::Revalidate,
                from: Some(CandidateState::Proposed),
                to: CandidateState::InsufficientEvidence,
                principal: LEARNING_PRINCIPAL,
                digest: &candidate.proposal_digest,
                outcome_ref: None,
                note: None,
                reason: Some(reason),
            },
            now_ms,
        )?;
        Ok(Some(reason))
    }

    /// Reject an open candidate (the user's decision; nothing else changes).
    pub fn reject(
        &mut self,
        request: &DecisionRequest<'_>,
        now_ms: i64,
    ) -> Result<DecisionOutcome, LearningError> {
        let candidate = self.decidable(request, None)?;
        self.record(
            &candidate,
            Transition {
                candidate_id: candidate.id,
                action: DecisionAction::Reject,
                from: Some(candidate.state),
                to: CandidateState::Rejected,
                principal: request.principal,
                digest: &candidate.proposal_digest,
                outcome_ref: None,
                note: request.note,
                reason: None,
            },
            now_ms,
        )?;
        Ok(DecisionOutcome::Rejected)
    }

    /// Accept a knowledge candidate: revalidate, then write the proposal through the CAS
    /// path as Extalia, which only creates or replaces managed notes. A user note or a note
    /// that changed since the proposal becomes a conflict copy; the candidate stays proposed.
    pub fn accept_knowledge(
        &mut self,
        request: &DecisionRequest<'_>,
        vault: &Vault,
        history: &History,
        now_ms: i64,
    ) -> Result<DecisionOutcome, LearningError> {
        if vault.profile() != &self.profile || history.profile() != &self.profile {
            return Err(LearningError::WrongProfile);
        }
        let candidate = self.decidable(request, Some(CandidateKind::Knowledge))?;
        if let Some(reason) = self.revalidate(&candidate, now_ms)? {
            return Ok(DecisionOutcome::Revalidated { reason });
        }
        let target = candidate.target_ref.as_str();
        let current = read_note(vault, target)?;
        let outcome = if current
            .as_ref()
            .is_some_and(|note| note.sha256 == candidate.proposal_digest)
        {
            // Already written by an earlier accept whose record did not commit.
            WriteOutcome::Unchanged {
                path: target.to_owned(),
                sha256: candidate.proposal_digest.clone(),
            }
        } else {
            let expected = match &candidate.base_sha256 {
                Some(sha) => Expected::Sha256(sha.clone()),
                None => Expected::Absent,
            };
            write_note(
                vault,
                history,
                target,
                &candidate.proposal,
                &expected,
                Author::Extalia {
                    component: WRITE_COMPONENT,
                },
            )?
        };
        match outcome {
            WriteOutcome::Written { path, sha256, .. }
            | WriteOutcome::Unchanged { path, sha256 } => {
                let outcome_ref = format!("{path}@{sha256}");
                self.record(
                    &candidate,
                    Transition {
                        candidate_id: candidate.id,
                        action: DecisionAction::Accept,
                        from: Some(CandidateState::Proposed),
                        to: CandidateState::Accepted,
                        principal: request.principal,
                        digest: &candidate.proposal_digest,
                        outcome_ref: Some(&outcome_ref),
                        note: request.note,
                        reason: None,
                    },
                    now_ms,
                )?;
                Ok(DecisionOutcome::Written { path, sha256 })
            }
            WriteOutcome::Conflict {
                conflict_path,
                reason,
                ..
            } => {
                self.record(
                    &candidate,
                    Transition {
                        candidate_id: candidate.id,
                        action: DecisionAction::Conflict,
                        from: Some(CandidateState::Proposed),
                        to: CandidateState::Proposed,
                        principal: request.principal,
                        digest: &candidate.proposal_digest,
                        outcome_ref: Some(&conflict_path),
                        note: request.note,
                        reason: None,
                    },
                    now_ms,
                )?;
                Ok(DecisionOutcome::Conflict {
                    conflict_path,
                    reason,
                })
            }
        }
    }

    /// Accept a skill candidate: revalidate, then only stage its `SKILL.md` into the
    /// profile's skill inbox for the normal W3 import (quarantine, inspection, approval).
    pub fn accept_skill(
        &mut self,
        request: &DecisionRequest<'_>,
        now_ms: i64,
    ) -> Result<DecisionOutcome, LearningError> {
        let candidate = self.decidable(request, Some(CandidateKind::Skill))?;
        if let Some(reason) = self.revalidate(&candidate, now_ms)? {
            return Ok(DecisionOutcome::Revalidated { reason });
        }
        let staging_ref = candidate
            .staging_ref
            .clone()
            .ok_or(LearningError::Corrupt("candidate row"))?;
        let package_dir = self.stage_skill(&candidate, &staging_ref)?;
        self.record(
            &candidate,
            Transition {
                candidate_id: candidate.id,
                action: DecisionAction::Accept,
                from: Some(CandidateState::Proposed),
                to: CandidateState::Accepted,
                principal: request.principal,
                digest: &candidate.proposal_digest,
                outcome_ref: Some(&staging_ref),
                note: request.note,
                reason: None,
            },
            now_ms,
        )?;
        Ok(DecisionOutcome::Staged {
            package_dir,
            staging_ref,
        })
    }

    /// Write `SKILL.md` (and nothing else) into a new private inbox folder. A folder that
    /// already holds exactly this file is reused; anything else there refuses the stage.
    fn stage_skill(
        &self,
        candidate: &Candidate,
        staging_ref: &str,
    ) -> Result<PathBuf, LearningError> {
        let profiles = self.data_dir.join("profiles");
        let profile_dir = self.profile_dir();
        let inbox = self.skill_inbox();
        let dir = self.profile_dir().join(staging_ref);
        for folder in [&profiles, &profile_dir, &inbox, &dir] {
            private_dir(folder)?;
        }
        let file = dir.join(SKILL_FILE);
        match fs::symlink_metadata(&file) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, PRIVATE_FILE_MODE);
                let mut handle = options.open(&file)?;
                handle.write_all(candidate.proposal.as_bytes())?;
                handle.sync_all()?;
            }
            Err(error) => return Err(error.into()),
        }
        // The folder must hold exactly the proposed bytes, so the import stages what the
        // user accepted (the W3 import re-hashes and quarantines it anyway).
        let entries = fs::read_dir(&dir)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<io::Result<Vec<_>>>()?;
        if entries.len() != 1 || entries[0] != SKILL_FILE || !is_exact_file(&file, candidate)? {
            return Err(LearningError::Denied("inbox_occupied"));
        }
        Ok(dir)
    }
}

/// A regular, single-link file whose bytes hash to the proposal digest.
fn is_exact_file(path: &Path, candidate: &Candidate) -> Result<bool, LearningError> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_file() || link_count(&meta) != 1 {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_PROPOSAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(hex_digest(&bytes) == candidate.proposal_digest)
}

/// Create a private folder, or accept an existing real one (never a symbolic link).
fn private_dir(path: &Path) -> Result<(), LearningError> {
    match fs::create_dir(path) {
        Ok(()) => set_mode(path, PRIVATE_DIRECTORY_MODE)?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    if fs::symlink_metadata(path)?.file_type().is_dir() {
        Ok(())
    } else {
        Err(LearningError::Denied("inbox_unsafe"))
    }
}

#[cfg(unix)]
fn link_count(meta: &fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::nlink(meta)
}

#[cfg(not(unix))]
fn link_count(_meta: &fs::Metadata) -> u64 {
    1
}

fn rationale(text: &str) -> Result<String, LearningError> {
    if !is_text(text) {
        return Err(LearningError::Denied("invalid_rationale"));
    }
    Ok(bounded(&mask(text.trim()).0, MAX_RATIONALE_BYTES))
}

/// One decision record and, when the state changes, the candidate update it explains.
struct Transition<'a> {
    candidate_id: i64,
    action: DecisionAction,
    from: Option<CandidateState>,
    to: CandidateState,
    principal: &'a str,
    digest: &'a str,
    outcome_ref: Option<&'a str>,
    note: Option<&'a str>,
    /// The `insufficient_evidence` reason of a revalidation.
    reason: Option<&'a str>,
}

fn decide(
    tx: &Transaction<'_>,
    profile: &str,
    transition: Transition<'_>,
    now: &str,
) -> Result<(), LearningError> {
    tx.execute(
        "INSERT INTO learning_candidate_decisions (profile_id, candidate_id, action, from_state,
           to_state, principal, proposal_digest, outcome_ref, note, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            profile,
            transition.candidate_id,
            transition.action.as_str(),
            transition.from.map(CandidateState::as_str),
            transition.to.as_str(),
            transition.principal,
            transition.digest,
            transition.outcome_ref,
            transition.note,
            now
        ],
    )?;
    let Some(from) = transition.from else {
        return Ok(());
    };
    if from == transition.to {
        return Ok(());
    }
    let changed = match transition.to {
        CandidateState::InsufficientEvidence => tx.execute(
            "UPDATE learning_candidates SET state = ?3, reason = ?4
             WHERE profile_id = ?1 AND candidate_id = ?2",
            params![
                profile,
                transition.candidate_id,
                transition.to.as_str(),
                transition.reason
            ],
        )?,
        CandidateState::Accepted | CandidateState::Rejected => tx.execute(
            "UPDATE learning_candidates SET state = ?3, decided_at = ?4, decided_by = ?5
             WHERE profile_id = ?1 AND candidate_id = ?2",
            params![
                profile,
                transition.candidate_id,
                transition.to.as_str(),
                now,
                transition.principal
            ],
        )?,
        CandidateState::Superseded => tx.execute(
            "UPDATE learning_candidates SET state = ?3, decided_at = ?4
             WHERE profile_id = ?1 AND candidate_id = ?2",
            params![
                profile,
                transition.candidate_id,
                transition.to.as_str(),
                now
            ],
        )?,
        CandidateState::Proposed => 0,
    };
    if changed == 1 {
        Ok(())
    } else {
        Err(LearningError::Corrupt("candidate row"))
    }
}
