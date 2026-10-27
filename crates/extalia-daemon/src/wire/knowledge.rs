//! Wire mapping of the knowledge index operations (`daemonKnowledge.ts`,
//! `daemonKnowledgeRules.ts`). Requests are parsed into [`KnowledgeRequest`]; results, which
//! only the daemon produces, are validated field by field with the same rules and kept as
//! the validated JSON ([`ResponseResult::Knowledge`]). The shared fixtures keep both sides
//! equal.

use extalia_core::time::parse_utc;
use serde_json::{Map, Value};

use extalia_core::skills::is_workspace_id;

use super::skills::{is_digest, is_multiline, is_reason};
use super::{Check, MAX_SAFE_INTEGER, Op, RequestParams, ResponseResult};

const PARAMS: &str = "frame.params";
const RESULT: &str = "frame.result";

/// `DAEMON_KNOWLEDGE_LIMITS` of `daemonKnowledge.ts`.
pub mod limits {
    pub const PATH: usize = 1024;
    pub const NODE_ID: usize = 1100;
    pub const TITLE: usize = 512;
    pub const KIND: usize = 32;
    pub const VERIFICATION: usize = 32;
    pub const ALIAS: usize = 256;
    pub const TAG: usize = 128;
    pub const TASK_ID: usize = 128;
    pub const LIST_ITEMS: usize = 64;
    pub const LINK_TEXT: usize = 512;
    pub const CANDIDATES: usize = 16;
    pub const QUERY: usize = 200;
    pub const SEARCH_LIMIT: u64 = 50;
    pub const SEARCH_DEFAULT: u64 = 20;
    pub const SNIPPET: usize = 300;
    pub const PAGE_LIMIT: u64 = 200;
    pub const PAGE_DEFAULT: u64 = 100;
    pub const GRAPH_DEPTH: u64 = 3;
    pub const GRAPH_DEPTH_DEFAULT: u64 = 1;
    pub const GRAPH_NODES: u64 = 500;
    pub const GRAPH_NODES_DEFAULT: u64 = 200;
    pub const GRAPH_EDGES: usize = 2_000;
    pub const OVERVIEW_NODES: u64 = 2_000;
    pub const OVERVIEW_EDGES: u64 = 8_000;
    pub const OVERVIEW_TAGS: usize = 8;
    pub const OVERVIEW_TAG: usize = 64;
    pub const REPORT_ITEMS: usize = 100;
    pub const BODY_BYTES: usize = 256 * 1024;
    pub const READ_BYTES: usize = 256 * 1024;
    pub const CONTENT_BYTES: usize = 1024 * 1024;
    pub const HISTORY_LIMIT: u64 = 50;
    pub const HISTORY_DEFAULT: u64 = 20;
    pub const IMPORT_NOTES: usize = 500;
    pub const IMPORT_NAME: usize = 128;
    pub const CUSTOM_LABEL: usize = 128;
    pub const AUTHOR: usize = 80;
}
use limits::*;

const SYNC_MODES: &[&str] = &["incremental", "rebuild"];
const INDEX_STATES: &[&str] = &["ready", "unavailable"];
const EDGE_TYPES: &[&str] = &[
    "links_to",
    "related_to",
    "learned_from",
    "depends_on",
    "supersedes",
    "used_by",
];
const LINK_STATUSES: &[&str] = &["resolved", "missing", "ambiguous"];
const RESOLUTIONS: &[&str] = &["path", "path_suffix", "title", "alias"];
const SKIP_REASONS: &[&str] = &[
    "symlink",
    "special_file",
    "hard_link",
    "invalid_name",
    "too_deep",
    "too_large",
    "not_utf8",
    "invalid_front_matter",
    "profile_mismatch",
    "duplicate_id",
];
const BODY_STATUSES: &[&str] = &["current", "changed", "unavailable"];
const ORIGINS: &[&str] = &["vault"];
const WRITE_OUTCOMES: &[&str] = &["written", "unchanged", "conflict"];
const CONFLICT_REASONS: &[&str] = &["hash_mismatch", "changed_during_write", "not_managed"];
const WRITE_AUTHORS: &[&str] = &["user"];
const HISTORY_KINDS: &[&str] = &["write", "rollback", "conflict", "external"];
const IMPORT_OUTCOMES: &[&str] = &[
    "created",
    "updated",
    "unchanged",
    "conflict",
    "pending_conflict",
    "missing_in_vault",
    "skipped",
];
const TRUST_STATUSES: &[&str] = &[
    "untrusted",
    "unverified",
    "verified",
    "disputed",
    "superseded",
    "revoked",
];

/// `knowledge.sync` mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    Incremental,
    Rebuild,
}

impl SyncMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incremental => "incremental",
            Self::Rebuild => "rebuild",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "incremental" => Some(Self::Incremental),
            "rebuild" => Some(Self::Rebuild),
            _ => None,
        }
    }
}

/// How `knowledge.node` names its note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeTarget {
    Id(String),
    Path(String),
}

/// Parameters of one knowledge operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnowledgeRequest {
    Status,
    Sync {
        mode: SyncMode,
    },
    Node {
        target: NodeTarget,
    },
    Links {
        node_id: String,
        cursor: Option<u64>,
        limit: Option<u64>,
    },
    Backlinks {
        node_id: String,
        cursor: Option<u64>,
        limit: Option<u64>,
    },
    Search {
        query: String,
        limit: Option<u64>,
    },
    Graph {
        node_id: String,
        depth: Option<u64>,
        limit: Option<u64>,
    },
    Overview {
        node_limit: Option<u64>,
        edge_limit: Option<u64>,
    },
    Read {
        path: String,
    },
    /// Always by `author: 'user'`, the only wire author.
    Write {
        path: String,
        content: String,
        /// `None`: omitted; `Some(None)`: `null` (both mean the note must not exist).
        expected_sha256: Option<Option<String>>,
    },
    History {
        path: String,
        limit: Option<u64>,
    },
    Rollback {
        path: String,
        to_sha256: String,
        /// `None`: `null` (the note must not exist).
        expected_sha256: Option<String>,
    },
    ImportMemory {
        workspace_id: String,
        dry_run: Option<bool>,
    },
}

impl KnowledgeRequest {
    pub fn op(&self) -> Op {
        match self {
            Self::Status => Op::KnowledgeStatus,
            Self::Sync { .. } => Op::KnowledgeSync,
            Self::Node { .. } => Op::KnowledgeNode,
            Self::Links { .. } => Op::KnowledgeLinks,
            Self::Backlinks { .. } => Op::KnowledgeBacklinks,
            Self::Search { .. } => Op::KnowledgeSearch,
            Self::Graph { .. } => Op::KnowledgeGraph,
            Self::Overview { .. } => Op::KnowledgeOverview,
            Self::Read { .. } => Op::KnowledgeRead,
            Self::Write { .. } => Op::KnowledgeWrite,
            Self::History { .. } => Op::KnowledgeHistory,
            Self::Rollback { .. } => Op::KnowledgeRollback,
            Self::ImportMemory { .. } => Op::KnowledgeImportMemory,
        }
    }

    pub(super) fn to_value(&self) -> Value {
        let mut fields = Map::new();
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                fields.insert(key.to_owned(), value);
            }
        };
        match self {
            Self::Status => {}
            Self::Sync { mode } => put("mode", Some(mode.as_str().into())),
            Self::Node { target } => match target {
                NodeTarget::Id(id) => put("nodeId", Some(id.as_str().into())),
                NodeTarget::Path(path) => put("path", Some(path.as_str().into())),
            },
            Self::Links {
                node_id,
                cursor,
                limit,
            }
            | Self::Backlinks {
                node_id,
                cursor,
                limit,
            } => {
                put("nodeId", Some(node_id.as_str().into()));
                put("cursor", cursor.map(Value::from));
                put("limit", limit.map(Value::from));
            }
            Self::Search { query, limit } => {
                put("query", Some(query.as_str().into()));
                put("limit", limit.map(Value::from));
            }
            Self::Graph {
                node_id,
                depth,
                limit,
            } => {
                put("nodeId", Some(node_id.as_str().into()));
                put("depth", depth.map(Value::from));
                put("limit", limit.map(Value::from));
            }
            Self::Overview {
                node_limit,
                edge_limit,
            } => {
                put("nodeLimit", node_limit.map(Value::from));
                put("edgeLimit", edge_limit.map(Value::from));
            }
            Self::Read { path } => put("path", Some(path.as_str().into())),
            Self::Write {
                path,
                content,
                expected_sha256,
            } => {
                put("path", Some(path.as_str().into()));
                put("content", Some(content.as_str().into()));
                put(
                    "expectedSha256",
                    expected_sha256
                        .as_ref()
                        .map(|hash| hash.as_deref().map_or(Value::Null, Value::from)),
                );
                put("author", Some("user".into()));
            }
            Self::History { path, limit } => {
                put("path", Some(path.as_str().into()));
                put("limit", limit.map(Value::from));
            }
            Self::Rollback {
                path,
                to_sha256,
                expected_sha256,
            } => {
                put("path", Some(path.as_str().into()));
                put("toSha256", Some(to_sha256.as_str().into()));
                put(
                    "expectedSha256",
                    Some(expected_sha256.as_deref().map_or(Value::Null, Value::from)),
                );
            }
            Self::ImportMemory {
                workspace_id,
                dry_run,
            } => {
                put("workspaceId", Some(workspace_id.as_str().into()));
                put("dryRun", dry_run.map(Value::from));
            }
        }
        Value::Object(fields)
    }
}

// ---- patterns (`daemonKnowledge.ts`) ----

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_control(character: char) -> bool {
    (character as u32) < 32 || character as u32 == 127
}

/// The segments of `KNOWLEDGE_PATH_PATTERN`, without its length bound.
fn is_path_segments(text: &str) -> bool {
    text.split('/').all(|segment| {
        let mut characters = segment.chars();
        characters
            .next()
            .is_some_and(|first| first != '.' && first != '\\' && !is_control(first))
            && characters.all(|character| character != '\\' && !is_control(character))
    })
}

/// `KNOWLEDGE_PATH_PATTERN` with at most [`limits::PATH`] characters.
pub fn is_vault_path(text: &str) -> bool {
    utf16_len(text) <= PATH && is_path_segments(text)
}

/// A front matter id (`^[a-z0-9][a-z0-9._-]{0,127}$`).
fn is_front_matter_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=128).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|&byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

/// `KNOWLEDGE_NODE_ID_PATTERN` with at most [`limits::NODE_ID`] characters.
pub fn is_node_id(text: &str) -> bool {
    utf16_len(text) <= NODE_ID
        && (is_front_matter_id(text) || text.strip_prefix("path:").is_some_and(is_path_segments))
}

/// `KNOWLEDGE_FOLDER_PATTERN`: a vault path, or empty for the vault root.
pub fn is_folder(text: &str) -> bool {
    text.is_empty() || is_vault_path(text)
}

/// `KNOWLEDGE_VAULT_LABEL_PATTERN` with at most `7 +` [`limits::CUSTOM_LABEL`] characters.
pub fn is_vault_label(text: &str) -> bool {
    if let Some(name) = text.strip_prefix("custom:") {
        return !name.is_empty()
            && utf16_len(name) <= CUSTOM_LABEL
            && name
                .chars()
                .all(|character| character != '/' && character != '\\' && !is_control(character));
    }
    text.strip_prefix("vaults/").is_some_and(|profile| {
        let bytes = profile.as_bytes();
        (1..=64).contains(&bytes.len())
            && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes[1..]
                .iter()
                .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// `KNOWLEDGE_HISTORY_AUTHOR_PATTERN`.
pub fn is_history_author(text: &str) -> bool {
    match text {
        "user" | "external" => true,
        _ => text.strip_prefix("extalia:").is_some_and(|component| {
            let bytes = component.as_bytes();
            (1..=64).contains(&bytes.len())
                && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
                && bytes[1..]
                    .iter()
                    .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        }),
    }
}

// ---- field rules (free functions: the skill module owns the `Check` helper names) ----

type Fields = Map<String, Value>;

fn pattern(
    check: &mut Check,
    value: Option<&Value>,
    path: &str,
    accepts: fn(&str) -> bool,
    message: &str,
) -> bool {
    let Some(value) = value else {
        return false;
    };
    let ok = value.as_str().is_some_and(accepts);
    if !ok {
        check.fail(path, message);
    }
    ok
}

fn node_id(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    pattern(
        check,
        value,
        path,
        is_node_id,
        "expected a knowledge node id",
    )
}

fn vault_path(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    pattern(
        check,
        value,
        path,
        is_vault_path,
        "expected a vault-relative path",
    )
}

fn text(check: &mut Check, value: Option<&Value>, path: &str, max: usize) -> bool {
    check.text(value, path, max).is_some()
}

fn count(check: &mut Check, value: Option<&Value>, path: &str, min: u64, max: u64) -> bool {
    value.is_some_and(|value| check.integer(value, path, min, max).is_some())
}

fn boolean(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    let Some(value) = value else {
        return false;
    };
    if !value.is_boolean() {
        check.fail(path, "expected a boolean");
    }
    value.is_boolean()
}

fn one_of(check: &mut Check, value: Option<&Value>, path: &str, all: &[&str]) -> bool {
    let Some(value) = value else {
        return false;
    };
    let ok = value.as_str().is_some_and(|text| all.contains(&text));
    if !ok {
        check.fail(path, &format!("expected one of {}", all.join(", ")));
    }
    ok
}

fn timestamp(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    pattern(
        check,
        value,
        path,
        |text| parse_utc(text).is_some(),
        "expected a real UTC timestamp",
    )
}

/// Optional field: absent passes, present must satisfy `rule`.
fn optional(
    check: &mut Check,
    fields: &Fields,
    key: &str,
    path: &str,
    rule: impl FnOnce(&mut Check, Option<&Value>, &str) -> bool,
) -> bool {
    match fields.get(key) {
        None => true,
        Some(value) => rule(check, Some(value), &format!("{path}.{key}")),
    }
}

/// An array of `min` to `max` items (unique primitives when `unique`), each checked by `item`.
fn items(
    check: &mut Check,
    value: Option<&Value>,
    path: &str,
    (min, max, unique): (usize, usize, bool),
    item: &dyn Fn(&mut Check, &Value, &str) -> bool,
) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(list) = value
        .as_array()
        .filter(|list| (min..=max).contains(&list.len()))
    else {
        check.fail(
            path,
            &format!("expected an array with {min} to {max} items"),
        );
        return false;
    };
    let mut ok = true;
    if unique
        && list.iter().enumerate().any(|(index, entry)| {
            !entry.is_object() && !entry.is_array() && list[..index].contains(entry)
        })
    {
        check.fail(path, "duplicate values");
        ok = false;
    }
    for (index, entry) in list.iter().enumerate() {
        ok &= item(check, entry, &format!("{path}[{index}]"));
    }
    ok
}

fn texts(max_text: usize, max_items: usize) -> impl Fn(&mut Check, Option<&Value>, &str) -> bool {
    move |check, value, path| {
        items(
            check,
            value,
            path,
            (0, max_items, false),
            &|check, entry, path| text(check, Some(entry), path, max_text),
        )
    }
}

fn digest(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    pattern(
        check,
        value,
        path,
        is_digest,
        "expected a lowercase SHA-256 digest",
    )
}

/// Note text exactly as stored: at most `max` UTF-8 bytes (Rust strings are well-formed).
fn note_text(check: &mut Check, value: Option<&Value>, path: &str, max: usize) -> bool {
    let Some(value) = value else {
        return false;
    };
    let ok = value.as_str().is_some_and(|text| text.len() <= max);
    if !ok {
        check.fail(
            path,
            &format!("expected well-formed text of at most {max} UTF-8 bytes"),
        );
    }
    ok
}

/// A digest or `null`: `Some(None)` for `null`.
fn expected(check: &mut Check, value: Option<&Value>, path: &str) -> Option<Option<String>> {
    match value? {
        Value::Null => Some(None),
        Value::String(text) if is_digest(text) => Some(Some(text.clone())),
        _ => {
            check.fail(path, "expected a lowercase SHA-256 digest or null");
            None
        }
    }
}

/// Which of `managed` may appear for the value of `key`: `(value, required, optional)`; the
/// others must be absent (the TypeScript `consistent` rule).
fn consistent(
    check: &mut Check,
    fields: &Fields,
    path: &str,
    key: &str,
    managed: &[&str],
    cases: &[(&str, &[&str], &[&str])],
) -> bool {
    let Some((_, required, allowed)) = cases
        .iter()
        .find(|(name, ..)| fields.get(key).and_then(Value::as_str) == Some(*name))
    else {
        return true;
    };
    let mut ok = true;
    for field in managed {
        let present = fields.contains_key(*field);
        if required.contains(field) && !present {
            check.fail(&format!("{path}.{field}"), "required for this value");
            ok = false;
        }
        if !required.contains(field) && !allowed.contains(field) && present {
            check.fail(&format!("{path}.{field}"), "not allowed for this value");
            ok = false;
        }
    }
    ok
}

fn all(results: &[bool]) -> Option<()> {
    results.iter().all(|ok| *ok).then_some(())
}

// ---- requests ----

pub(super) fn request(check: &mut Check, op: Op, params: &Value) -> Option<RequestParams> {
    let at = |key: &str| format!("{PARAMS}.{key}");
    let limit_opt =
        |check: &mut Check, fields: &Fields, key: &str, min: u64, max: u64| match fields.get(key) {
            None => Some(None),
            Some(value) => check.integer(value, &at(key), min, max).map(Some),
        };
    let path_of = |check: &mut Check, fields: &Fields| {
        let value = fields.get("path");
        vault_path(check, value, &at("path"))
            .then(|| value.and_then(Value::as_str).unwrap_or_default().to_owned())
    };
    let node_id_of = |check: &mut Check, fields: &Fields| {
        let value = fields.get("nodeId");
        node_id(check, value, &at("nodeId"))
            .then(|| value.and_then(Value::as_str).unwrap_or_default().to_owned())
    };
    let request = match op {
        Op::KnowledgeStatus => {
            check.object(params, PARAMS, &[], &[])?;
            KnowledgeRequest::Status
        }
        Op::KnowledgeSync => {
            let fields = check.object(params, PARAMS, &["mode"], &[])?;
            KnowledgeRequest::Sync {
                mode: check.name(fields.get("mode"), &at("mode"), SyncMode::parse)?,
            }
        }
        Op::KnowledgeNode => {
            let fields = check.object(params, PARAMS, &[], &["nodeId", "path"])?;
            let id = fields.get("nodeId").map(|_| node_id_of(check, fields));
            let path = fields.get("path").map(|value| {
                vault_path(check, Some(value), &at("path"))
                    .then(|| value.as_str().unwrap_or_default().to_owned())
            });
            let target = match (id, path) {
                (Some(id), None) => NodeTarget::Id(id?),
                (None, Some(path)) => NodeTarget::Path(path?),
                (id, path) => {
                    // Report field errors first, like the TypeScript rule.
                    if id.is_none_or(|id| id.is_some()) && path.is_none_or(|path| path.is_some()) {
                        check.fail(PARAMS, "expected exactly one of nodeId and path");
                    }
                    return None;
                }
            };
            KnowledgeRequest::Node { target }
        }
        Op::KnowledgeLinks | Op::KnowledgeBacklinks => {
            let fields = check.object(params, PARAMS, &["nodeId"], &["cursor", "limit"])?;
            let node_id = node_id_of(check, fields);
            let cursor = limit_opt(check, fields, "cursor", 0, MAX_SAFE_INTEGER);
            let limit = limit_opt(check, fields, "limit", 1, PAGE_LIMIT);
            let (node_id, cursor, limit) = (node_id?, cursor?, limit?);
            if op == Op::KnowledgeLinks {
                KnowledgeRequest::Links {
                    node_id,
                    cursor,
                    limit,
                }
            } else {
                KnowledgeRequest::Backlinks {
                    node_id,
                    cursor,
                    limit,
                }
            }
        }
        Op::KnowledgeSearch => {
            let fields = check.object(params, PARAMS, &["query"], &["limit"])?;
            let query = check.text(fields.get("query"), &at("query"), QUERY);
            let limit = limit_opt(check, fields, "limit", 1, SEARCH_LIMIT);
            KnowledgeRequest::Search {
                query: query?,
                limit: limit?,
            }
        }
        Op::KnowledgeGraph => {
            let fields = check.object(params, PARAMS, &["nodeId"], &["depth", "limit"])?;
            let node_id = node_id_of(check, fields);
            let depth = limit_opt(check, fields, "depth", 1, GRAPH_DEPTH);
            let limit = limit_opt(check, fields, "limit", 1, GRAPH_NODES);
            KnowledgeRequest::Graph {
                node_id: node_id?,
                depth: depth?,
                limit: limit?,
            }
        }
        Op::KnowledgeOverview => {
            let fields = check.object(params, PARAMS, &[], &["nodeLimit", "edgeLimit"])?;
            let node_limit = limit_opt(check, fields, "nodeLimit", 1, OVERVIEW_NODES);
            let edge_limit = limit_opt(check, fields, "edgeLimit", 1, OVERVIEW_EDGES);
            KnowledgeRequest::Overview {
                node_limit: node_limit?,
                edge_limit: edge_limit?,
            }
        }
        Op::KnowledgeRead => {
            let fields = check.object(params, PARAMS, &["path"], &[])?;
            KnowledgeRequest::Read {
                path: path_of(check, fields)?,
            }
        }
        Op::KnowledgeWrite => {
            let fields = check.object(
                params,
                PARAMS,
                &["path", "content", "author"],
                &["expectedSha256"],
            )?;
            let path = path_of(check, fields);
            let content = note_text(check, fields.get("content"), &at("content"), CONTENT_BYTES)
                .then(|| fields["content"].as_str().unwrap_or_default().to_owned());
            let expected_sha256 = match fields.get("expectedSha256") {
                None => Some(None),
                value => expected(check, value, &at("expectedSha256")).map(Some),
            };
            let author = one_of(check, fields.get("author"), &at("author"), WRITE_AUTHORS);
            if !author {
                return None;
            }
            KnowledgeRequest::Write {
                path: path?,
                content: content?,
                expected_sha256: expected_sha256?,
            }
        }
        Op::KnowledgeHistory => {
            let fields = check.object(params, PARAMS, &["path"], &["limit"])?;
            let path = path_of(check, fields);
            let limit = limit_opt(check, fields, "limit", 1, HISTORY_LIMIT);
            KnowledgeRequest::History {
                path: path?,
                limit: limit?,
            }
        }
        Op::KnowledgeRollback => {
            let fields =
                check.object(params, PARAMS, &["path", "toSha256", "expectedSha256"], &[])?;
            let path = path_of(check, fields);
            let to_sha256 = digest(check, fields.get("toSha256"), &at("toSha256"))
                .then(|| fields["toSha256"].as_str().unwrap_or_default().to_owned());
            let expected_sha256 =
                expected(check, fields.get("expectedSha256"), &at("expectedSha256"));
            KnowledgeRequest::Rollback {
                path: path?,
                to_sha256: to_sha256?,
                expected_sha256: expected_sha256?,
            }
        }
        Op::KnowledgeImportMemory => {
            let fields = check.object(params, PARAMS, &["workspaceId"], &["dryRun"])?;
            let workspace_id = pattern(
                check,
                fields.get("workspaceId"),
                &at("workspaceId"),
                is_workspace_id,
                "expected a workspace id (w_… or a lowercase UUID)",
            )
            .then(|| {
                fields["workspaceId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            });
            let dry_run = match fields.get("dryRun") {
                None => Some(None),
                Some(value) => boolean(check, Some(value), &at("dryRun"))
                    .then(|| value.as_bool())
                    .flatten()
                    .map(Some),
            };
            KnowledgeRequest::ImportMemory {
                workspace_id: workspace_id?,
                dry_run: dry_run?,
            }
        }
        _ => return None,
    };
    Some(RequestParams::Knowledge(request))
}

// ---- results ----

fn node_ref(check: &mut Check, value: &Value, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = check.object(value, path, &["nodeId", "path", "title"], &[]) else {
        return false;
    };
    all(&[
        node_id(check, fields.get("nodeId"), &at("nodeId")),
        vault_path(check, fields.get("path"), &at("path")),
        text(check, fields.get("title"), &at("title"), TITLE),
    ])
    .is_some()
}

fn counts(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = value.and_then(|value| {
        check.object(
            value,
            path,
            &["notes", "edges", "unresolvedLinks", "skipped"],
            &[],
        )
    }) else {
        return false;
    };
    ["notes", "edges", "unresolvedLinks", "skipped"]
        .iter()
        .map(|key| count(check, fields.get(*key), &at(key), 0, MAX_SAFE_INTEGER))
        .fold(true, |ok, item| ok & item)
}

const SUMMARY_COUNTS: &[&str] = &[
    "generation",
    "notes",
    "added",
    "updated",
    "removed",
    "unchanged",
    "renamed",
    "skipped",
    "unresolvedLinks",
];

fn summary(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let mut required = vec!["mode", "at"];
    required.extend_from_slice(SUMMARY_COUNTS);
    let Some(fields) = value.and_then(|value| check.object(value, path, &required, &[])) else {
        return false;
    };
    let mut ok = one_of(check, fields.get("mode"), &at("mode"), SYNC_MODES);
    ok &= timestamp(check, fields.get("at"), &at("at"));
    for key in SUMMARY_COUNTS {
        ok &= count(check, fields.get(*key), &at(key), 0, MAX_SAFE_INTEGER);
    }
    ok
}

fn node(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = value.and_then(|value| {
        check.object(
            value,
            path,
            &[
                "nodeId",
                "idFromFrontMatter",
                "path",
                "kind",
                "title",
                "aliases",
                "tags",
                "origin",
                "trustStatus",
                "sourceSha256",
                "observedAt",
                "declaredSourceTaskIds",
            ],
            &[
                "sourceModifiedAt",
                "declaredVerification",
                "declaredRevision",
            ],
        )
    }) else {
        return false;
    };
    all(&[
        node_id(check, fields.get("nodeId"), &at("nodeId")),
        boolean(
            check,
            fields.get("idFromFrontMatter"),
            &at("idFromFrontMatter"),
        ),
        vault_path(check, fields.get("path"), &at("path")),
        text(check, fields.get("kind"), &at("kind"), KIND),
        text(check, fields.get("title"), &at("title"), TITLE),
        texts(ALIAS, LIST_ITEMS)(check, fields.get("aliases"), &at("aliases")),
        texts(TAG, LIST_ITEMS)(check, fields.get("tags"), &at("tags")),
        one_of(check, fields.get("origin"), &at("origin"), ORIGINS),
        one_of(
            check,
            fields.get("trustStatus"),
            &at("trustStatus"),
            TRUST_STATUSES,
        ),
        pattern(
            check,
            fields.get("sourceSha256"),
            &at("sourceSha256"),
            is_digest,
            "expected a lowercase SHA-256 digest",
        ),
        optional(check, fields, "sourceModifiedAt", path, timestamp),
        timestamp(check, fields.get("observedAt"), &at("observedAt")),
        optional(
            check,
            fields,
            "declaredVerification",
            path,
            |check, value, path| text(check, value, path, VERIFICATION),
        ),
        optional(
            check,
            fields,
            "declaredRevision",
            path,
            |check, value, path| count(check, value, path, 0, MAX_SAFE_INTEGER),
        ),
        texts(TASK_ID, LIST_ITEMS)(
            check,
            fields.get("declaredSourceTaskIds"),
            &at("declaredSourceTaskIds"),
        ),
    ])
    .is_some()
}

fn link(check: &mut Check, value: &Value, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = check.object(
        value,
        path,
        &[
            "sourceNodeId",
            "ordinal",
            "edgeType",
            "embed",
            "line",
            "target",
            "status",
        ],
        &["heading", "display", "via", "targetNodeId", "candidates"],
    ) else {
        return false;
    };
    let ok = all(&[
        node_id(check, fields.get("sourceNodeId"), &at("sourceNodeId")),
        count(
            check,
            fields.get("ordinal"),
            &at("ordinal"),
            0,
            MAX_SAFE_INTEGER,
        ),
        one_of(check, fields.get("edgeType"), &at("edgeType"), EDGE_TYPES),
        boolean(check, fields.get("embed"), &at("embed")),
        count(check, fields.get("line"), &at("line"), 1, MAX_SAFE_INTEGER),
        text(check, fields.get("target"), &at("target"), LINK_TEXT),
        optional(check, fields, "heading", path, |check, value, path| {
            text(check, value, path, LINK_TEXT)
        }),
        optional(check, fields, "display", path, |check, value, path| {
            text(check, value, path, LINK_TEXT)
        }),
        one_of(check, fields.get("status"), &at("status"), LINK_STATUSES),
        optional(check, fields, "via", path, |check, value, path| {
            one_of(check, value, path, RESOLUTIONS)
        }),
        optional(check, fields, "targetNodeId", path, node_id),
        optional(check, fields, "candidates", path, |check, value, path| {
            items(
                check,
                value,
                path,
                (1, CANDIDATES, true),
                &|check, entry, path| node_id(check, Some(entry), path),
            )
        }),
    ])
    .is_some();
    if !ok {
        return false;
    }
    // `resolved` ⇔ `via` and `targetNodeId`; `ambiguous` ⇔ `candidates`; `missing`: none.
    let wanted: &[&str] = match fields.get("status").and_then(Value::as_str) {
        Some("resolved") => &["via", "targetNodeId"],
        Some("ambiguous") => &["candidates"],
        _ => &[],
    };
    let mut consistent = true;
    for key in ["via", "targetNodeId", "candidates"] {
        if wanted.contains(&key) != fields.contains_key(key) {
            check.fail(&at(key), "does not match the link status");
            consistent = false;
        }
    }
    consistent
}

fn link_page(check: &mut Check, result: &Value) -> Option<()> {
    let at = |key: &str| format!("{RESULT}.{key}");
    let fields = check.object(
        result,
        RESULT,
        &["generation", "nodeId", "links", "nodes"],
        &["nextCursor"],
    )?;
    let page = (0, PAGE_LIMIT as usize, false);
    all(&[
        count(
            check,
            fields.get("generation"),
            &at("generation"),
            0,
            MAX_SAFE_INTEGER,
        ),
        node_id(check, fields.get("nodeId"), &at("nodeId")),
        items(check, fields.get("links"), &at("links"), page, &link),
        items(check, fields.get("nodes"), &at("nodes"), page, &node_ref),
        optional(check, fields, "nextCursor", RESULT, |check, value, path| {
            count(check, value, path, 1, MAX_SAFE_INTEGER)
        }),
    ])
}

fn overview_node(check: &mut Check, value: &Value, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = check.object(
        value,
        path,
        &[
            "nodeId",
            "title",
            "path",
            "folder",
            "tags",
            "degree",
            "inDegree",
            "outDegree",
            "modifiedAt",
        ],
        &["kind"],
    ) else {
        return false;
    };
    all(&[
        node_id(check, fields.get("nodeId"), &at("nodeId")),
        text(check, fields.get("title"), &at("title"), TITLE),
        vault_path(check, fields.get("path"), &at("path")),
        optional(check, fields, "kind", path, |check, value, path| {
            text(check, value, path, KIND)
        }),
        pattern(
            check,
            fields.get("folder"),
            &at("folder"),
            is_folder,
            "expected a vault-relative folder or the empty root",
        ),
        texts(OVERVIEW_TAG, OVERVIEW_TAGS)(check, fields.get("tags"), &at("tags")),
        count(
            check,
            fields.get("degree"),
            &at("degree"),
            0,
            MAX_SAFE_INTEGER,
        ),
        count(
            check,
            fields.get("inDegree"),
            &at("inDegree"),
            0,
            MAX_SAFE_INTEGER,
        ),
        count(
            check,
            fields.get("outDegree"),
            &at("outDegree"),
            0,
            MAX_SAFE_INTEGER,
        ),
        timestamp(check, fields.get("modifiedAt"), &at("modifiedAt")),
    ])
    .is_some()
}

fn overview_edge(check: &mut Check, value: &Value, path: &str) -> bool {
    check
        .object(value, path, &["source", "target", "type"], &[])
        .is_some_and(|fields| {
            all(&[
                node_id(check, fields.get("source"), &format!("{path}.source")),
                node_id(check, fields.get("target"), &format!("{path}.target")),
                one_of(
                    check,
                    fields.get("type"),
                    &format!("{path}.type"),
                    EDGE_TYPES,
                ),
            ])
            .is_some()
        })
}

fn write_result(check: &mut Check, value: &Value, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = check.object(
        value,
        path,
        &["outcome", "path"],
        &["sha256", "previousSha256", "conflictPath", "conflictReason"],
    ) else {
        return false;
    };
    all(&[
        one_of(check, fields.get("outcome"), &at("outcome"), WRITE_OUTCOMES),
        vault_path(check, fields.get("path"), &at("path")),
        optional(check, fields, "sha256", path, digest),
        optional(check, fields, "previousSha256", path, digest),
        optional(check, fields, "conflictPath", path, vault_path),
        optional(
            check,
            fields,
            "conflictReason",
            path,
            |check, value, path| one_of(check, value, path, CONFLICT_REASONS),
        ),
    ])
    .is_some()
        && consistent(
            check,
            fields,
            path,
            "outcome",
            &["sha256", "previousSha256", "conflictPath", "conflictReason"],
            &[
                ("written", &["sha256"], &["previousSha256"]),
                ("unchanged", &["sha256"], &[]),
                ("conflict", &["conflictPath", "conflictReason"], &["sha256"]),
            ],
        )
}

fn history_entry(check: &mut Check, value: &Value, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = check.object(
        value,
        path,
        &["sha256", "at", "kind", "author"],
        &["previousSha256", "conflictPath"],
    ) else {
        return false;
    };
    all(&[
        digest(check, fields.get("sha256"), &at("sha256")),
        timestamp(check, fields.get("at"), &at("at")),
        one_of(check, fields.get("kind"), &at("kind"), HISTORY_KINDS),
        pattern(
            check,
            fields.get("author"),
            &at("author"),
            |text| utf16_len(text) <= AUTHOR && is_history_author(text),
            "expected a journal author",
        ),
        optional(check, fields, "previousSha256", path, digest),
        optional(check, fields, "conflictPath", path, vault_path),
    ])
    .is_some()
        && consistent(
            check,
            fields,
            path,
            "kind",
            &["previousSha256", "conflictPath"],
            &[
                ("write", &[], &["previousSha256"]),
                ("rollback", &[], &["previousSha256"]),
                ("conflict", &["conflictPath"], &["previousSha256"]),
                ("external", &[], &[]),
            ],
        )
}

fn imported_note(check: &mut Check, value: &Value, path: &str) -> bool {
    let at = |key: &str| format!("{path}.{key}");
    let Some(fields) = check.object(
        value,
        path,
        &["name", "outcome", "masked"],
        &["vaultPath", "reason"],
    ) else {
        return false;
    };
    let ok = all(&[
        text(check, fields.get("name"), &at("name"), IMPORT_NAME),
        optional(check, fields, "vaultPath", path, vault_path),
        one_of(
            check,
            fields.get("outcome"),
            &at("outcome"),
            IMPORT_OUTCOMES,
        ),
        count(
            check,
            fields.get("masked"),
            &at("masked"),
            0,
            MAX_SAFE_INTEGER,
        ),
        optional(check, fields, "reason", path, |check, value, path| {
            one_of(check, value, path, SKIP_REASONS)
        }),
    ])
    .is_some();
    let cases: Vec<(&str, &[&str], &[&str])> = IMPORT_OUTCOMES
        .iter()
        .map(|outcome| -> (&str, &[&str], &[&str]) {
            if *outcome == "skipped" {
                (outcome, &["reason"], &["vaultPath"])
            } else {
                (outcome, &["vaultPath"], &[])
            }
        })
        .collect();
    ok && consistent(
        check,
        fields,
        path,
        "outcome",
        &["vaultPath", "reason"],
        &cases,
    )
}

const IMPORT_COUNTS: &[&str] = &[
    "total",
    "created",
    "updated",
    "unchanged",
    "conflict",
    "pendingConflict",
    "missingInVault",
    "skipped",
    "masked",
];

fn import_counts(check: &mut Check, value: Option<&Value>, path: &str) -> bool {
    let Some(fields) = value.and_then(|value| check.object(value, path, IMPORT_COUNTS, &[])) else {
        return false;
    };
    IMPORT_COUNTS
        .iter()
        .map(|key| {
            count(
                check,
                fields.get(*key),
                &format!("{path}.{key}"),
                0,
                MAX_SAFE_INTEGER,
            )
        })
        .fold(true, |ok, item| ok & item)
}

pub(super) fn result(check: &mut Check, op: Op, result: &Value) -> Option<ResponseResult> {
    let at = |key: &str| format!("{RESULT}.{key}");
    let valid = match op {
        Op::KnowledgeStatus => {
            let fields = check.object(
                result,
                RESULT,
                &["state", "vaultRoot", "vaultPresent", "generation"],
                &["reason", "schemaVersion", "counts", "lastSync"],
            )?;
            all(&[
                one_of(check, fields.get("state"), &at("state"), INDEX_STATES),
                optional(check, fields, "reason", RESULT, |check, value, path| {
                    pattern(check, value, path, is_reason, "expected a reason code")
                }),
                pattern(
                    check,
                    fields.get("vaultRoot"),
                    &at("vaultRoot"),
                    is_vault_label,
                    "expected a vault label relative to the data directory",
                ),
                boolean(check, fields.get("vaultPresent"), &at("vaultPresent")),
                optional(
                    check,
                    fields,
                    "schemaVersion",
                    RESULT,
                    |check, value, path| count(check, value, path, 1, MAX_SAFE_INTEGER),
                ),
                count(
                    check,
                    fields.get("generation"),
                    &at("generation"),
                    0,
                    MAX_SAFE_INTEGER,
                ),
                optional(check, fields, "counts", RESULT, counts),
                optional(check, fields, "lastSync", RESULT, summary),
            ])
        }
        Op::KnowledgeSync => {
            let numbers = [
                "generation",
                "notes",
                "added",
                "updated",
                "removed",
                "unchanged",
                "unresolvedLinks",
                "renamedTotal",
                "skippedTotal",
            ];
            let mut required = vec!["mode", "at", "renamed", "skipped", "vaultCreated"];
            required.extend_from_slice(&numbers);
            let fields = check.object(result, RESULT, &required, &[])?;
            let mut ok = one_of(check, fields.get("mode"), &at("mode"), SYNC_MODES);
            ok &= timestamp(check, fields.get("at"), &at("at"));
            for key in numbers {
                ok &= count(check, fields.get(key), &at(key), 0, MAX_SAFE_INTEGER);
            }
            let report = (0, REPORT_ITEMS, false);
            ok &= items(
                check,
                fields.get("renamed"),
                &at("renamed"),
                report,
                &|check, entry, path| {
                    check
                        .object(entry, path, &["from", "to"], &[])
                        .is_some_and(|fields| {
                            let from =
                                vault_path(check, fields.get("from"), &format!("{path}.from"));
                            vault_path(check, fields.get("to"), &format!("{path}.to")) & from
                        })
                },
            );
            ok &= items(
                check,
                fields.get("skipped"),
                &at("skipped"),
                report,
                &|check, entry, path| {
                    check
                        .object(entry, path, &["path", "reason"], &[])
                        .is_some_and(|fields| {
                            let file =
                                vault_path(check, fields.get("path"), &format!("{path}.path"));
                            one_of(
                                check,
                                fields.get("reason"),
                                &format!("{path}.reason"),
                                SKIP_REASONS,
                            ) & file
                        })
                },
            );
            ok &= boolean(check, fields.get("vaultCreated"), &at("vaultCreated"));
            ok.then_some(())
        }
        Op::KnowledgeNode => {
            let fields = check.object(
                result,
                RESULT,
                &["generation", "node", "bodyStatus", "bodyTruncated"],
                &["body"],
            )?;
            all(&[
                count(
                    check,
                    fields.get("generation"),
                    &at("generation"),
                    0,
                    MAX_SAFE_INTEGER,
                ),
                node(check, fields.get("node"), &at("node")),
                optional(check, fields, "body", RESULT, |check, value, path| {
                    pattern(
                        check,
                        value,
                        path,
                        |text| is_multiline(text, BODY_BYTES, false),
                        "expected text without control characters other than tab and line breaks",
                    )
                }),
                one_of(
                    check,
                    fields.get("bodyStatus"),
                    &at("bodyStatus"),
                    BODY_STATUSES,
                ),
                boolean(check, fields.get("bodyTruncated"), &at("bodyTruncated")),
            ])
        }
        Op::KnowledgeLinks | Op::KnowledgeBacklinks => link_page(check, result),
        Op::KnowledgeSearch => {
            let fields = check.object(result, RESULT, &["generation", "hits"], &[])?;
            all(&[
                count(
                    check,
                    fields.get("generation"),
                    &at("generation"),
                    0,
                    MAX_SAFE_INTEGER,
                ),
                items(
                    check,
                    fields.get("hits"),
                    &at("hits"),
                    (0, SEARCH_LIMIT as usize, false),
                    &|check, entry, path| {
                        check
                            .object(entry, path, &["nodeId", "path", "title"], &["snippet"])
                            .is_some_and(|fields| {
                                all(&[
                                    node_id(check, fields.get("nodeId"), &format!("{path}.nodeId")),
                                    vault_path(check, fields.get("path"), &format!("{path}.path")),
                                    text(
                                        check,
                                        fields.get("title"),
                                        &format!("{path}.title"),
                                        TITLE,
                                    ),
                                    optional(
                                        check,
                                        fields,
                                        "snippet",
                                        path,
                                        |check, value, path| text(check, value, path, SNIPPET),
                                    ),
                                ])
                                .is_some()
                            })
                    },
                ),
            ])
        }
        Op::KnowledgeGraph => {
            let fields = check.object(
                result,
                RESULT,
                &[
                    "generation",
                    "rootNodeId",
                    "depth",
                    "nodes",
                    "edges",
                    "truncated",
                ],
                &[],
            )?;
            all(&[
                count(
                    check,
                    fields.get("generation"),
                    &at("generation"),
                    0,
                    MAX_SAFE_INTEGER,
                ),
                node_id(check, fields.get("rootNodeId"), &at("rootNodeId")),
                count(check, fields.get("depth"), &at("depth"), 1, GRAPH_DEPTH),
                items(
                    check,
                    fields.get("nodes"),
                    &at("nodes"),
                    (1, GRAPH_NODES as usize, false),
                    &|check, entry, path| {
                        check
                            .object(entry, path, &["nodeId", "title"], &[])
                            .is_some_and(|fields| {
                                let id =
                                    node_id(check, fields.get("nodeId"), &format!("{path}.nodeId"));
                                text(check, fields.get("title"), &format!("{path}.title"), TITLE)
                                    & id
                            })
                    },
                ),
                items(
                    check,
                    fields.get("edges"),
                    &at("edges"),
                    (0, GRAPH_EDGES, false),
                    &|check, entry, path| {
                        check
                            .object(entry, path, &["source", "target", "edgeType"], &[])
                            .is_some_and(|fields| {
                                all(&[
                                    node_id(check, fields.get("source"), &format!("{path}.source")),
                                    node_id(check, fields.get("target"), &format!("{path}.target")),
                                    one_of(
                                        check,
                                        fields.get("edgeType"),
                                        &format!("{path}.edgeType"),
                                        EDGE_TYPES,
                                    ),
                                ])
                                .is_some()
                            })
                    },
                ),
                boolean(check, fields.get("truncated"), &at("truncated")),
            ])
        }
        Op::KnowledgeOverview => {
            let fields = check.object(
                result,
                RESULT,
                &[
                    "generation",
                    "totalNodes",
                    "totalEdges",
                    "truncated",
                    "nodes",
                    "edges",
                ],
                &[],
            )?;
            let mut ok = true;
            for key in ["generation", "totalNodes", "totalEdges"] {
                ok &= count(check, fields.get(key), &at(key), 0, MAX_SAFE_INTEGER);
            }
            ok &= boolean(check, fields.get("truncated"), &at("truncated"));
            ok &= items(
                check,
                fields.get("nodes"),
                &at("nodes"),
                (0, OVERVIEW_NODES as usize, false),
                &overview_node,
            );
            ok &= items(
                check,
                fields.get("edges"),
                &at("edges"),
                (0, OVERVIEW_EDGES as usize, false),
                &overview_edge,
            );
            ok.then_some(())
        }
        Op::KnowledgeRead => {
            let fields = check.object(
                result,
                RESULT,
                &["path", "sha256", "managed", "body", "truncated"],
                &[],
            )?;
            all(&[
                vault_path(check, fields.get("path"), &at("path")),
                digest(check, fields.get("sha256"), &at("sha256")),
                boolean(check, fields.get("managed"), &at("managed")),
                note_text(check, fields.get("body"), &at("body"), READ_BYTES),
                boolean(check, fields.get("truncated"), &at("truncated")),
            ])
        }
        Op::KnowledgeWrite | Op::KnowledgeRollback => {
            write_result(check, result, RESULT).then_some(())
        }
        Op::KnowledgeHistory => {
            let fields = check.object(result, RESULT, &["path", "entries"], &[])?;
            all(&[
                vault_path(check, fields.get("path"), &at("path")),
                items(
                    check,
                    fields.get("entries"),
                    &at("entries"),
                    (0, HISTORY_LIMIT as usize, false),
                    &history_entry,
                ),
            ])
        }
        Op::KnowledgeImportMemory => {
            let fields = check.object(result, RESULT, &["notes", "counts"], &["truncated"])?;
            all(&[
                items(
                    check,
                    fields.get("notes"),
                    &at("notes"),
                    (0, IMPORT_NOTES, false),
                    &imported_note,
                ),
                import_counts(check, fields.get("counts"), &at("counts")),
                optional(check, fields, "truncated", RESULT, boolean),
            ])
        }
        _ => return None,
    };
    valid.map(|()| ResponseResult::Knowledge {
        op,
        result: result.clone(),
    })
}

/// Validate a result the daemon is about to send, without a frame around it.
pub fn validate_result(op: Op, result: &Value) -> Result<(), Vec<String>> {
    let mut check = Check::default();
    match self::result(&mut check, op, result) {
        Some(_) if check.errors.is_empty() => Ok(()),
        _ => Err(check.errors),
    }
}
