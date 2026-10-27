//! Built-in skills (gap-map decision 10, 2026-10-22): skills shipped inside the signed app,
//! changed only by an app release, are exempt from the scanner gate. Every other origin
//! (user, workspace, imported, generated) always passes it.
//!
//! The exemption is narrow:
//!
//! - **Only through this daemon-internal API.** [`BuiltinCatalog::register`] is called by
//!   the daemon with a directory of the app bundle. No wire operation reaches it, and the
//!   import path cannot express the origin ([`super::Origin`] has no built-in variant), so a
//!   user, workspace, imported or generated package can never claim to be built in.
//! - **Still content-hashed.** A built-in package is staged into the profile's object store
//!   with the same rules and the same canonical tree hash as an import (hash point a), its
//!   manifest is validated the same way, and every file read re-checks the recorded
//!   per-file SHA-256 (hash point g). A mismatch drops the package from the catalog; there is
//!   no fallback to the bundle copy.
//! - **Recorded durably, re-verified on start** (core migration 0004). Each registration is
//!   an append-only `skill_builtin_registrations` row (package, revision id, tree hash,
//!   `SKILL.md` hash, version, risk class, permission digest). It is deliberately not a
//!   `skill_packages` row: `skill_packages.origin` keeps admitting only the four import
//!   origins, so a built-in never becomes a revision and cannot enter the lifecycle,
//!   approvals or the activation pointer. [`BuiltinCatalog::restore`] runs when the daemon
//!   opens the store: the latest `registered` row of each package is re-hashed against the
//!   object store and its manifest re-resolved; only an exact match is loaded. A missing or
//!   altered object appends an `integrity` row and the package stays unavailable (no
//!   fallback; re-registering the same bytes keeps failing until the object is repaired).
//! - **Changed only by an app release.** Within one daemon run another tree under a
//!   registered package id is refused (`builtin_conflict`). A package restored from an
//!   earlier run may be replaced by a registration with other bytes (the app was updated),
//!   which appends a new `registered` row; [`BuiltinCatalog::retire`] records `retired` for
//!   a package the app no longer ships.
//!
//! Declared permissions of a built-in skill stay a ceiling, never a grant (ADR 0026 §3).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use super::manifest::{self, MANIFEST_FILE, Permissions, RiskClass, SKILL_FILE};
use super::tree::{ObjectStore, StagingLimits, Tree, TreeFile};
use super::{ProfileId, Refusal, SkillError, refused};
use crate::adapters::sqlite::CoreStore;
use crate::time::format_utc;

/// Upper bound of registered built-in packages (the app ships a handful).
pub const MAX_BUILTIN_SKILLS: usize = 64;

/// One registered built-in package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinSkill {
    pub package_id: String,
    pub revision_id: String,
    pub version: String,
    pub tree: Tree,
    pub skill_md_sha256: String,
    pub manifest_json: String,
    pub manifest_inferred: bool,
    pub risk_class: RiskClass,
    pub permissions: Permissions,
    pub permission_digest: String,
    pub registered_at: String,
}

/// What [`BuiltinCatalog::restore`] found, by package id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreReport {
    /// Re-verified and loaded.
    pub restored: Vec<String>,
    /// The stored object is missing or no longer hashes to the recorded tree; an
    /// `integrity` row was appended and the package is not loaded.
    pub integrity: Vec<String>,
    /// The bytes are intact but no longer resolve to the recorded registration under this
    /// build's manifest rules; not loaded, nothing recorded.
    pub invalid: Vec<String>,
}

/// The built-in skills of one profile, staged into its object store and recorded in the
/// core store.
#[derive(Debug)]
pub struct BuiltinCatalog {
    objects: ObjectStore,
    profile: ProfileId,
    limits: StagingLimits,
    skills: BTreeMap<String, BuiltinSkill>,
    /// Packages registered by this run; the others were restored from the store.
    registered_this_run: BTreeSet<String>,
}

/// The latest registration row of a package.
#[derive(Debug, Clone)]
struct Registration {
    package_id: String,
    tree_sha256: String,
    skill_md_sha256: String,
    version: String,
    risk_class: String,
    permission_digest: String,
    event: String,
    at: String,
}

impl BuiltinCatalog {
    /// `data_dir` is the directory that holds `state/core.sqlite`.
    pub fn new(data_dir: &Path, profile: &ProfileId) -> Self {
        Self {
            objects: ObjectStore::new(data_dir, profile),
            profile: profile.clone(),
            limits: StagingLimits::default(),
            skills: BTreeMap::new(),
            registered_this_run: BTreeSet::new(),
        }
    }

    /// Stage a package shipped with the app, record and register it. Registering the same
    /// bytes again is a no-op (no new row); another tree under a package id registered by
    /// this run is refused (`builtin_conflict`), as is a package the staging or manifest
    /// rules refuse. Another tree under a package restored from an earlier run replaces it.
    pub fn register(
        &mut self,
        store: &mut CoreStore,
        source: &Path,
        now_ms: i64,
    ) -> Result<&BuiltinSkill, SkillError> {
        let tree = self.objects.stage(source, &self.limits)?;
        let mut skill = self.load(tree, format_utc(now_ms))?;
        let package_id = skill.package_id.clone();
        match self.skills.get(&package_id) {
            Some(existing) if existing.tree.sha256 == skill.tree.sha256 => {
                self.registered_this_run.insert(package_id.clone());
                return Ok(&self.skills[&package_id]);
            }
            Some(_) if self.registered_this_run.contains(&package_id) => {
                return Err(SkillError::Denied("builtin_conflict"));
            }
            Some(_) => {}
            None if self.skills.len() >= MAX_BUILTIN_SKILLS => {
                return Err(SkillError::Denied("builtin_limit"));
            }
            None => {}
        }
        let profile = self.profile.as_str();
        let conn = store.connection();
        match latest(conn, profile, &package_id)? {
            Some(row) if row.event == "registered" && row.tree_sha256 == skill.tree.sha256 => {
                skill.registered_at = row.at;
            }
            _ => record(conn, profile, &skill, "registered", &skill.registered_at)?,
        }
        self.registered_this_run.insert(package_id.clone());
        self.skills.insert(package_id.clone(), skill);
        Ok(&self.skills[&package_id])
    }

    /// Load the current registrations recorded by earlier runs (daemon start), each only
    /// after re-hashing its stored object and re-resolving its manifest to exactly the
    /// recorded values. Packages already registered by this run are left as they are.
    pub fn restore(
        &mut self,
        store: &mut CoreStore,
        now_ms: i64,
    ) -> Result<RestoreReport, SkillError> {
        let profile = self.profile.as_str().to_owned();
        let conn = store.connection();
        let rows = {
            let mut statement = conn.prepare(
                "SELECT package_id, tree_sha256, skill_md_sha256, version, risk_class,
                        permission_digest, event, at
                 FROM skill_builtin_registrations AS r
                 WHERE profile_id = ?1 AND registration_id = (
                   SELECT max(registration_id) FROM skill_builtin_registrations
                   WHERE profile_id = r.profile_id AND package_id = r.package_id)
                 ORDER BY package_id",
            )?;
            statement
                .query_map([&profile], registration)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut report = RestoreReport::default();
        for row in rows.into_iter().filter(|row| row.event == "registered") {
            if self.skills.contains_key(&row.package_id) {
                continue;
            }
            if self.skills.len() >= MAX_BUILTIN_SKILLS {
                report.invalid.push(row.package_id);
                continue;
            }
            let loaded = self
                .objects
                .verify(&row.tree_sha256, &self.limits)
                .and_then(|tree| self.load(tree, row.at.clone()));
            match loaded {
                Ok(skill) if matches_row(&skill, &row) => {
                    report.restored.push(row.package_id.clone());
                    self.skills.insert(row.package_id, skill);
                }
                Err(SkillError::Integrity) => {
                    record_row(conn, &profile, &row, "integrity", &format_utc(now_ms))?;
                    report.integrity.push(row.package_id);
                }
                Ok(_) | Err(SkillError::Manifest(_) | SkillError::Refused { .. }) => {
                    report.invalid.push(row.package_id);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(report)
    }

    /// Record that the app no longer ships `package_id` and unregister it.
    pub fn retire(
        &mut self,
        store: &mut CoreStore,
        package_id: &str,
        now_ms: i64,
    ) -> Result<(), SkillError> {
        let skill = self.skills.get(package_id).ok_or(SkillError::NotFound)?;
        record(
            store.connection(),
            self.profile.as_str(),
            skill,
            "retired",
            &format_utc(now_ms),
        )?;
        self.skills.remove(package_id);
        self.registered_this_run.remove(package_id);
        Ok(())
    }

    pub fn get(&self, package_id: &str) -> Option<&BuiltinSkill> {
        self.skills.get(package_id)
    }

    pub fn by_revision(&self, revision_id: &str) -> Option<&BuiltinSkill> {
        self.skills
            .values()
            .find(|skill| skill.revision_id == revision_id)
    }

    /// Registered packages ordered by package id.
    pub fn iter(&self) -> impl Iterator<Item = &BuiltinSkill> {
        self.skills.values()
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    /// Read one file of a registered package, verified against its recorded size and
    /// SHA-256 (hash point g). A mismatch unregisters the package, appends an `integrity`
    /// row and returns [`SkillError::Integrity`].
    pub fn read_file(
        &mut self,
        store: &mut CoreStore,
        revision_id: &str,
        path: &str,
        now_ms: i64,
    ) -> Result<(TreeFile, Vec<u8>), SkillError> {
        let skill = self.by_revision(revision_id).ok_or(SkillError::NotFound)?;
        let entry = skill.tree.file(path).ok_or(SkillError::NotFound)?.clone();
        match self.objects.read_file(&skill.tree.sha256, path, &entry) {
            Ok(bytes) => Ok((entry, bytes)),
            Err(SkillError::Integrity) => {
                let skill = skill.clone();
                self.skills.remove(&skill.package_id);
                self.registered_this_run.remove(&skill.package_id);
                record(
                    store.connection(),
                    self.profile.as_str(),
                    &skill,
                    "integrity",
                    &format_utc(now_ms),
                )?;
                Err(SkillError::Integrity)
            }
            Err(error) => Err(error),
        }
    }

    /// Resolve a staged or stored tree into a built-in skill: `SKILL.md` and the manifest
    /// are read from the object store (verified per file) and validated like an import.
    fn load(&self, tree: Tree, registered_at: String) -> Result<BuiltinSkill, SkillError> {
        let skill_md_entry = tree
            .file(SKILL_FILE)
            .ok_or_else(|| refused(Refusal::MissingSkillMd, None))?
            .clone();
        let skill_md = self
            .objects
            .read_file(&tree.sha256, SKILL_FILE, &skill_md_entry)?;
        let manifest_bytes = match tree.file(MANIFEST_FILE) {
            Some(entry) => Some(self.objects.read_file(&tree.sha256, MANIFEST_FILE, entry)?),
            None => None,
        };
        let package = manifest::resolve(&tree, manifest_bytes.as_deref(), &skill_md)?;
        let manifest = package.manifest;
        Ok(BuiltinSkill {
            package_id: manifest.id.clone(),
            revision_id: format!("skr_{}", tree.sha256),
            version: manifest.version.clone(),
            skill_md_sha256: skill_md_entry.sha256,
            manifest_json: manifest.canonical_json(),
            manifest_inferred: package.inferred,
            risk_class: manifest.risk_class,
            permission_digest: manifest.permissions.digest(),
            permissions: manifest.permissions,
            registered_at,
            tree,
        })
    }
}

fn registration(row: &rusqlite::Row<'_>) -> rusqlite::Result<Registration> {
    Ok(Registration {
        package_id: row.get(0)?,
        tree_sha256: row.get(1)?,
        skill_md_sha256: row.get(2)?,
        version: row.get(3)?,
        risk_class: row.get(4)?,
        permission_digest: row.get(5)?,
        event: row.get(6)?,
        at: row.get(7)?,
    })
}

fn latest(
    conn: &Connection,
    profile: &str,
    package_id: &str,
) -> Result<Option<Registration>, SkillError> {
    Ok(conn
        .query_row(
            "SELECT package_id, tree_sha256, skill_md_sha256, version, risk_class,
                    permission_digest, event, at
             FROM skill_builtin_registrations WHERE profile_id = ?1 AND package_id = ?2
             ORDER BY registration_id DESC LIMIT 1",
            params![profile, package_id],
            registration,
        )
        .optional()?)
}

fn matches_row(skill: &BuiltinSkill, row: &Registration) -> bool {
    skill.package_id == row.package_id
        && skill.tree.sha256 == row.tree_sha256
        && skill.skill_md_sha256 == row.skill_md_sha256
        && skill.version == row.version
        && skill.risk_class.as_str() == row.risk_class
        && skill.permission_digest == row.permission_digest
}

fn record(
    conn: &Connection,
    profile: &str,
    skill: &BuiltinSkill,
    event: &str,
    at: &str,
) -> Result<(), SkillError> {
    record_row(
        conn,
        profile,
        &Registration {
            package_id: skill.package_id.clone(),
            tree_sha256: skill.tree.sha256.clone(),
            skill_md_sha256: skill.skill_md_sha256.clone(),
            version: skill.version.clone(),
            risk_class: skill.risk_class.as_str().to_owned(),
            permission_digest: skill.permission_digest.clone(),
            event: String::new(),
            at: String::new(),
        },
        event,
        at,
    )
}

fn record_row(
    conn: &Connection,
    profile: &str,
    row: &Registration,
    event: &str,
    at: &str,
) -> Result<(), SkillError> {
    conn.execute(
        "INSERT INTO skill_builtin_registrations (profile_id, package_id, revision_id, tree_sha256,
           skill_md_sha256, version, risk_class, permission_digest, event, at)
         VALUES (?1, ?2, 'skr_' || ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            profile,
            row.package_id,
            row.tree_sha256,
            row.skill_md_sha256,
            row.version,
            row.risk_class,
            row.permission_digest,
            event,
            at
        ],
    )?;
    Ok(())
}
