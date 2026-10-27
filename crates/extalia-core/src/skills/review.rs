//! Human review of `review_required` revisions and stored review inputs (ADR 0025 §4, §7;
//! ADR 0026 §5; core migration 0004).
//!
//! - [`SkillRegistry::review`] records one decision of the local user on a revision whose
//!   inspection reported a medium finding. The reviewer must be `user:<id>`: agent, model,
//!   scanner and policy principals cannot be expressed. The decision binds the tree hash the
//!   reviewer was shown (a stale hash is refused with `digest_mismatch`) and the inspection
//!   whose findings were reviewed. `accept` → `validated` (`review-accepted`), only while
//!   the attestation still holds and the revision passes the same resolver check as
//!   validation; `reject` → `quarantined` (`review-rejected`), from where only a new
//!   inspection leads on. Users have no self-approval rule here: the review is recorded and
//!   the later approval (`skill.approve`) is still a separate, digest-bound decision.
//! - [`SkillRegistry::record_consent_inputs`] stores W0 consents that matched a revision's
//!   `SKILL.md` as review inputs. An input is information for the reviewer: it never
//!   changes a state, never counts as a review, inspection or approval and never activates.
//!
//! Both tables are append-only (triggers in `0004_skill_reviews.sql`).

use rusqlite::params;

use super::lifecycle::RevisionState;
use super::manifest::SKILL_FILE;
use super::registry::{PolicyContext, SkillRegistry, immediate, latest_inspection, set_state};
use super::views::ConsentInput;
use super::{SkillError, is_package_name, is_workspace_id};
use crate::time::format_utc;

/// Longest review note, in characters (`DAEMON_SKILL_LIMITS.note`).
pub const MAX_REVIEW_NOTE_CHARS: usize = 2_000;
/// The only review input source so far: a W0 `skill-consent.json` entry.
pub const CONSENT_SOURCE: &str = "w0-consent";
/// Latest reviews and inputs returned by [`SkillRegistry::reviews`] and
/// [`SkillRegistry::review_inputs`].
pub const MAX_LISTED_REVIEWS: usize = 20;

/// A reviewer's decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewDecision {
    Accept,
    Reject,
}

impl ReviewDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "accept" => Some(Self::Accept),
            "reject" => Some(Self::Reject),
            _ => None,
        }
    }
}

/// A review as the UI showed it.
#[derive(Debug, Clone, Copy)]
pub struct ReviewRequest<'a> {
    pub revision_id: &'a str,
    pub shown_tree_sha256: &'a str,
    /// The local user principal, `user:<id>`.
    pub principal: &'a str,
    pub decision: ReviewDecision,
    pub note: Option<&'a str>,
}

/// What [`SkillRegistry::review`] recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewReceipt {
    pub review_id: i64,
    pub state: RevisionState,
    pub state_reason: Option<String>,
}

/// One stored review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRecord {
    pub review_id: i64,
    pub tree_sha256: String,
    pub inspection_id: i64,
    pub principal: String,
    pub decision: ReviewDecision,
    pub note: Option<String>,
    pub created_at: String,
}

/// One stored review input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewInputRecord {
    pub input_id: i64,
    pub source: String,
    pub workspace_id: String,
    pub consent_sha256: String,
    pub allowed_at: Option<String>,
    pub observed_at: String,
}

/// `SKILL_USER_PRINCIPAL_PATTERN`: `user:` followed by `[A-Za-z0-9][A-Za-z0-9._@-]{0,63}`.
pub fn is_user_principal(text: &str) -> bool {
    text.strip_prefix("user:").is_some_and(|id| {
        let bytes = id.as_bytes();
        (1..=64).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes[1..].iter().all(|&byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'@' | b'-')
            })
    })
}

/// Nonblank, at most [`MAX_REVIEW_NOTE_CHARS`] characters (UTF-16 units too, like the
/// wire), and no control characters other than tab and line breaks.
fn note_fits(note: &str) -> bool {
    note.chars().any(|character| !character.is_whitespace())
        && note.encode_utf16().count() <= MAX_REVIEW_NOTE_CHARS
        && note.chars().all(|character| {
            matches!(character, '\t' | '\n' | '\r')
                || (character as u32 >= 32 && character as u32 != 127)
        })
}

impl SkillRegistry<'_> {
    /// Record the local user's review of a `review_required` revision and apply it (see the
    /// module documentation). The bytes are re-hashed first; a mismatch revokes the
    /// revision (`integrity`). An accept with a stale attestation requarantines it instead.
    pub fn review(
        &mut self,
        request: &ReviewRequest<'_>,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<ReviewReceipt, SkillError> {
        if !is_user_principal(request.principal) {
            return Err(SkillError::Denied("principal_not_user"));
        }
        if request.note.is_some_and(|note| !note_fits(note)) {
            return Err(SkillError::Denied("note_invalid"));
        }
        let revision = self.require(request.revision_id, &[RevisionState::ReviewRequired])?;
        if request.shown_tree_sha256 != revision.tree_sha256 {
            return Err(SkillError::Denied("digest_mismatch"));
        }
        self.verify_or_revoke(&revision, now_ms)?;
        let profile = self.profile().as_str().to_owned();
        let (inspection_id, next, reason) = match request.decision {
            ReviewDecision::Accept => {
                let inspection = self.require_attestation(&revision, ctx, now_ms)?;
                self.require_resolvable(&revision.revision_id)?;
                (inspection.id, RevisionState::Validated, "review-accepted")
            }
            ReviewDecision::Reject => {
                let inspection = latest_inspection(self.conn(), &profile, &revision.revision_id)?
                    .ok_or(SkillError::Corrupt("review inspection"))?;
                (inspection.id, RevisionState::Quarantined, "review-rejected")
            }
        };
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        tx.execute(
            "INSERT INTO skill_reviews (profile_id, revision_id, tree_sha256, inspection_id,
               principal, decision, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                profile,
                revision.revision_id,
                revision.tree_sha256,
                inspection_id,
                request.principal,
                request.decision.as_str(),
                request.note,
                at
            ],
        )?;
        let review_id = tx.last_insert_rowid();
        set_state(
            &tx,
            &profile,
            &revision.revision_id,
            RevisionState::ReviewRequired,
            next,
            Some(reason),
            &at,
        )?;
        tx.commit()?;
        Ok(ReviewReceipt {
            review_id,
            state: next,
            state_reason: Some(reason.to_owned()),
        })
    }

    /// Store W0 consents of `workspace_id` that matched a stored `SKILL.md` (from
    /// [`SkillRegistry::consent_inputs`]) as review inputs, each (revision, workspace,
    /// digest) once. Changes no state. Returns how many rows were new.
    pub fn record_consent_inputs(
        &mut self,
        workspace_id: &str,
        inputs: &[ConsentInput],
        now_ms: i64,
    ) -> Result<usize, SkillError> {
        if !is_workspace_id(workspace_id) {
            return Err(SkillError::Denied("workspace_invalid"));
        }
        let profile = self.profile().as_str().to_owned();
        let at = format_utc(now_ms);
        let tx = immediate(self.conn())?;
        let mut added = 0;
        for input in inputs {
            if input.path != SKILL_FILE
                || !is_package_name(&input.package_id)
                || input.allowed_at.as_ref().is_some_and(|at| at.len() > 64)
            {
                return Err(SkillError::Denied("review_input_invalid"));
            }
            added += tx.execute(
                "INSERT INTO skill_review_inputs (profile_id, revision_id, source, workspace_id,
                   consent_sha256, allowed_at, observed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (profile_id, revision_id, source, workspace_id, consent_sha256)
                 DO NOTHING",
                params![
                    profile,
                    input.revision_id,
                    CONSENT_SOURCE,
                    workspace_id,
                    input.sha256,
                    input.allowed_at,
                    at
                ],
            )?;
        }
        tx.commit()?;
        Ok(added)
    }

    /// The latest reviews of a revision of this profile, oldest first.
    pub fn reviews(&mut self, revision_id: &str) -> Result<Vec<ReviewRecord>, SkillError> {
        let profile = self.profile().as_str().to_owned();
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT review_id, tree_sha256, inspection_id, principal, decision, note, created_at
             FROM skill_reviews WHERE profile_id = ?1 AND revision_id = ?2
             ORDER BY review_id DESC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![profile, revision_id, MAX_LISTED_REVIEWS as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut records = Vec::with_capacity(rows.len());
        for (review_id, tree_sha256, inspection_id, principal, decision, note, created_at) in
            rows.into_iter().rev()
        {
            records.push(ReviewRecord {
                review_id,
                tree_sha256,
                inspection_id,
                principal,
                decision: ReviewDecision::parse(&decision)
                    .ok_or(SkillError::Corrupt("review decision"))?,
                note,
                created_at,
            });
        }
        Ok(records)
    }

    /// The latest stored review inputs of a revision of this profile, oldest first.
    pub fn review_inputs(
        &mut self,
        revision_id: &str,
    ) -> Result<Vec<ReviewInputRecord>, SkillError> {
        let profile = self.profile().as_str().to_owned();
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT input_id, source, workspace_id, consent_sha256, allowed_at, observed_at
             FROM skill_review_inputs WHERE profile_id = ?1 AND revision_id = ?2
             ORDER BY input_id DESC LIMIT ?3",
        )?;
        let mut records = statement
            .query_map(
                params![profile, revision_id, MAX_LISTED_REVIEWS as i64],
                |row| {
                    Ok(ReviewInputRecord {
                        input_id: row.get(0)?,
                        source: row.get(1)?,
                        workspace_id: row.get(2)?,
                        consent_sha256: row.get(3)?,
                        allowed_at: row.get(4)?,
                        observed_at: row.get(5)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records.reverse();
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_local_user_principal_reviews() {
        for good in [
            "user:local",
            "user:a",
            "user:owner@example.com",
            "user:a_b-c.d",
        ] {
            assert!(is_user_principal(good), "{good}");
        }
        for bad in [
            "user:",
            "USER:local",
            "agent:planner",
            "model:gpt",
            "policy:auto",
            "scanner:x",
            "local",
            "user:-x",
            "user:a b",
            &format!("user:{}", "a".repeat(65)),
        ] {
            assert!(!is_user_principal(bad), "{bad}");
        }
    }

    #[test]
    fn notes_are_bounded_text() {
        assert!(note_fits("Reviewed.\nThe URL is documentation only.\t(ok)"));
        assert!(note_fits(&"x".repeat(MAX_REVIEW_NOTE_CHARS)));
        assert!(!note_fits(&"x".repeat(MAX_REVIEW_NOTE_CHARS + 1)));
        assert!(!note_fits(" \n\t"));
        assert!(!note_fits("bell\u{7}"));
        assert!(!note_fits("del\u{7f}"));
    }

    #[test]
    fn workspace_ids_are_host_ids_or_lowercase_uuids() {
        for good in [
            "w_mh3p2k1x9f04c2a7",
            "w_00123abcd",
            "w_2gosa7pa2gv0123abcd",
            "00000000-0000-4000-8000-0000000000aa",
        ] {
            assert!(is_workspace_id(good), "{good}");
        }
        for bad in [
            "",
            "w_",
            "w_0123abcd",
            "w_mh3p2k1x9F04C2A7",
            "W_mh3p2k1x9f04c2a7",
            "w_zzzzzzzzzzzz0123abcd",
            "w_mh3p2k1x9f04c2ag",
            "w_../../etc/passwd",
            "w_mh3p2k1x/f04c2a7",
            "00000000-0000-4000-8000-0000000000a",
            "00000000-0000-4000-8000-0000000000AA",
            "../../../../../../etc/passwd/xxxxxxxx",
        ] {
            assert!(!is_workspace_id(bad), "{bad}");
        }
    }
}
