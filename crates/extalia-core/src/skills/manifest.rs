//! Skill manifest `extalia-skill.json` (schema `extalia.skill-manifest.v1`, ADR 0025 §1)
//! and the `SKILL.md` front matter cross-check.
//!
//! The manifest is strict JSON: unknown fields, duplicates inside lists, malformed ids,
//! versions or ranges are rejected with one issue per field. Declared permissions are a
//! request and a ceiling, never a grant (ADR 0026). Version ranges are checked for syntax
//! only; evaluating them is the dependency/compatibility resolver's job (next W3 slice).
//!
//! Without a manifest, a package gets an inferred one: `id` from the front matter `name`,
//! version `0.0.0+tree.<first 16 hex of the tree hash>` (so two inferred trees never reuse
//! a version), no categories, intents or permissions, and `declarative` when every file is
//! Markdown, otherwise `executable`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::SkillError;
use super::is_package_name;
use super::tree::Tree;
use crate::mission::canonical;

pub const MANIFEST_FILE: &str = "extalia-skill.json";
pub const MANIFEST_SCHEMA: &str = "extalia.skill-manifest.v1";
pub const SKILL_FILE: &str = "SKILL.md";
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Same cap as the W0 loader (`packages/host/src/skills.ts`).
pub const MAX_SKILL_MD_BYTES: usize = 256 * 1024;
const PERMISSIONS_SCHEMA: &str = "extalia.skill-permissions.v1";
const MAX_CATEGORIES: usize = 32;
const MAX_INTENTS: usize = 64;
const MAX_RELATIONS: usize = 64;
const MAX_SCOPES: usize = 64;
const MAX_TEXT: usize = 256;

/// `risk_class` of ADR 0025 §1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskClass {
    /// Markdown only, no tool use beyond reads.
    Declarative,
    /// Instructs the agent to use host tools that need grants.
    ToolUsing,
    /// Ships code meant to run.
    Executable,
}

impl RiskClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Declarative => "declarative",
            Self::ToolUsing => "tool_using",
            Self::Executable => "executable",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "declarative" => Some(Self::Declarative),
            "tool_using" => Some(Self::ToolUsing),
            "executable" => Some(Self::Executable),
            _ => None,
        }
    }
}

/// One declared capability (the `skill_permissions.capability` column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    FilesystemRead,
    FilesystemWrite,
    Network,
    Terminal,
    Secrets,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FilesystemRead => "filesystem_read",
            Self::FilesystemWrite => "filesystem_write",
            Self::Network => "network",
            Self::Terminal => "terminal",
            Self::Secrets => "secrets",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "filesystem_read" => Some(Self::FilesystemRead),
            "filesystem_write" => Some(Self::FilesystemWrite),
            "network" => Some(Self::Network),
            "terminal" => Some(Self::Terminal),
            "secrets" => Some(Self::Secrets),
            _ => None,
        }
    }
}

/// Scope recorded for `terminal: true`.
pub const TERMINAL_SCOPE: &str = "*";

/// A declared permission set. Empty sets and `false` mean "nothing".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Permissions {
    pub filesystem_read: BTreeSet<String>,
    pub filesystem_write: BTreeSet<String>,
    /// Host allow-list; empty is `network: false`.
    pub network: BTreeSet<String>,
    pub terminal: bool,
    /// Named credential refs; empty is `secrets: false`.
    pub secrets: BTreeSet<String>,
}

impl Permissions {
    /// `(capability, scope)` rows, sorted.
    pub fn entries(&self) -> BTreeSet<(Capability, String)> {
        let mut out = BTreeSet::new();
        let mut add = |capability, set: &BTreeSet<String>| {
            out.extend(set.iter().map(|scope| (capability, scope.clone())));
        };
        add(Capability::FilesystemRead, &self.filesystem_read);
        add(Capability::FilesystemWrite, &self.filesystem_write);
        add(Capability::Network, &self.network);
        add(Capability::Secrets, &self.secrets);
        if self.terminal {
            out.insert((Capability::Terminal, TERMINAL_SCOPE.to_owned()));
        }
        out
    }

    /// Rebuild from stored rows or pre-authorized grants.
    pub fn from_entries(entries: impl IntoIterator<Item = (Capability, String)>) -> Self {
        let mut out = Self::default();
        for (capability, scope) in entries {
            match capability {
                Capability::FilesystemRead => {
                    out.filesystem_read.insert(scope);
                }
                Capability::FilesystemWrite => {
                    out.filesystem_write.insert(scope);
                }
                Capability::Network => {
                    out.network.insert(scope);
                }
                Capability::Terminal => out.terminal = true,
                Capability::Secrets => {
                    out.secrets.insert(scope);
                }
            }
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.entries().is_empty()
    }

    /// Entries of `self` that `ceiling` does not contain verbatim. Glob containment is not
    /// computed: a different glob string counts as outside the ceiling (fail closed).
    pub fn outside(&self, ceiling: &Self) -> Vec<(Capability, String)> {
        let ceiling = ceiling.entries();
        self.entries()
            .into_iter()
            .filter(|entry| !ceiling.contains(entry))
            .collect()
    }

    /// SHA-256 of the canonical JSON of the sorted entries; an approval binds this digest.
    pub fn digest(&self) -> String {
        let entries: Vec<Value> = self
            .entries()
            .into_iter()
            .map(|(capability, scope)| json!([capability.as_str(), scope]))
            .collect();
        canonical::digest(&json!({ "schema": PERMISSIONS_SCHEMA, "entries": entries }))
    }

    fn to_value(&self) -> Value {
        let list = |set: &BTreeSet<String>| Value::from(set.iter().cloned().collect::<Vec<_>>());
        let or_false = |set: &BTreeSet<String>| {
            if set.is_empty() {
                Value::Bool(false)
            } else {
                list(set)
            }
        };
        json!({
            "filesystem_read": list(&self.filesystem_read),
            "filesystem_write": list(&self.filesystem_write),
            "network": or_false(&self.network),
            "terminal": self.terminal,
            "secrets": or_false(&self.secrets),
        })
    }
}

/// A validated manifest. Lists are sorted and free of duplicates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub categories: BTreeSet<String>,
    pub intents: BTreeSet<String>,
    /// Runtime/framework fact id -> SemVer range.
    pub compatibility: BTreeMap<String, String>,
    /// Package id -> SemVer range.
    pub dependencies: BTreeMap<String, String>,
    /// Package id -> optional SemVer range.
    pub conflicts: BTreeMap<String, Option<String>>,
    pub permissions: Permissions,
    pub risk_class: RiskClass,
}

impl Manifest {
    /// The normalized manifest stored in `skill_revisions.manifest_json` (canonical text).
    pub fn to_value(&self) -> Value {
        json!({
            "schema": MANIFEST_SCHEMA,
            "id": self.id,
            "version": self.version,
            "categories": self.categories.iter().collect::<Vec<_>>(),
            "intents": self.intents.iter().collect::<Vec<_>>(),
            "compatibility": self.compatibility,
            "dependencies": self.dependencies.iter()
                .map(|(id, range)| json!({ "id": id, "range": range }))
                .collect::<Vec<_>>(),
            "conflicts": self.conflicts.iter()
                .map(|(id, range)| match range {
                    Some(range) => json!({ "id": id, "range": range }),
                    None => json!({ "id": id }),
                })
                .collect::<Vec<_>>(),
            "permissions": self.permissions.to_value(),
            "risk_class": self.risk_class.as_str(),
        })
    }

    pub fn canonical_json(&self) -> String {
        canonical::to_string(&self.to_value())
    }
}

/// `name` and `description` from the `SKILL.md` front matter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontMatter {
    pub name: String,
    pub description: String,
}

/// The effective manifest of a staged package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageManifest {
    pub manifest: Manifest,
    pub inferred: bool,
    pub front_matter: FrontMatter,
}

/// Validate a package's manifest (or infer one) against its tree and `SKILL.md`.
/// `manifest` and `skill_md` must be the bytes read from the staged object.
pub fn resolve(
    tree: &Tree,
    manifest: Option<&[u8]>,
    skill_md: &[u8],
) -> Result<PackageManifest, SkillError> {
    let mut issues = Vec::new();
    let front_matter = match parse_front_matter(skill_md) {
        Ok(front_matter) => Some(front_matter),
        Err(issue) => {
            issues.push(issue);
            None
        }
    };
    let markdown_only = tree
        .files
        .iter()
        .all(|file| file.path == MANIFEST_FILE || file.path.to_ascii_lowercase().ends_with(".md"));
    let has_executable = tree.files.iter().any(|file| file.executable);
    let parsed = match manifest {
        Some(bytes) => match parse_manifest(bytes) {
            Ok(manifest) => Some((manifest, false)),
            Err(mut found) => {
                issues.append(&mut found);
                None
            }
        },
        None => front_matter.as_ref().map(|front_matter| {
            let risk_class = if markdown_only {
                RiskClass::Declarative
            } else {
                RiskClass::Executable
            };
            let manifest = Manifest {
                id: front_matter.name.clone(),
                version: format!("0.0.0+tree.{}", &tree.sha256[..16]),
                categories: BTreeSet::new(),
                intents: BTreeSet::new(),
                compatibility: BTreeMap::new(),
                dependencies: BTreeMap::new(),
                conflicts: BTreeMap::new(),
                permissions: Permissions::default(),
                risk_class,
            };
            (manifest, true)
        }),
    };
    if let (Some((manifest, false)), Some(front_matter)) = (&parsed, &front_matter) {
        if manifest.id != front_matter.name {
            issues.push("manifest.id: must equal the SKILL.md front matter name.".into());
        }
        if manifest.risk_class == RiskClass::Declarative && !markdown_only {
            issues
                .push("manifest.risk_class: declarative requires a Markdown-only package.".into());
        }
        if has_executable && manifest.risk_class != RiskClass::Executable {
            issues.push(
                "manifest.risk_class: a file with an executable bit requires executable.".into(),
            );
        }
    }
    match (parsed, front_matter) {
        (Some((manifest, inferred)), Some(front_matter)) if issues.is_empty() => {
            Ok(PackageManifest {
                manifest,
                inferred,
                front_matter,
            })
        }
        _ => Err(SkillError::Manifest(issues)),
    }
}

/// Parse `SKILL.md` like `parseSkill` in `packages/host/src/skills.ts`, except that `name`
/// is required (a package has no directory name to fall back on).
pub fn parse_front_matter(bytes: &[u8]) -> Result<FrontMatter, String> {
    if bytes.len() > MAX_SKILL_MD_BYTES {
        return Err("SKILL.md: larger than 256 KiB.".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "SKILL.md: not UTF-8.".to_owned())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return Err("SKILL.md: missing front matter.".into());
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim() == "---")
        .map(|(index, _)| index)
        .ok_or_else(|| "SKILL.md: front matter is not closed.".to_owned())?;
    let mut fields = BTreeMap::new();
    for line in &lines[1..close] {
        if let Some((key, value)) = front_matter_field(line) {
            fields.insert(key, value);
        }
    }
    let name = fields.remove("name").unwrap_or_default();
    if !is_package_name(&name) {
        return Err("SKILL.md: name is missing or invalid.".into());
    }
    let description = fields.remove("description").unwrap_or_default();
    let description = description.trim();
    if description.is_empty() {
        return Err("SKILL.md: description is missing.".into());
    }
    if lines[close + 1..].join("\n").trim().is_empty() {
        return Err("SKILL.md: no instructions after the front matter.".into());
    }
    Ok(FrontMatter {
        name,
        description: description.to_owned(),
    })
}

/// `^([A-Za-z][\w-]*)\s*:(.*)$`, key lowercased, value trimmed and unquoted.
fn front_matter_field(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim_end();
    let mut chars = key.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic()
        || !chars.all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    let value = value.trim();
    let quoted = value.len() >= 2
        && (value.starts_with('"') || value.starts_with('\''))
        && value.ends_with(&value[..1]);
    let value = if quoted {
        &value[1..value.len() - 1]
    } else {
        value
    };
    Some((key.to_lowercase(), value.to_owned()))
}

/// Parse and validate `extalia-skill.json`.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Vec<String>> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(vec!["manifest: larger than 64 KiB.".into()]);
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| vec!["manifest: not valid UTF-8 JSON.".to_owned()])?;
    let Value::Object(object) = value else {
        return Err(vec!["manifest: expected an object.".into()]);
    };
    let mut issues = Vec::new();
    known_fields(
        &object,
        "manifest",
        &[
            "schema",
            "id",
            "version",
            "categories",
            "intents",
            "compatibility",
            "dependencies",
            "conflicts",
            "permissions",
            "risk_class",
        ],
        &mut issues,
    );
    if object.get("schema").and_then(Value::as_str) != Some(MANIFEST_SCHEMA) {
        issues.push(format!("manifest.schema: expected \"{MANIFEST_SCHEMA}\"."));
    }
    let id = match object.get("id").and_then(Value::as_str) {
        Some(id) if is_package_name(id) => id.to_owned(),
        _ => {
            issues.push("manifest.id: expected a skill name (^[a-z0-9][a-z0-9-]{0,63}$).".into());
            String::new()
        }
    };
    let version = match object.get("version").and_then(Value::as_str) {
        Some(version) if is_semver(version) => version.to_owned(),
        _ => {
            issues.push("manifest.version: expected a SemVer 2.0 version.".into());
            String::new()
        }
    };
    let categories = string_set(
        object.get("categories"),
        "manifest.categories",
        MAX_CATEGORIES,
        is_category_id,
        &mut issues,
    );
    let intents = string_set(
        object.get("intents"),
        "manifest.intents",
        MAX_INTENTS,
        is_intent,
        &mut issues,
    );
    let mut compatibility = BTreeMap::new();
    match object.get("compatibility") {
        None => {}
        Some(Value::Object(map)) if map.len() <= MAX_RELATIONS => {
            for (fact, range) in map {
                match range.as_str() {
                    Some(range) if is_fact_id(fact) && is_range(range) => {
                        compatibility.insert(fact.clone(), range.to_owned());
                    }
                    _ => issues.push(
                        "manifest.compatibility: invalid entry (fact id and SemVer range).".into(),
                    ),
                }
            }
        }
        Some(_) => issues.push("manifest.compatibility: expected an object of ranges.".into()),
    }
    let dependencies = relations(
        object.get("dependencies"),
        "dependencies",
        true,
        &id,
        &mut issues,
    )
    .into_iter()
    .map(|(id, range)| (id, range.unwrap_or_default()))
    .collect();
    let conflicts = relations(
        object.get("conflicts"),
        "conflicts",
        false,
        &id,
        &mut issues,
    );
    let permissions = match object.get("permissions") {
        None => Permissions::default(),
        Some(Value::Object(map)) => permissions(map, &mut issues),
        Some(_) => {
            issues.push("manifest.permissions: expected an object.".into());
            Permissions::default()
        }
    };
    let risk_class = object
        .get("risk_class")
        .and_then(Value::as_str)
        .and_then(RiskClass::parse);
    if risk_class.is_none() {
        issues.push("manifest.risk_class: expected declarative, tool_using or executable.".into());
    }
    match risk_class {
        Some(risk_class) if issues.is_empty() => Ok(Manifest {
            id,
            version,
            categories,
            intents,
            compatibility,
            dependencies,
            conflicts,
            permissions,
            risk_class,
        }),
        _ => Err(issues),
    }
}

fn known_fields(object: &Map<String, Value>, at: &str, known: &[&str], issues: &mut Vec<String>) {
    for key in object.keys() {
        if !known.contains(&key.as_str()) {
            let key: String = key.chars().take(64).collect();
            issues.push(format!("{at}.{key}: unknown field."));
        }
    }
}

fn string_set(
    value: Option<&Value>,
    at: &str,
    max: usize,
    valid: fn(&str) -> bool,
    issues: &mut Vec<String>,
) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    match value {
        None => {}
        Some(Value::Array(items)) if items.len() <= max => {
            for item in items {
                match item.as_str() {
                    Some(text) if valid(text) => {
                        if !out.insert(text.to_owned()) {
                            issues.push(format!("{at}: duplicate entry."));
                        }
                    }
                    _ => issues.push(format!("{at}: invalid entry.")),
                }
            }
        }
        Some(_) => issues.push(format!("{at}: expected an array of at most {max} strings.")),
    }
    out
}

fn relations(
    value: Option<&Value>,
    name: &str,
    range_required: bool,
    own_id: &str,
    issues: &mut Vec<String>,
) -> BTreeMap<String, Option<String>> {
    let at = format!("manifest.{name}");
    let mut out = BTreeMap::new();
    let items = match value {
        None => return out,
        Some(Value::Array(items)) if items.len() <= MAX_RELATIONS => items,
        Some(_) => {
            issues.push(format!(
                "{at}: expected an array of at most {MAX_RELATIONS} entries."
            ));
            return out;
        }
    };
    for item in items {
        let Value::Object(entry) = item else {
            issues.push(format!("{at}: expected objects."));
            continue;
        };
        known_fields(entry, &at, &["id", "range"], issues);
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_package_name(id));
        let range = match entry.get("range") {
            None if !range_required => Some(None),
            Some(Value::String(range)) if is_range(range) => Some(Some(range.clone())),
            _ => None,
        };
        match (id, range) {
            (Some(id), Some(range)) if id != own_id => {
                if out.insert(id.to_owned(), range).is_some() {
                    issues.push(format!("{at}: duplicate id."));
                }
            }
            (Some(_), Some(_)) => issues.push(format!("{at}: a package cannot name itself.")),
            _ => issues.push(format!("{at}: invalid entry (id and SemVer range).")),
        }
    }
    out
}

fn permissions(map: &Map<String, Value>, issues: &mut Vec<String>) -> Permissions {
    known_fields(
        map,
        "manifest.permissions",
        &[
            "filesystem_read",
            "filesystem_write",
            "network",
            "terminal",
            "secrets",
        ],
        issues,
    );
    let mut out = Permissions {
        filesystem_read: string_set(
            map.get("filesystem_read"),
            "manifest.permissions.filesystem_read",
            MAX_SCOPES,
            is_workspace_glob,
            issues,
        ),
        filesystem_write: string_set(
            map.get("filesystem_write"),
            "manifest.permissions.filesystem_write",
            MAX_SCOPES,
            is_workspace_glob,
            issues,
        ),
        ..Permissions::default()
    };
    match map.get("network") {
        None | Some(Value::Bool(false)) => {}
        Some(list @ Value::Array(_)) => {
            out.network = string_set(
                Some(list),
                "manifest.permissions.network",
                MAX_SCOPES,
                is_host,
                issues,
            );
        }
        Some(_) => {
            issues.push("manifest.permissions.network: expected false or a host list.".into())
        }
    }
    match map.get("terminal") {
        None => {}
        Some(Value::Bool(terminal)) => out.terminal = *terminal,
        Some(_) => issues.push("manifest.permissions.terminal: expected a boolean.".into()),
    }
    match map.get("secrets") {
        None | Some(Value::Bool(false)) => {}
        Some(list @ Value::Array(_)) => {
            out.secrets = string_set(
                Some(list),
                "manifest.permissions.secrets",
                MAX_SCOPES,
                is_credential_ref,
                issues,
            );
        }
        Some(_) => {
            issues.push("manifest.permissions.secrets: expected false or credential refs.".into());
        }
    }
    out
}

/// SemVer 2.0.0: `MAJOR.MINOR.PATCH[-pre][+build]`, numbers without leading zeros.
pub fn is_semver(text: &str) -> bool {
    if text.len() > 128 {
        return false;
    }
    let (rest, build) = match text.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (text, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    let identifiers_ok = |text: &str, numeric_rule: bool| {
        text.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !(numeric_rule
                    && part.len() > 1
                    && part.starts_with('0')
                    && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
    };
    numbers.len() == 3
        && numbers.iter().all(|part| is_number(part))
        && pre.is_none_or(|pre| identifiers_ok(pre, true))
        && build.is_none_or(|build| identifiers_ok(build, false))
}

fn is_number(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 16
        && part.bytes().all(|byte| byte.is_ascii_digit())
        && !(part.len() > 1 && part.starts_with('0'))
}

/// Range syntax: `||`-separated sets of space-separated comparators
/// `[op]X[.Y[.Z[-pre]]]` with op one of `>= <= > < = ^ ~` and `*`/`x` wildcards.
pub fn is_range(text: &str) -> bool {
    if text.is_empty() || text.len() > 128 {
        return false;
    }
    text.split("||").all(|set| {
        let comparators: Vec<&str> = set.split_whitespace().collect();
        !comparators.is_empty()
            && comparators
                .iter()
                .all(|comparator| is_comparator(comparator))
    })
}

fn is_comparator(text: &str) -> bool {
    let version = [">=", "<=", ">", "<", "=", "^", "~"]
        .iter()
        .find_map(|op| text.strip_prefix(op))
        .unwrap_or(text);
    if version == "*" || version == "x" {
        return true;
    }
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let wildcard = |part: &str| part == "*" || part == "x" || part == "X";
    (1..=3).contains(&parts.len())
        && parts.iter().all(|part| is_number(part) || wildcard(part))
        && pre.is_none_or(|pre| {
            parts.len() == 3
                && pre.split('.').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
        })
}

/// Dotted category id: 1–6 segments of `[a-z0-9][a-z0-9_-]{0,31}`, at most 128 bytes.
pub fn is_category_id(text: &str) -> bool {
    let segments: Vec<&str> = text.split('.').collect();
    text.len() <= 128
        && segments.len() <= 6
        && segments.iter().all(|segment| {
            let bytes = segment.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 32
                && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
                && bytes.iter().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-')
                })
        })
}

/// snake_case intent: `^[a-z][a-z0-9_]{0,63}$`.
pub fn is_intent(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn is_fact_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
}

/// Workspace-relative glob: printable ASCII without `\`, not absolute, no drive letter,
/// no `~` prefix and no `.`/`..` segment.
pub fn is_workspace_glob(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_TEXT
        && bytes
            .iter()
            .all(|byte| (0x20..0x7f).contains(byte) && *byte != b'\\')
        && !text.starts_with('/')
        && !text.starts_with('~')
        && !(bytes.len() >= 2 && bytes[1] == b':')
        && text
            .split('/')
            .all(|segment| segment != ".." && segment != "." && !segment.is_empty())
}

/// Lowercase DNS host name, optionally prefixed by `*.`; no port, scheme or path.
pub fn is_host(text: &str) -> bool {
    let host = text.strip_prefix("*.").unwrap_or(text);
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 63
                && bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
                && bytes
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        })
}

fn is_credential_ref(text: &str) -> bool {
    is_fact_id(text)
}
