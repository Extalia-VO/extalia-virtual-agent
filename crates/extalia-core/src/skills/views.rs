//! Bounded read-only queries of the skill registry for the daemon's list, inspect and read
//! operations. Every query is scoped by the registry's profile; nothing here changes a
//! state except the integrity and attestation handling of [`SkillRegistry::read_revision_file`],
//! which reuses the execution-time read (hash point g).

use rusqlite::{OptionalExtension, params};

use super::consent::ConsentEntry;
use super::lifecycle::RevisionState;
use super::manifest::SKILL_FILE;
use super::registry::{PolicyContext, Revision, SkillRegistry, active_pointer, load_revision};
use super::tree::TreeFile;
use super::{SkillError, is_package_name};

/// Largest page of [`SkillRegistry::list`].
pub const MAX_LIST_LIMIT: usize = 100;
/// Latest inspections, approvals and state events returned by [`SkillRegistry::details`].
pub const MAX_DETAIL_INSPECTIONS: usize = 20;
pub const MAX_DETAIL_APPROVALS: usize = 20;
pub const MAX_DETAIL_EVENTS: usize = 50;

/// A revision with its package origin, times and whether it is the package's active one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionSummary {
    pub revision: Revision,
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub active: bool,
}

/// One stored inspection (attestation) row, without the report reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectionRecord {
    pub inspection_id: i64,
    pub scanner_id: String,
    pub scanner_pin: Option<String>,
    pub scanner_version: Option<String>,
    pub policy_version: String,
    pub outcome: String,
    pub coverage: String,
    pub verdict: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

/// One stored approval row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub approval_id: i64,
    pub kind: String,
    pub approver: String,
    pub status: String,
    pub workspace_id: Option<String>,
    pub permission_digest: String,
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
}

/// One row of the append-only revision state history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateEvent {
    pub seq: i64,
    pub from_state: Option<RevisionState>,
    pub to_state: RevisionState,
    pub reason: Option<String>,
    pub at: String,
}

/// Everything `skill.inspect` shows about one revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionDetails {
    pub summary: RevisionSummary,
    pub files: Vec<TreeFile>,
    /// The latest rows, oldest first.
    pub inspections: Vec<InspectionRecord>,
    pub approvals: Vec<ApprovalRecord>,
    pub history: Vec<StateEvent>,
}

/// A W0 consent that matches a revision's stored `SKILL.md` (review input only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentInput {
    pub package_id: String,
    pub revision_id: String,
    /// Always `SKILL.md`: W0 consent covered that file only.
    pub path: String,
    pub sha256: String,
    pub allowed_at: Option<String>,
}

/// A verified file of a package's active revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionFile {
    pub package_id: String,
    pub entry: TreeFile,
    pub bytes: Vec<u8>,
}

impl SkillRegistry<'_> {
    /// Revisions ordered by `(package_id, revision_id)`, after the `after` key, at most
    /// `limit` (1 to [`MAX_LIST_LIMIT`] + 1: a caller showing a full page asks for one
    /// more row to learn whether another page exists), optionally of one package.
    pub fn list(
        &mut self,
        after: Option<(&str, &str)>,
        package_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RevisionSummary>, SkillError> {
        if !(1..=MAX_LIST_LIMIT + 1).contains(&limit) {
            return Err(SkillError::Denied("limit_invalid"));
        }
        let profile = self.profile().as_str().to_owned();
        let (after_package, after_revision) = after.unwrap_or(("", ""));
        let ids: Vec<String> = {
            let conn = self.conn();
            let mut statement = conn.prepare(
                "SELECT revision_id FROM skill_revisions
                 WHERE profile_id = ?1 AND (?2 IS NULL OR package_id = ?2)
                   AND (package_id, revision_id) > (?3, ?4)
                 ORDER BY package_id, revision_id LIMIT ?5",
            )?;
            statement
                .query_map(
                    params![
                        profile,
                        package_id,
                        after_package,
                        after_revision,
                        limit as i64
                    ],
                    |row| row.get(0),
                )?
                .collect::<rusqlite::Result<_>>()?
        };
        ids.iter().map(|id| self.summary(id)).collect()
    }

    /// The revision with its package origin, times and activation flag.
    pub fn summary(&mut self, revision_id: &str) -> Result<RevisionSummary, SkillError> {
        let profile = self.profile().as_str().to_owned();
        let conn = self.conn();
        let revision = load_revision(conn, &profile, revision_id)?;
        let (origin, created_at, updated_at) = conn.query_row(
            "SELECT p.origin, r.created_at, r.updated_at
             FROM skill_revisions r JOIN skill_packages p
               ON p.profile_id = r.profile_id AND p.package_id = r.package_id
             WHERE r.profile_id = ?1 AND r.revision_id = ?2",
            params![profile, revision_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        let active = active_pointer(conn, &profile, &revision.package_id)?
            .is_some_and(|pointer| pointer.revision_id == revision_id);
        Ok(RevisionSummary {
            revision,
            origin,
            created_at,
            updated_at,
            active,
        })
    }

    /// Files, latest inspections, approvals and state history of one revision.
    pub fn details(&mut self, revision_id: &str) -> Result<RevisionDetails, SkillError> {
        let summary = self.summary(revision_id)?;
        let profile = self.profile().as_str().to_owned();
        let conn = self.conn();
        let files = {
            let mut statement = conn.prepare(
                "SELECT path, size, sha256, executable FROM skill_files
                 WHERE profile_id = ?1 AND revision_id = ?2",
            )?;
            let mut files = statement
                .query_map(params![profile, revision_id], |row| {
                    Ok(TreeFile {
                        path: row.get(0)?,
                        size: row.get::<_, i64>(1)?.try_into().unwrap_or(u64::MAX),
                        sha256: row.get(2)?,
                        executable: row.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            files.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
            files
        };
        let mut inspections = {
            let mut statement = conn.prepare(
                "SELECT inspection_id, scanner_id, scanner_pin, scanner_version, policy_version,
                        outcome, coverage, verdict, started_at, finished_at
                 FROM skill_inspections WHERE profile_id = ?1 AND revision_id = ?2
                 ORDER BY inspection_id DESC LIMIT ?3",
            )?;
            statement
                .query_map(
                    params![profile, revision_id, MAX_DETAIL_INSPECTIONS as i64],
                    |row| {
                        Ok(InspectionRecord {
                            inspection_id: row.get(0)?,
                            scanner_id: row.get(1)?,
                            scanner_pin: row.get(2)?,
                            scanner_version: row.get(3)?,
                            policy_version: row.get(4)?,
                            outcome: row.get(5)?,
                            coverage: row.get(6)?,
                            verdict: row.get(7)?,
                            started_at: row.get(8)?,
                            finished_at: row.get(9)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        inspections.reverse();
        let mut approvals = {
            let mut statement = conn.prepare(
                "SELECT approval_id, kind, approver, status, workspace_id, permission_digest,
                        created_at, expires_at, revoked_at
                 FROM skill_approvals WHERE profile_id = ?1 AND revision_id = ?2
                 ORDER BY approval_id DESC LIMIT ?3",
            )?;
            statement
                .query_map(
                    params![profile, revision_id, MAX_DETAIL_APPROVALS as i64],
                    |row| {
                        Ok(ApprovalRecord {
                            approval_id: row.get(0)?,
                            kind: row.get(1)?,
                            approver: row.get(2)?,
                            status: row.get(3)?,
                            workspace_id: row.get(4)?,
                            permission_digest: row.get(5)?,
                            created_at: row.get(6)?,
                            expires_at: row.get(7)?,
                            revoked_at: row.get(8)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        approvals.reverse();
        let rows = {
            let mut statement = conn.prepare(
                "SELECT event_seq, from_state, to_state, reason, at FROM skill_revision_events
                 WHERE profile_id = ?1 AND revision_id = ?2 ORDER BY event_seq DESC LIMIT ?3",
            )?;
            statement
                .query_map(
                    params![profile, revision_id, MAX_DETAIL_EVENTS as i64],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let state = |text: &str| RevisionState::parse(text).ok_or(SkillError::Corrupt("state"));
        let mut history = Vec::with_capacity(rows.len());
        for (seq, from, to, reason, at) in rows.into_iter().rev() {
            history.push(StateEvent {
                seq,
                from_state: from.as_deref().map(state).transpose()?,
                to_state: state(&to)?,
                reason,
                at,
            });
        }
        Ok(RevisionDetails {
            summary,
            files,
            inspections,
            approvals,
            history,
        })
    }

    /// W0 consents (ADR 0025 §7) that match a stored `SKILL.md` of this profile: same
    /// package name, same per-file SHA-256. Optionally limited to one revision. Read only:
    /// consent never inspects, reviews, approves or activates anything.
    pub fn consent_inputs(
        &mut self,
        entries: &[ConsentEntry],
        revision_id: Option<&str>,
    ) -> Result<Vec<ConsentInput>, SkillError> {
        let profile = self.profile().as_str().to_owned();
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT r.revision_id FROM skill_revisions r JOIN skill_files f
               ON f.profile_id = r.profile_id AND f.revision_id = r.revision_id
             WHERE r.profile_id = ?1 AND r.package_id = ?2 AND f.path = ?3 AND f.sha256 = ?4
               AND (?5 IS NULL OR r.revision_id = ?5)
             ORDER BY r.revision_id",
        )?;
        let mut inputs = Vec::new();
        for entry in entries.iter().filter(|entry| is_package_name(&entry.name)) {
            let ids = statement
                .query_map(
                    params![profile, entry.name, SKILL_FILE, entry.sha256, revision_id],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            inputs.extend(ids.into_iter().map(|id| ConsentInput {
                package_id: entry.name.clone(),
                revision_id: id,
                path: SKILL_FILE.to_owned(),
                sha256: entry.sha256.clone(),
                allowed_at: entry.allowed_at.clone(),
            }));
        }
        Ok(inputs)
    }

    /// Read a file of `revision_id` only while it is its package's active revision
    /// (`not_active` otherwise), through the verified execution-time read (hash point g).
    pub fn read_revision_file(
        &mut self,
        revision_id: &str,
        path: &str,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<RevisionFile, SkillError> {
        let profile = self.profile().as_str().to_owned();
        let revision = load_revision(self.conn(), &profile, revision_id)?;
        let active = active_pointer(self.conn(), &profile, &revision.package_id)?
            .is_some_and(|pointer| pointer.revision_id == revision_id);
        if !active {
            return Err(SkillError::Denied("not_active"));
        }
        let bytes = self.read_active_file(&revision.package_id, path, ctx, now_ms)?;
        let entry = self
            .conn()
            .query_row(
                "SELECT size, sha256, executable FROM skill_files
                 WHERE profile_id = ?1 AND revision_id = ?2 AND path = ?3",
                params![profile, revision_id, path],
                |row| {
                    Ok(TreeFile {
                        path: path.to_owned(),
                        size: row.get::<_, i64>(0)?.try_into().unwrap_or(u64::MAX),
                        sha256: row.get(1)?,
                        executable: row.get(2)?,
                    })
                },
            )
            .optional()?
            .ok_or(SkillError::NotFound)?;
        Ok(RevisionFile {
            package_id: revision.package_id,
            entry,
            bytes,
        })
    }
}
