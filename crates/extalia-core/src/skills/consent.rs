//! W0 consent as review input (ADR 0025 §7).
//!
//! W0 kept the user's consent to workspace skills in
//! `<data>/workspaces/<workspace-id>/skill-consent.json` (`SkillConsentStore` in
//! `packages/host/src/skills.ts`, schema `extalia.skill-consent.v1`):
//!
//! ```json
//! { "schema": "extalia.skill-consent.v1", "projectLocation": "<absolute folder>",
//!   "skills": { "<name>": { "sha256": "<SKILL.md sha256>", "allowedAt": "<UTC time>" } } }
//! ```
//!
//! [`parse`] reads it with the W0 reader's rules (wrong schema, other project folder or
//! a corrupt file allow nothing; invalid entries are skipped). A consent is matched to a
//! revision of the package with the same name whose stored `SKILL.md` has that SHA-256
//! (the per-file digest of `skill_files`). The result is information for the reviewer
//! ("you allowed this file on <date>"); it is never an inspection, a review, an approval or
//! an activation, and nothing here writes to the store.

use serde_json::Value;

use super::is_package_name;
use crate::time::parse_utc;

pub const CONSENT_SCHEMA: &str = "extalia.skill-consent.v1";
/// Larger consent files are ignored (the W0 file holds a name and a hash per skill).
pub const MAX_CONSENT_BYTES: usize = 1024 * 1024;
/// At most this many entries are read from one file.
pub const MAX_CONSENT_ENTRIES: usize = 1024;

/// One allowed skill of a W0 consent file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentEntry {
    pub name: String,
    /// SHA-256 of the `SKILL.md` bytes the user allowed.
    pub sha256: String,
    /// When the user allowed it, if the file recorded a valid UTC time.
    pub allowed_at: Option<String>,
}

/// Parse a consent file. `project_location`, when known, must equal the file's
/// `projectLocation` exactly (W0 binds consent to the project folder). Anything malformed
/// yields no entries: consent is only ever evidence for a human, so failing empty is safe.
pub fn parse(bytes: &[u8], project_location: Option<&str>) -> Vec<ConsentEntry> {
    if bytes.len() > MAX_CONSENT_BYTES {
        return Vec::new();
    }
    let Ok(Value::Object(file)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    if file.get("schema").and_then(Value::as_str) != Some(CONSENT_SCHEMA) {
        return Vec::new();
    }
    let Some(location) = file.get("projectLocation").and_then(Value::as_str) else {
        return Vec::new();
    };
    if project_location.is_some_and(|expected| expected != location) {
        return Vec::new();
    }
    let Some(Value::Object(skills)) = file.get("skills") else {
        return Vec::new();
    };
    let mut entries: Vec<ConsentEntry> = skills
        .iter()
        .take(MAX_CONSENT_ENTRIES)
        .filter_map(|(name, entry)| {
            let sha256 = entry.get("sha256")?.as_str()?;
            (is_package_name(name) && is_sha256(sha256)).then(|| ConsentEntry {
                name: name.clone(),
                sha256: sha256.to_owned(),
                allowed_at: entry
                    .get("allowedAt")
                    .and_then(Value::as_str)
                    .filter(|at| parse_utc(at).is_some())
                    .map(str::to_owned),
            })
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn file(schema: &str, location: &str, skills: &str) -> Vec<u8> {
        format!(r#"{{"schema":"{schema}","projectLocation":"{location}","skills":{skills}}}"#)
            .into_bytes()
    }

    #[test]
    fn reads_the_w0_format_like_the_host() {
        let bytes = file(
            CONSENT_SCHEMA,
            "/p",
            &format!(
                r#"{{"demo":{{"sha256":"{SHA}","allowedAt":"2026-10-21T10:00:00.000Z"}},
                    "other":{{"sha256":"{SHA}","allowedAt":"yesterday"}},
                    "Bad Name":{{"sha256":"{SHA}"}},
                    "short":{{"sha256":"abc"}},
                    "upper":{{"sha256":"{}"}}}}"#,
                SHA.to_uppercase()
            ),
        );
        assert_eq!(
            parse(&bytes, Some("/p")),
            [
                ConsentEntry {
                    name: "demo".into(),
                    sha256: SHA.into(),
                    allowed_at: Some("2026-10-21T10:00:00.000Z".into()),
                },
                ConsentEntry {
                    name: "other".into(),
                    sha256: SHA.into(),
                    allowed_at: None,
                },
            ]
        );
        assert_eq!(parse(&bytes, None).len(), 2);
    }

    #[test]
    fn anything_else_allows_nothing() {
        let skills = format!(r#"{{"demo":{{"sha256":"{SHA}"}}}}"#);
        for bytes in [
            file("extalia.skill-consent.v2", "/p", &skills),
            file(CONSENT_SCHEMA, "/elsewhere", &skills),
            file(CONSENT_SCHEMA, "/p", "[]"),
            file(CONSENT_SCHEMA, "/p", "null"),
            b"{not json".to_vec(),
            b"[]".to_vec(),
            vec![b' '; MAX_CONSENT_BYTES + 1],
        ] {
            assert!(parse(&bytes, Some("/p")).is_empty());
        }
    }
}
