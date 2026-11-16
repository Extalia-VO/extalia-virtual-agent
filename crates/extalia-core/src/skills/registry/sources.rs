//! Import provenance belongs to an immutable revision, not the package's first import.
use super::super::{Origin, SkillError, tree::check_relative_path};
use super::SkillRegistry;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) const MAX_SOURCES: i64 = 256;

fn market_identity(source: &str) -> Result<Option<(String, &str)>, SkillError> {
    let Some(value) = source.strip_prefix("github:") else {
        return Ok(None);
    };
    let invalid = || SkillError::Denied("market_package_source_invalid");
    let (repository, rest) = value.split_once('@').ok_or_else(invalid)?;
    let (commit, directory) = rest.split_once('#').ok_or_else(invalid)?;
    let valid_repo = repository.len() <= 255
        && repository.split('/').count() == 2
        && repository.split('/').all(|part| {
            !part.is_empty()
                && part.len() <= 128
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && !part.ends_with('.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        });
    if !valid_repo
        || commit.len() != 40
        || !commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || (!directory.is_empty()
            && (check_relative_path(directory).is_err() || directory.split('/').count() > 8))
    {
        return Err(invalid());
    }
    Ok(Some((repository.to_ascii_lowercase(), directory)))
}

impl SkillRegistry<'_> {
    /// Bounded exact-revision provenance projection; malformed or legacy labels
    /// never manufacture marketplace evidence. Package-level metadata is not used.
    pub(in crate::skills) fn revision_has_market_source(
        &mut self,
        revision: &str,
    ) -> Result<bool, SkillError> {
        let profile = self.profile().as_str().to_owned();
        let mut statement = self.conn().prepare(
            "SELECT source_ref FROM skill_revision_sources
             WHERE profile_id=?1 AND revision_id=?2 AND origin='imported'
             ORDER BY source_seq LIMIT ?3",
        )?;
        let rows = statement.query_map(params![profile, revision, MAX_SOURCES], |row| {
            row.get::<_, String>(0)
        })?;
        for source in rows {
            if matches!(market_identity(&source?), Ok(Some(_))) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Prevent an unrelated source from claiming an existing market package's name (and
/// the inverse). Applies before the identical-tree fast path as well as new revisions.
pub(super) fn check_package(
    conn: &Connection,
    profile: &str,
    package: &str,
    origin: Origin,
    source: &str,
) -> Result<(), SkillError> {
    let incoming = market_identity(source)?;
    if incoming.is_some() && origin != Origin::Imported {
        return Err(SkillError::Denied("market_package_source_conflict"));
    }
    let existing = conn
        .query_row(
            "SELECT origin, source_ref FROM skill_packages WHERE profile_id=?1 AND package_id=?2",
            params![profile, package],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((prior_origin, prior_source)) = existing {
        let prior = market_identity(&prior_source)?;
        if (incoming.is_some() || prior.is_some())
            && (incoming != prior || prior_origin != origin.as_str())
        {
            return Err(SkillError::Denied("market_package_source_conflict"));
        }
    }
    Ok(())
}

pub(super) fn record(
    conn: &Connection,
    profile: &str,
    revision: &str,
    origin: Origin,
    source: &str,
    at: &str,
) -> Result<(), SkillError> {
    // Legacy callers may not have supplied a usable source. Do not manufacture evidence.
    if source.trim().is_empty() || source.chars().any(char::is_control) {
        return Ok(());
    }
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM skill_revision_sources WHERE profile_id=?1 AND revision_id=?2 AND origin=?3 AND source_ref=?4)",
        params![profile, revision, origin.as_str(), source], |r| r.get(0))?;
    if exists {
        return Ok(());
    }
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM skill_revision_sources WHERE profile_id=?1 AND revision_id=?2",
        params![profile, revision],
        |r| r.get(0),
    )?;
    if count >= MAX_SOURCES {
        return Err(SkillError::Denied("revision_source_limit"));
    }
    conn.execute("INSERT INTO skill_revision_sources (profile_id, revision_id, origin, source_ref, recorded_at) VALUES (?1,?2,?3,?4,?5)",params![profile,revision,origin.as_str(),source,at])?;
    Ok(())
}
