//! Learning loop, W6 slice 1 (ADR 0029; ADRs 0024, 0026, 0027, 0028): L1 experience capture,
//! evidence records, L2/L3 candidate proposals and the user's decisions, stored in
//! `core.sqlite` (schema 6). Core only: nothing here is on the daemon wire yet.
//!
//! - **Experiences (L1).** [`Learning::capture_mission`] turns a *finished* native mission in
//!   the core store (state `completed`, `failed` or `cancelled`) into one experience per task
//!   with a result (`completed` or `failed`). It is idempotent per mission: tasks of a finished
//!   mission cannot change (the store refuses transitions), so a second capture adds nothing
//!   and returns the stored rows. Each experience is a bounded ([`MAX_SUMMARY_BYTES`]) summary
//!   built from structured task fields only (state, attempt, requirements, evidence
//!   references), masked by the port of the host's `redact` before it is stored. Observed
//!   sessions have no core mission, so they never become experiences.
//! - **Evidence.** [`Learning::record_evidence`] appends evidence about a task. The kind fixes
//!   the trust status (ADR 0027 §3): `test_gate` (a check Extalia ran itself, W4) and
//!   `user_confirmation` are `verified`; `task_result` (the native agent's own report, written
//!   by capture only) is `unverified`; `observed_claim` is always `untrusted`, whatever it
//!   claims (AC-29). Only digests, references and short masked excerpts are stored.
//! - **Verification basis.** An experience's outcome and basis come from its task's verified
//!   evidence: `verified_by_extalia` when a test gate agrees, `user_confirmed` when only a user
//!   confirmation does, `unverified` without verified evidence, and `disputed` (never
//!   verified) when verified evidence disagrees. Unverified and untrusted evidence never
//!   changes an outcome.
//! - **Candidates (L2/L3).** [`Learning::propose_knowledge`] builds a managed-note proposal
//!   (content and vault path, nothing written); [`Learning::propose_skill`] builds a `SKILL.md`
//!   proposal and names the inbox folder it would be staged in (skill tables are never
//!   touched). A candidate whose basis is weak is stored as `insufficient_evidence` with a
//!   reason code ([`assess`]) and cannot be accepted. A new proposal for the same target
//!   supersedes the open one.
//! - **Decisions.** Only the local user (`user:<id>`) accepts or rejects, citing the proposal
//!   digest that was shown. Accepting first revalidates the basis against the current
//!   evidence. A knowledge candidate is then written through [`crate::knowledge::write`] as
//!   [`Author::Extalia`](crate::knowledge::Author::Extalia), which only creates or replaces
//!   managed notes: a user note or a note that changed since the proposal becomes a conflict
//!   copy and the candidate stays `proposed`. A skill candidate is only staged into
//!   `<data>/profiles/<profile>/skill-inbox/`, from where the normal W3 import → quarantine →
//!   inspection → approval flow takes over; nothing here imports, approves or activates.
//!
//! Nothing in this module reads or writes policy, grants, approvals, scanner configuration
//! or skill tables, and no proposal can be decided by an agent or by Extalia itself.

mod candidate;
mod capture;
#[cfg(test)]
mod tests;

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use crate::CoreStore;
use crate::knowledge::WriteError;
use crate::skills::ProfileId;

pub use candidate::{
    Assessment, Candidate, DecisionOutcome, DecisionRecord, DecisionRequest, KnowledgeProposal,
    SkillProposal, assess,
};
pub use capture::{CaptureReport, EvidenceInput, EvidenceRecord, Experience};

/// Bytes of a stored experience summary (after masking).
pub const MAX_SUMMARY_BYTES: usize = 4_096;
/// Bytes of an evidence reference (after masking; longer references are refused).
pub const MAX_REF_BYTES: usize = 512;
/// Bytes of an evidence excerpt (after masking; longer excerpts are cut).
pub const MAX_EXCERPT_BYTES: usize = 1_024;
/// Evidence records per task.
pub const MAX_EVIDENCE_PER_TASK: usize = 32;
/// Verified successful experiences a candidate needs before it can be `proposed` instead of
/// `insufficient_evidence` (ADR 0029 §6, owner question 1). Two independent verified
/// outcomes: one success can be luck; the owner may raise it per segment later.
pub const MIN_VERIFIED_EXPERIENCES: u32 = 2;
/// Experiences one candidate may cite.
pub const MAX_CANDIDATE_EXPERIENCES: usize = 64;
/// Bytes of a stored proposal (a note or a `SKILL.md`).
pub const MAX_PROPOSAL_BYTES: usize = 131_072;
/// Bytes of a proposed finding or skill instructions (before the core adds its sections).
pub const MAX_FINDING_BYTES: usize = 16_384;
/// Bytes of a candidate rationale (after masking; longer text is cut).
pub const MAX_RATIONALE_BYTES: usize = 2_048;
/// Bytes of a knowledge title or skill description (one line).
pub const MAX_TITLE_BYTES: usize = 200;
/// Open (`proposed` or `insufficient_evidence`) candidates per profile.
pub const MAX_OPEN_CANDIDATES: usize = 256;
/// Folder below `<data>/profiles/<profile-id>/` where accepted skill candidates are staged
/// for the normal W3 import. It is not the skill object store (`skills/`).
pub const SKILL_INBOX_DIR: &str = "skill-inbox";
/// Top-level vault folders a knowledge candidate may target (PRD taxonomy). `Skills/`,
/// `Decisions/`, `Projects/` and everything else stay with the user.
pub const KNOWLEDGE_FOLDERS: [&str; 3] = ["Knowledge", "Experiences", "Learning"];
/// The principal of the core's own learning records (task results, supersede, revalidate).
pub const LEARNING_PRINCIPAL: &str = "extalia:learning";

macro_rules! names {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant,)+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text,)+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

names!(
    /// What an evidence record is; it fixes the record's trust status.
    EvidenceKind {
        TestGate = "test_gate",
        UserConfirmation = "user_confirmation",
        TaskResult = "task_result",
        ObservedClaim = "observed_claim",
    }
);

names!(
    /// What evidence asserts about a task's outcome.
    Claim {
        Success = "success",
        Failure = "failure",
    }
);

names!(
    /// ADR 0027 §3, the subset learning records use.
    TrustStatus {
        Untrusted = "untrusted",
        Unverified = "unverified",
        Verified = "verified",
    }
);

names!(
    /// How an experience's outcome is known (ADR 0027 §2).
    Basis {
        VerifiedByExtalia = "verified_by_extalia",
        UserConfirmed = "user_confirmed",
        Unverified = "unverified",
    }
);

names!(
    Outcome {
        Success = "success",
        Failure = "failure",
        Disputed = "disputed",
    }
);

names!(
    CandidateKind {
        Knowledge = "knowledge",
        Skill = "skill",
    }
);

names!(
    CandidateState {
        Proposed = "proposed",
        Rejected = "rejected",
        Accepted = "accepted",
        Superseded = "superseded",
        InsufficientEvidence = "insufficient_evidence",
    }
);

names!(
    /// A record of the append-only decision history.
    DecisionAction {
        Propose = "propose",
        Accept = "accept",
        Reject = "reject",
        Conflict = "conflict",
        Supersede = "supersede",
        Revalidate = "revalidate",
    }
);

impl EvidenceKind {
    /// The trust status every record of this kind has (also enforced by the schema).
    pub fn trust(self) -> TrustStatus {
        match self {
            Self::TestGate | Self::UserConfirmation => TrustStatus::Verified,
            Self::TaskResult => TrustStatus::Unverified,
            Self::ObservedClaim => TrustStatus::Untrusted,
        }
    }
}

impl Basis {
    pub fn verified(self) -> bool {
        self != Self::Unverified
    }
}

impl CandidateState {
    /// `proposed` or `insufficient_evidence`: not decided and not superseded.
    pub fn open(self) -> bool {
        matches!(self, Self::Proposed | Self::InsufficientEvidence)
    }
}

/// Why a learning operation changed nothing. Messages are generic: no paths or text.
#[derive(Debug)]
pub enum LearningError {
    /// No such mission, task, experience or candidate in this profile.
    NotFound,
    /// A rule refused the operation; the reason code says which.
    Denied(&'static str),
    /// The candidate is not in a state that allows this decision.
    WrongState(CandidateState),
    /// The vault or history belongs to another profile.
    WrongProfile,
    /// The note write was refused (nothing was replaced).
    Knowledge(WriteError),
    /// A stored row contradicts its own constraints; fail closed.
    Corrupt(&'static str),
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for LearningError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => f.write_str("not found in this profile"),
            Self::Denied(reason) => write!(f, "refused: {reason}"),
            Self::WrongState(state) => write!(f, "candidate is {}", state.as_str()),
            Self::WrongProfile => f.write_str("vault or history belongs to another profile"),
            Self::Knowledge(error) => error.fmt(f),
            Self::Corrupt(reason) => write!(f, "learning records are inconsistent: {reason}"),
            Self::Io(_) => f.write_str("learning file access failed"),
            Self::Sqlite(_) => f.write_str("core store database operation failed"),
        }
    }
}

impl std::error::Error for LearningError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Knowledge(source) => Some(source),
            Self::Io(source) => Some(source),
            Self::Sqlite(source) => Some(source),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for LearningError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<io::Error> for LearningError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<WriteError> for LearningError {
    fn from(error: WriteError) -> Self {
        Self::Knowledge(error)
    }
}

/// The learning records of one profile in the core store.
#[derive(Debug)]
pub struct Learning<'s> {
    store: &'s mut CoreStore,
    data_dir: PathBuf,
    profile: ProfileId,
}

impl<'s> Learning<'s> {
    /// `data_dir` is the directory that holds `state/core.sqlite`.
    pub fn new(store: &'s mut CoreStore, data_dir: &Path, profile: ProfileId) -> Self {
        Self {
            store,
            data_dir: data_dir.to_path_buf(),
            profile,
        }
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }

    /// `<data>/profiles/<profile-id>/skill-inbox/`.
    pub fn skill_inbox(&self) -> PathBuf {
        self.profile_dir().join(SKILL_INBOX_DIR)
    }

    fn profile_dir(&self) -> PathBuf {
        self.data_dir.join("profiles").join(self.profile.as_str())
    }

    fn conn(&mut self) -> &mut rusqlite::Connection {
        self.store.connection()
    }
}

/// Mask likely credentials (the Rust port of the host's `redact`).
fn mask(text: &str) -> (String, usize) {
    crate::knowledge::import::mask_credentials(text)
}

/// `text` cut to at most `max` bytes on a character boundary, ending with `…` when cut.
fn bounded(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// One line without control characters.
fn is_line(text: &str) -> bool {
    !text.trim().is_empty() && !text.chars().any(char::is_control)
}

/// Text that may span lines: no control characters other than tab and line breaks.
fn is_text(text: &str) -> bool {
    !text.trim().is_empty()
        && text
            .chars()
            .all(|character| matches!(character, '\t' | '\n' | '\r') || !character.is_control())
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `extalia:<component>` with `component` = `^[a-z][a-z0-9-]{0,31}$`.
fn extalia_principal(component: &str) -> Option<String> {
    let bytes = component.as_bytes();
    let valid = (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
    valid.then(|| format!("extalia:{component}"))
}
