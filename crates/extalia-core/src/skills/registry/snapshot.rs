//! Transaction-bound, nonmutating observation of immutable skill sources.
use super::*;
use crate::skills::resolver::{self, Availability, PackageClaim};
use std::collections::BTreeMap;

const MAX_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;

pub(super) fn context_bounded(facts: &BTreeMap<String, String>, permissions: &Permissions) -> bool {
    let sets = [
        &permissions.filesystem_read,
        &permissions.filesystem_write,
        &permissions.network,
        &permissions.secrets,
    ];
    facts.len() <= 128
        && facts
            .iter()
            .all(|(id, value)| id.len() <= 128 && value.len() <= 128)
        && sets
            .iter()
            .fold(usize::from(permissions.terminal), |count, scopes| {
                count.saturating_add(scopes.len())
            })
            <= 256
        && sets
            .iter()
            .all(|scopes| scopes.iter().all(|scope| scope.len() <= 256))
}

/// The caller owns one deferred transaction for the lifetime of this observation.
/// Cache and byte budget are shared across candidates, pins and all active context.
pub(super) struct Snapshot<'a> {
    conn: &'a Connection,
    objects: &'a ObjectStore,
    profile: &'a str,
    ctx: &'a PolicyContext,
    now_ms: i64,
    limits: StagingLimits,
    active_ids: Vec<(String, String)>,
    cache: BTreeMap<String, PackageClaim>,
    budget: u64,
}

impl<'a> Snapshot<'a> {
    pub(super) fn new(
        conn: &'a Connection,
        objects: &'a ObjectStore,
        profile: &'a str,
        limits: StagingLimits,
        ctx: &'a PolicyContext,
        now_ms: i64,
    ) -> Result<Self, SkillError> {
        let defaults = StagingLimits::default();
        let limits = StagingLimits {
            max_file_bytes: limits.max_file_bytes.min(defaults.max_file_bytes),
            max_total_bytes: limits.max_total_bytes.min(defaults.max_total_bytes),
            max_entries: limits.max_entries.min(defaults.max_entries),
            max_depth: limits.max_depth.min(defaults.max_depth),
        };
        let active_ids = {
            let mut stmt = conn.prepare("SELECT package_id, revision_id FROM skill_activations WHERE profile_id = ?1 ORDER BY package_id LIMIT ?2")?;
            stmt.query_map(params![profile, resolver::MAX_NODES as i64 + 1], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if active_ids.len() > resolver::MAX_NODES {
            return Err(SkillError::Denied("preflight_snapshot_bound"));
        }
        Ok(Self {
            conn,
            objects,
            profile,
            ctx,
            now_ms,
            limits,
            active_ids,
            cache: BTreeMap::new(),
            budget: MAX_SNAPSHOT_BYTES,
        })
    }

    pub(super) fn claim(&mut self, id: &str) -> Result<PackageClaim, SkillError> {
        if let Some(claim) = self.cache.get(id) {
            return Ok(claim.clone());
        }
        if self.cache.len() >= resolver::MAX_NODES {
            return Err(SkillError::Denied("preflight_snapshot_bound"));
        }
        let claim = source_claim(
            self.conn,
            self.objects,
            &self.limits,
            self.profile,
            id,
            self.ctx,
            self.now_ms,
            &mut self.budget,
        )?;
        self.cache.insert(id.to_owned(), claim.clone());
        Ok(claim)
    }

    /// Scope filtering is for candidate roots and their explicitly pinned dependencies.
    /// Ambient context remains globally active for conflict/reverse-constraint checks.
    pub(super) fn scoped_claim(
        &mut self,
        id: &str,
        workspace: Option<&str>,
    ) -> Result<PackageClaim, SkillError> {
        let mut claim = self.claim(id)?;
        if claim.availability == Availability::Active {
            let pointer = active_pointer(self.conn, self.profile, &claim.manifest.id)?
                .filter(|pointer| pointer.revision_id == id)
                .ok_or(SkillError::Denied("preflight_source_integrity"))?;
            let scope: Option<String> = self.conn.query_row(
                "SELECT CASE WHEN length(CAST(workspace_id AS BLOB)) <= ?3 THEN workspace_id
                    WHEN workspace_id IS NULL THEN NULL ELSE '' END
                 FROM skill_approvals WHERE profile_id = ?1 AND approval_id = ?2",
                params![
                    self.profile,
                    pointer.approval_id,
                    super::super::MAX_WORKSPACE_ID_LEN as i64
                ],
                |row| row.get(0),
            )?;
            if scope
                .as_deref()
                .is_some_and(|scope| !is_workspace_id(scope) || Some(scope) != workspace)
            {
                claim.availability = Availability::Unavailable;
            }
        }
        Ok(claim)
    }

    pub(super) fn active_packages(&mut self) -> Result<BTreeMap<String, PackageClaim>, SkillError> {
        let mut active = BTreeMap::new();
        for (id, revision) in self.active_ids.clone() {
            let claim = self.claim(&revision)?;
            if !super::super::is_package_name(&id) || claim.manifest.id != id {
                return Err(SkillError::Denied("preflight_source_integrity"));
            }
            active.insert(id, claim);
        }
        Ok(active)
    }
}

fn digest_ok(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn revision_id_ok(text: &str) -> bool {
    text.strip_prefix("skr_").is_some_and(digest_ok)
}

#[allow(clippy::too_many_arguments)]
fn source_claim(
    conn: &Connection,
    objects: &ObjectStore,
    limits: &StagingLimits,
    profile: &str,
    id: &str,
    ctx: &PolicyContext,
    now_ms: i64,
    budget: &mut u64,
) -> Result<PackageClaim, SkillError> {
    if !revision_id_ok(id) {
        return Err(SkillError::Denied("preflight_source_integrity"));
    }
    // Bound materialization before loading a potentially inconsistent local record.
    let size: Option<i64> = conn
        .query_row(
            "SELECT length(CAST(manifest_json AS BLOB)) FROM skill_revisions
         WHERE profile_id = ?1 AND revision_id = ?2",
            params![profile, id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(size) = size else {
        return Err(SkillError::Denied("preflight_revision_unavailable"));
    };
    let (count, oversized): (i64, bool) = conn.query_row(
        "SELECT count(*), coalesce(max(length(CAST(scope AS BLOB)) > 256
             OR length(CAST(capability AS BLOB)) > 32), 0)
         FROM skill_permissions WHERE profile_id = ?1 AND revision_id = ?2",
        params![profile, id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if size > manifest::MAX_MANIFEST_BYTES as i64 || count > 257 || oversized {
        return Err(SkillError::Denied("preflight_snapshot_bound"));
    }
    let revision = load_revision(conn, profile, id)
        .map_err(|_| SkillError::Denied("preflight_source_integrity"))?;
    if !digest_ok(&revision.tree_sha256) || id != format!("skr_{}", revision.tree_sha256) {
        return Err(SkillError::Denied("preflight_source_integrity"));
    }
    // Reserve the entire maximum tree read before hashing. This conservatively caps
    // all observations, including failed reads and the metadata re-reads below.
    let scan_limit = StagingLimits {
        max_total_bytes: limits.max_total_bytes.min(*budget),
        max_file_bytes: limits.max_file_bytes.min(*budget),
        ..*limits
    };
    if scan_limit.max_total_bytes == 0 {
        return Err(SkillError::Denied("preflight_snapshot_bound"));
    }
    // scan() can read one final file before checking total; reserve that as well.
    let reserve = scan_limit
        .max_total_bytes
        .saturating_add(scan_limit.max_file_bytes)
        .saturating_add(1);
    if reserve > *budget {
        return Err(SkillError::Denied("preflight_snapshot_bound"));
    }
    *budget -= reserve;
    let tree = objects
        .verify(&revision.tree_sha256, &scan_limit)
        .map_err(|_| SkillError::Denied("preflight_source_integrity"))?;
    let used = tree.files.iter().map(|file| file.size).sum::<u64>();
    *budget += reserve - used;
    let mut read = |name: &str| -> Result<Option<Vec<u8>>, SkillError> {
        let Some(file) = tree.file(name) else {
            return Ok(None);
        };
        let reserve = file.size.saturating_add(1);
        if reserve > *budget {
            return Err(SkillError::Denied("preflight_snapshot_bound"));
        }
        *budget -= reserve;
        objects
            .read_file(&tree.sha256, name, file)
            .map(Some)
            .map_err(|_| SkillError::Denied("preflight_source_integrity"))
    };
    let skill = read(SKILL_FILE)?.ok_or(SkillError::Denied("preflight_source_integrity"))?;
    let sidecar = read(MANIFEST_FILE)?;
    let package = manifest::resolve(&tree, sidecar.as_deref(), &skill)
        .map_err(|_| SkillError::Denied("preflight_source_integrity"))?;
    let manifest = package.manifest;
    if manifest.canonical_json() != revision.manifest_json
        || manifest.id != revision.package_id
        || manifest.version != revision.version
        || manifest.risk_class != revision.risk_class
        || package.inferred != revision.manifest_inferred
        || manifest.permissions != revision.permissions
        || manifest.permissions.digest() != revision.permission_digest
        || tree
            .file(SKILL_FILE)
            .is_none_or(|file| file.sha256 != revision.skill_md_sha256)
    {
        return Err(SkillError::Denied("preflight_source_integrity"));
    }
    let availability = availability(conn, profile, &revision, ctx, now_ms)?;
    Ok(PackageClaim {
        manifest,
        revision_id: revision.revision_id,
        tree_sha256: revision.tree_sha256,
        permissions_digest: revision.permission_digest,
        availability,
    })
}

fn availability(
    conn: &Connection,
    profile: &str,
    revision: &Revision,
    ctx: &PolicyContext,
    now_ms: i64,
) -> Result<Availability, SkillError> {
    let pointer = active_pointer(conn, profile, &revision.package_id)?;
    if let Some(pointer) = pointer.filter(|pointer| pointer.revision_id == revision.revision_id) {
        if !matches!(
            revision.state,
            RevisionState::Active | RevisionState::Deprecated
        ) {
            return Ok(Availability::Unavailable);
        }
        let approval = load_approval(conn, profile, pointer.approval_id)?;
        let consumed = approval_consumed(conn, profile, revision, pointer.approval_id)?;
        if check_approval(&approval, revision, now_ms, consumed).is_err() {
            return Ok(Availability::Unavailable);
        }
        // An approval must name an inspection of this same revision, even when a
        // damaged database points to another row with superficially equal hashes.
        let inspection_revision: Option<String> = conn.query_row(
            "SELECT revision_id FROM skill_inspections WHERE profile_id = ?1 AND inspection_id = ?2",
            params![profile, approval.inspection_id], |row| row.get(0),
        ).optional()?;
        if inspection_revision.as_deref() != Some(&revision.revision_id) {
            return Ok(Availability::Unavailable);
        }
        let inspection = load_inspection(conn, profile, approval.inspection_id)?;
        return Ok(
            if inspection.is_some_and(|inspection| attestation(&inspection, revision, ctx).is_ok())
            {
                Availability::Active
            } else {
                Availability::Unavailable
            },
        );
    }
    if matches!(
        revision.state,
        RevisionState::Quarantined
            | RevisionState::Discovered
            | RevisionState::Inspecting
            | RevisionState::Blocked
            | RevisionState::Revoked
            | RevisionState::ReviewRequired
    ) {
        return Ok(Availability::Unavailable);
    }
    Ok(
        if latest_inspection(conn, profile, &revision.revision_id)?
            .is_some_and(|inspection| attestation(&inspection, revision, ctx).is_ok())
        {
            Availability::Inactive
        } else {
            Availability::Unavailable
        },
    )
}
