//! Declarative fixture data. These assertions are not commands or proof of real-world performance.
use super::{SkillError, manifest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const TESTS_FILE: &str = "TESTS.json";
pub const TESTS_SCHEMA: &str = "extalia.skill-verification.v1";
pub const MAX_TEST_BYTES: usize = 40 * 1024;
pub const REQUIRED_SECTIONS: [&str; 4] = ["When to Use", "Procedure", "Pitfalls", "Verification"];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationCase {
    pub id: String,
    pub input: String,
    pub expected_includes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbidden_includes: Vec<String>,
}
fn bounded(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.encode_utf16().count()<=max
        && !text.chars().any(|c|(c.is_control()&&!"\r\n\t".contains(c)) || matches!(c as u32, 0x00ad|0x061c|0x06dd|0x070f|0x0890..=0x0891|0x08e2|0x180e|0x200b..=0x200f|0x202a..=0x202e|0x2060..=0x2064|0x2066..=0x206f|0xfeff|0xfff9..=0xfffb|0x110bd|0x110cd|0x13430..=0x1343f|0x1bca0..=0x1bca3|0x1d173..=0x1d17a|0xe0001|0xe0020..=0xe007f))
}
pub fn cases(value: &Value) -> Result<Vec<VerificationCase>, SkillError> {
    let cases: Vec<VerificationCase> = serde_json::from_value(value.clone())
        .map_err(|_| SkillError::Denied("verification_cases_invalid"))?;
    let mut ids = BTreeSet::new();
    if cases.is_empty()
        || cases.len() > 6
        || cases.iter().any(|case| {
            !super::is_package_name(&case.id)
                || !ids.insert(case.id.clone())
                || !bounded(&case.input, 2000)
                || case.expected_includes.is_empty()
                || case.expected_includes.len() > 8
                || case.forbidden_includes.len() > 8
                || case
                    .expected_includes
                    .iter()
                    .chain(&case.forbidden_includes)
                    .any(|text| !bounded(text, 300))
                || case.expected_includes.iter().any(|text| {
                    case.forbidden_includes
                        .iter()
                        .any(|forbidden| text.contains(forbidden))
                })
                || case.expected_includes.iter().collect::<BTreeSet<_>>().len()
                    != case.expected_includes.len()
                || case
                    .forbidden_includes
                    .iter()
                    .collect::<BTreeSet<_>>()
                    .len()
                    != case.forbidden_includes.len()
        })
    {
        return Err(SkillError::Denied("verification_cases_invalid"));
    }
    if canonical(&cases).len() > MAX_TEST_BYTES {
        return Err(SkillError::Denied("verification_cases_invalid"));
    }
    Ok(cases)
}
pub fn parse(bytes: &[u8]) -> Result<Vec<VerificationCase>, SkillError> {
    if bytes.len() > MAX_TEST_BYTES {
        return Err(SkillError::Denied("verification_cases_invalid"));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| SkillError::Denied("verification_cases_invalid"))?;
    if value.as_object().is_none_or(|o| o.len() != 2) || value["schema"] != TESTS_SCHEMA {
        return Err(SkillError::Denied("verification_cases_invalid"));
    }
    cases(&value["cases"])
}
pub fn canonical(cases: &[VerificationCase]) -> String {
    crate::mission::canonical::to_string(&json!({"schema":TESTS_SCHEMA,"cases":cases}))
}
pub fn instruction_body(body: &str) -> &str {
    if let Some(rest) = body.strip_prefix("---\n")
        && let Some(at) = rest.find("\n---\n")
    {
        return rest[at + 5..].trim();
    }
    if let Some(rest) = body.strip_prefix("---\r\n")
        && let Some(at) = rest.find("\r\n---\r\n")
    {
        return rest[at + 7..].trim();
    }
    body.trim()
}
pub fn missing_sections(body: &str) -> Vec<String> {
    let mut filled = BTreeSet::new();
    let mut section: Option<(String, usize)> = None;
    let mut fence: Option<(char, usize)> = None;
    let mut comment = false;
    for line in instruction_body(body).lines() {
        if let Some((ch, n)) = fence {
            let raw = line.trim();
            let indentation = line.bytes().take_while(|b| *b == b' ').count();
            let length = raw.chars().take_while(|c| *c == ch).count();
            if indentation <= 3
                && !line.starts_with('\t')
                && length >= n
                && raw[length..].trim().is_empty()
            {
                fence = None;
            }
            continue;
        }
        if !comment {
            let raw = line.trim();
            let indentation = line.bytes().take_while(|b| *b == b' ').count();
            let marker = raw
                .chars()
                .next()
                .filter(|c| *c == '`' || *c == '~')
                .map(|c| (c, raw.chars().take_while(|v| *v == c).count()))
                .filter(|(_, n)| *n >= 3);
            if indentation <= 3
                && !line.starts_with('\t')
                && let Some(marker) = marker
            {
                fence = Some(marker);
                continue;
            }
        }
        let mut clean = String::new();
        let mut rest = line;
        loop {
            if comment {
                if let Some(end) = rest.find("-->") {
                    comment = false;
                    rest = &rest[end + 3..];
                } else {
                    break;
                }
            } else if let Some(start) = rest.find("<!--") {
                clean.push_str(&rest[..start]);
                rest = &rest[start + 4..];
                comment = true;
            } else {
                clean.push_str(rest);
                break;
            }
        }
        let indentation = clean.bytes().take_while(|b| *b == b' ').count();
        if indentation > 3 || clean.starts_with('\t') {
            continue;
        }
        let trimmed = clean.trim();
        let marker = trimmed
            .chars()
            .next()
            .filter(|c| *c == '`' || *c == '~')
            .map(|c| (c, trimmed.chars().take_while(|v| *v == c).count()))
            .filter(|(_, n)| *n >= 3);
        if let Some(marker) = marker {
            fence = Some(marker);
            continue;
        }
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && trimmed.as_bytes().get(level) == Some(&b' ') {
            let title = trimmed[level + 1..].trim().trim_end_matches('#').trim();
            if let Some(name) = REQUIRED_SECTIONS
                .iter()
                .find(|expected| title.eq_ignore_ascii_case(expected))
            {
                section = Some(((*name).into(), level));
            } else if section.as_ref().is_some_and(|(_, depth)| level <= *depth) {
                section = None;
            }
        } else {
            let content = trimmed
                .split_once(char::is_whitespace)
                .filter(|(prefix, _)| {
                    ["-", "+", "*"].contains(prefix)
                        || prefix
                            .strip_suffix(['.', ')'])
                            .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
                })
                .map_or(trimmed, |(_, rest)| rest.trim());
            let normalized = content
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '/')
                .to_lowercase();
            if trimmed.chars().any(char::is_alphanumeric)
                && !["todo", "tbd", "n/a", "placeholder", "belum diisi"]
                    .contains(&normalized.as_str())
                && let Some((section, _)) = &section
            {
                filled.insert(section.clone());
            }
        }
    }
    REQUIRED_SECTIONS
        .iter()
        .filter(|name| !filled.contains(**name))
        .map(|s| (*s).into())
        .collect()
}
pub fn metadata(
    value: &Value,
    key: &str,
    max: usize,
    valid: fn(&str) -> bool,
) -> Result<Vec<String>, SkillError> {
    let Some(values) = value[key].as_array() else {
        return Err(SkillError::Denied("skill_metadata_invalid"));
    };
    let mut output = BTreeSet::new();
    if values.is_empty() || values.len() > max {
        return Err(SkillError::Denied("skill_metadata_invalid"));
    }
    for value in values {
        let text = value
            .as_str()
            .ok_or(SkillError::Denied("skill_metadata_invalid"))?;
        if !valid(text) || !output.insert(text.to_owned()) {
            return Err(SkillError::Denied("skill_metadata_invalid"));
        }
    }
    Ok(output.into_iter().collect())
}
pub type ProposalMetadata = (Vec<String>, Vec<String>, Vec<VerificationCase>);
pub fn proposal_metadata(value: &Value) -> Result<ProposalMetadata, SkillError> {
    Ok((
        metadata(value, "categories", 8, manifest::is_category_id)?,
        metadata(value, "intents", 16, manifest::is_intent)?,
        cases(&value["verificationCases"])?,
    ))
}
