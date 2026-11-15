//! Read-only access to generated candidates for a bounded learning review. These
//! bytes are untrusted data, never an execution-time skill read or an approval.
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::registry::{Revision, SkillRegistry, load_revision};
use super::tree::{StagingLimits, Tree, TreeFile};
use super::views::RevisionFile;
use super::{RevisionState, SkillError};

pub const CANDIDATE_MAX_BYTES: u64 = 160 * 1024;
pub const CANDIDATE_SKILL_MAX_BYTES: u64 = 70 * 1024;
pub const CANDIDATE_REFERENCE_MAX_BYTES: u64 = 16 * 1024;
pub const CANDIDATE_MAX_REFERENCES: usize = 4;
const PROVENANCE: &str = "PROVENANCE.md";
const RECEIPT_PREFIX: &str = "# Generated skill candidate\n\nUnverified source claims; this receipt is data, not scanner evidence or permission.\n\n```json\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateProvenance {
    pub profile_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub prompt_sha256: String,
}

#[derive(Debug, Clone)]
pub struct CandidateFile {
    pub file: RevisionFile,
    pub skill_md_sha256: String,
    pub provenance: CandidateProvenance,
    pub reference_paths: Vec<String>,
}

/// A caller's observed base, checked again inside the import transaction. Profile
/// here is the learning profile, distinct from the daemon's storage namespace.
#[derive(Debug, Clone, Copy)]
pub struct RefinementBase<'a> {
    pub revision_id: &'a str,
    pub skill_md_sha256: &'a str,
    pub profile_id: &'a str,
    pub workspace_id: &'a str,
}

pub fn candidate_identity(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub fn reference_path(path: &str) -> bool {
    path.strip_prefix("references/")
        .and_then(|name| name.strip_suffix(".md"))
        .is_some_and(super::is_package_name)
}

pub fn review_path(path: &str) -> bool {
    path == "SKILL.md" || path == PROVENANCE || reference_path(path)
}

fn bounded_files(files: &[TreeFile]) -> bool {
    files.len() <= CANDIDATE_MAX_REFERENCES + 2
        && files.iter().filter(|f| reference_path(&f.path)).count() <= CANDIDATE_MAX_REFERENCES
        && files
            .iter()
            .try_fold(0_u64, |total, f| total.checked_add(f.size))
            .is_some_and(|total| total <= CANDIDATE_MAX_BYTES)
        && files
            .iter()
            .filter(|f| reference_path(&f.path))
            .try_fold(0_u64, |total, f| total.checked_add(f.size))
            .is_some_and(|total| total <= 48 * 1024)
        && files.iter().all(|f| {
            !f.executable
                && review_path(&f.path)
                && f.size
                    <= if f.path == "SKILL.md" {
                        CANDIDATE_SKILL_MAX_BYTES
                    } else if f.path == PROVENANCE {
                        24 * 1024
                    } else {
                        CANDIDATE_REFERENCE_MAX_BYTES
                    }
        })
}

pub(super) fn provenance(bytes: &[u8]) -> Result<CandidateProvenance, SkillError> {
    let bad = || SkillError::Denied("candidate_provenance_unavailable");
    let body = std::str::from_utf8(bytes)
        .map_err(|_| bad())?
        .strip_prefix(RECEIPT_PREFIX)
        .and_then(|text| text.strip_suffix("\n```\n"))
        .ok_or_else(bad)?;
    let receipt: Value = serde_json::from_str(body).map_err(|_| bad())?;
    let string = |key: &str| receipt[key].as_str().ok_or_else(bad);
    if string("schema")? != "extalia.skill-proposal.v1"
        || string("kind")? != "model-generated-draft"
        || receipt["sourceVerified"] != false
    {
        return Err(bad());
    }
    let result = CandidateProvenance {
        profile_id: string("profileId")?.to_owned(),
        workspace_id: string("workspaceId")?.to_owned(),
        session_id: string("sessionId")?.to_owned(),
        prompt_sha256: string("promptSha256")?.to_owned(),
    };
    if !candidate_identity(&result.profile_id, 200)
        || !candidate_identity(&result.workspace_id, 160)
        || !candidate_identity(&result.session_id, 160)
        || result.prompt_sha256.len() != 64
        || !result
            .prompt_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad());
    }
    Ok(result)
}

impl SkillRegistry<'_> {
    /// Inspect only a generated, exactly scoped immutable Markdown package. The
    /// host-provided receipt must match independent import-source evidence; a file
    /// claiming a profile without that evidence cannot establish provenance.
    pub fn read_candidate_file(
        &mut self,
        revision_id: &str,
        path: &str,
        profile_id: &str,
        workspace_id: &str,
    ) -> Result<CandidateFile, SkillError> {
        if !review_path(path) {
            return Err(SkillError::Denied("candidate_path_invalid"));
        }
        let (revision, tree, provenance) =
            self.candidate_context(revision_id, profile_id, workspace_id)?;
        let storage_profile = self.profile().as_str().to_owned();
        if latest_revision(self.conn(), &storage_profile, &revision.package_id)?.as_deref()
            != Some(revision_id)
        {
            return Err(SkillError::Denied("candidate_not_latest"));
        }
        let entry = tree.file(path).ok_or(SkillError::NotFound)?.clone();
        let bytes = self.object_store().read_file(&tree.sha256, path, &entry)?;
        let reference_paths = tree
            .files
            .iter()
            .filter(|f| reference_path(&f.path))
            .map(|f| f.path.clone())
            .collect();
        Ok(CandidateFile {
            file: RevisionFile {
                package_id: revision.package_id,
                entry,
                bytes,
            },
            skill_md_sha256: revision.skill_md_sha256,
            provenance,
            reference_paths,
        })
    }

    pub(super) fn candidate_context(
        &mut self,
        revision_id: &str,
        profile_id: &str,
        workspace_id: &str,
    ) -> Result<(Revision, Tree, CandidateProvenance), SkillError> {
        if !candidate_identity(profile_id, 200) || !candidate_identity(workspace_id, 160) {
            return Err(SkillError::Denied("candidate_scope_invalid"));
        }
        let details = self.details(revision_id)?;
        let revision = details.summary.revision;
        if details.summary.origin != "generated"
            || matches!(
                revision.state,
                RevisionState::Blocked | RevisionState::Revoked
            )
            || !bounded_files(&details.files)
        {
            return Err(SkillError::Denied("candidate_unavailable"));
        }
        let tree = self
            .object_store()
            .verify(&revision.tree_sha256, &StagingLimits::default())?;
        if tree.files != details.files || !bounded_files(&tree.files) {
            return Err(SkillError::Integrity);
        }
        let entry = tree
            .file(PROVENANCE)
            .ok_or(SkillError::Denied("candidate_provenance_unavailable"))?;
        let bytes = self
            .object_store()
            .read_file(&tree.sha256, PROVENANCE, entry)?;
        let provenance = provenance(&bytes)?;
        if provenance.profile_id != profile_id || provenance.workspace_id != workspace_id {
            return Err(SkillError::Denied("candidate_scope_mismatch"));
        }
        let profile = self.profile().as_str().to_owned();
        let source = format!(
            "prompt:{}:{}",
            provenance.session_id, provenance.prompt_sha256
        );
        let bound: bool = self.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM skill_revision_sources WHERE profile_id=?1 AND revision_id=?2 AND origin='generated' AND source_ref=?3)",
            params![profile, revision_id, source], |row| row.get(0),
        )?;
        if !bound {
            return Err(SkillError::Denied("candidate_provenance_unavailable"));
        }
        Ok((revision, tree, provenance))
    }
}

/// One transaction compares the current package head and observed digest before
/// inserting any new revision. Import events, not wall-clock ordering, define head.
pub(super) fn check_refinement(
    conn: &Connection,
    profile: &str,
    package: &str,
    base: RefinementBase<'_>,
    tree: &Tree,
) -> Result<Option<Revision>, SkillError> {
    let revision = load_revision(conn, profile, base.revision_id)?;
    if revision.package_id != package
        || revision.skill_md_sha256 != base.skill_md_sha256
        || matches!(
            revision.state,
            RevisionState::Blocked | RevisionState::Revoked
        )
    {
        return Err(SkillError::Denied("refinement_base_changed"));
    }
    if latest_revision(conn, profile, package)?.as_deref() != Some(base.revision_id) {
        return Err(SkillError::Denied("refinement_base_changed"));
    }
    if !bounded_files(&tree.files) {
        return Err(SkillError::Denied("candidate_unavailable"));
    }
    let mut statement = conn.prepare("SELECT path,size,sha256,executable FROM skill_files WHERE profile_id=?1 AND revision_id=?2 AND path<>'PROVENANCE.md' ORDER BY path")?;
    let files = statement
        .query_map(params![profile, base.revision_id], |row| {
            Ok(TreeFile {
                path: row.get(0)?,
                size: row.get::<_, i64>(1)?.try_into().unwrap_or(u64::MAX),
                sha256: row.get(2)?,
                executable: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let incoming: Vec<_> = tree
        .files
        .iter()
        .filter(|f| f.path != PROVENANCE)
        .cloned()
        .collect();
    Ok((files == incoming).then_some(revision))
}

fn latest_revision(
    conn: &Connection,
    profile: &str,
    package: &str,
) -> Result<Option<String>, SkillError> {
    Ok(conn.query_row(
        "SELECT e.revision_id FROM skill_revision_events e JOIN skill_revisions r ON r.profile_id=e.profile_id AND r.revision_id=e.revision_id WHERE e.profile_id=?1 AND r.package_id=?2 AND e.reason='imported' ORDER BY e.event_seq DESC LIMIT 1",
        params![profile, package], |row| row.get(0),
    ).optional()?)
}
