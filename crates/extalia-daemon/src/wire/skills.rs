//! Wire mapping of the skill registry operations (`daemonSkills.ts`,
//! `daemonSkillRules.ts`). Requests are parsed into [`SkillRequest`]; results, which only
//! the daemon produces, are validated field by field with the same rules and kept as the
//! validated JSON ([`ResponseResult::Skill`]). The shared fixtures keep both sides equal.

use extalia_core::skills::{Origin, RevisionState, is_workspace_id};
use extalia_core::time::parse_utc;
use serde_json::{Map, Value};

use super::{Check, MAX_SAFE_INTEGER, Op, RequestParams, ResponseResult, is_js_space};

const PARAMS: &str = "frame.params";
const RESULT: &str = "frame.result";

mod preflight;
mod routing;
pub use routing::RoutingInput;

/// `DAEMON_SKILL_LIST_MAX_LIMIT`.
pub const LIST_MAX_LIMIT: u64 = 100;
/// `DAEMON_SKILL_READ_MAX_BYTES`.
pub const READ_MAX_BYTES: u64 = 256 * 1024;
const MAX_PERMISSIONS: usize = 4 * 64 + 1;
const MAX_FILES: usize = 256;
const MAX_INSPECTIONS: usize = 20;
const MAX_APPROVALS: usize = 20;
const MAX_HISTORY: usize = 50;
const MAX_CONSENT: usize = 8;
const MAX_SOURCE_REF: usize = 512;
const MAX_MANIFEST: usize = 64 * 1024;
const MAX_NOTE: usize = 2_000;
const MAX_PATH: usize = 512;

const ORIGINS: &[&str] = &["builtin", "user", "workspace", "imported", "generated"];
const RISK_CLASSES: &[&str] = &["declarative", "tool_using", "executable"];
const CAPABILITIES: &[&str] = &[
    "filesystem_read",
    "filesystem_write",
    "network",
    "terminal",
    "secrets",
];
const OUTCOMES: &[&str] = &[
    "completed",
    "scanner-unavailable",
    "incomplete",
    "timeout",
    "error",
    "invalid-output",
    "integrity",
];
const COVERAGES: &[&str] = &["complete", "partial", "none"];
const VERDICTS: &[&str] = &["none", "low", "medium", "high", "critical"];
const SCANNER_STATUSES: &[&str] = &["unpinned", "ready", "unavailable"];

/// `skill.review` decision.
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

/// Parameters of one skill operation.
#[derive(Debug, Clone, PartialEq)]
pub enum SkillRequest {
    RoutingPreview {
        input: RoutingInput,
    },
    Preflight {
        root_revision_id: String,
        pins: std::collections::BTreeMap<String, String>,
    },
    Import {
        origin: Origin,
        /// Relative to the profile's import inbox.
        path: String,
        source_ref: Option<String>,
    },
    List {
        /// `<packageId>/<revisionId>` of the previous page's last entry.
        cursor: Option<String>,
        limit: Option<u64>,
        package_id: Option<String>,
    },
    Inspect {
        revision_id: String,
        workspace_id: Option<String>,
    },
    Review {
        revision_id: String,
        tree_sha256: String,
        principal: String,
        decision: ReviewDecision,
        note: Option<String>,
    },
    Approve {
        revision_id: String,
        tree_sha256: String,
        permission_digest: String,
        principal: String,
        workspace_id: Option<String>,
        expires_at: Option<String>,
    },
    Activate {
        revision_id: String,
        approval_id: u64,
    },
    Deactivate {
        package_id: String,
    },
    Rollback {
        package_id: String,
        revision_id: String,
    },
    Revoke {
        revision_id: String,
    },
    Read {
        revision_id: String,
        path: String,
    },
    /// The installed inspector (`skill.scanner`); no parameters.
    Scanner,
}

impl SkillRequest {
    pub fn op(&self) -> Op {
        match self {
            Self::RoutingPreview { .. } => Op::SkillRoutingPreview,
            Self::Preflight { .. } => Op::SkillPreflight,
            Self::Import { .. } => Op::SkillImport,
            Self::List { .. } => Op::SkillList,
            Self::Inspect { .. } => Op::SkillInspect,
            Self::Review { .. } => Op::SkillReview,
            Self::Approve { .. } => Op::SkillApprove,
            Self::Activate { .. } => Op::SkillActivate,
            Self::Deactivate { .. } => Op::SkillDeactivate,
            Self::Rollback { .. } => Op::SkillRollback,
            Self::Revoke { .. } => Op::SkillRevoke,
            Self::Read { .. } => Op::SkillRead,
            Self::Scanner => Op::SkillScanner,
        }
    }

    pub(super) fn to_value(&self) -> Value {
        let mut fields = Map::new();
        let mut put = |key: &str, value: Value| {
            fields.insert(key.to_owned(), value);
        };
        let text = |value: &str| Value::from(value);
        match self {
            Self::RoutingPreview { input } => {
                return serde_json::to_value(input).expect("routing input serializes");
            }
            Self::Preflight {
                root_revision_id,
                pins,
            } => {
                put("rootRevisionId", text(root_revision_id));
                put("pins", serde_json::json!(pins));
            }
            Self::Import {
                origin,
                path,
                source_ref,
            } => {
                put("origin", text(origin.as_str()));
                put("path", text(path));
                if let Some(source_ref) = source_ref {
                    put("sourceRef", text(source_ref));
                }
            }
            Self::List {
                cursor,
                limit,
                package_id,
            } => {
                if let Some(cursor) = cursor {
                    put("cursor", text(cursor));
                }
                if let Some(limit) = limit {
                    put("limit", (*limit).into());
                }
                if let Some(package_id) = package_id {
                    put("packageId", text(package_id));
                }
            }
            Self::Inspect {
                revision_id,
                workspace_id,
            } => {
                put("revisionId", text(revision_id));
                if let Some(workspace_id) = workspace_id {
                    put("workspaceId", text(workspace_id));
                }
            }
            Self::Review {
                revision_id,
                tree_sha256,
                principal,
                decision,
                note,
            } => {
                put("revisionId", text(revision_id));
                put("treeSha256", text(tree_sha256));
                put("principal", text(principal));
                put("decision", text(decision.as_str()));
                if let Some(note) = note {
                    put("note", text(note));
                }
            }
            Self::Approve {
                revision_id,
                tree_sha256,
                permission_digest,
                principal,
                workspace_id,
                expires_at,
            } => {
                put("revisionId", text(revision_id));
                put("treeSha256", text(tree_sha256));
                put("permissionDigest", text(permission_digest));
                put("principal", text(principal));
                if let Some(workspace_id) = workspace_id {
                    put("workspaceId", text(workspace_id));
                }
                if let Some(expires_at) = expires_at {
                    put("expiresAt", text(expires_at));
                }
            }
            Self::Activate {
                revision_id,
                approval_id,
            } => {
                put("revisionId", text(revision_id));
                put("approvalId", (*approval_id).into());
            }
            Self::Deactivate { package_id } => put("packageId", text(package_id)),
            Self::Rollback {
                package_id,
                revision_id,
            } => {
                put("packageId", text(package_id));
                put("revisionId", text(revision_id));
            }
            Self::Revoke { revision_id } => put("revisionId", text(revision_id)),
            Self::Read { revision_id, path } => {
                put("revisionId", text(revision_id));
                put("path", text(path));
            }
            Self::Scanner => {}
        }
        Value::Object(fields)
    }
}

// ---- patterns (`daemonSkills.ts`) ----

/// `SKILL_PACKAGE_ID_PATTERN`.
pub fn is_package_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Lowercase hexadecimal SHA-256 (`Sha256Digest`).
pub fn is_digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `SKILL_REVISION_ID_PATTERN`.
pub fn is_revision_id(text: &str) -> bool {
    text.strip_prefix("skr_").is_some_and(is_digest)
}

/// `SKILL_PATH_PATTERN` with at most 512 characters.
pub fn is_skill_path(text: &str) -> bool {
    text.len() <= MAX_PATH
        && text.split('/').all(|segment| {
            let bytes = segment.as_bytes();
            (1..=128).contains(&bytes.len())
                && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
                && bytes[1..]
                    .iter()
                    .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

/// `SKILL_USER_PRINCIPAL_PATTERN`: the local user principal `user:<id>`.
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

/// `SKILL_REASON_PATTERN`.
pub fn is_reason(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|&byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

/// `SKILL_LIST_CURSOR_PATTERN`.
pub fn is_cursor(text: &str) -> bool {
    text.split_once('/')
        .is_some_and(|(package, revision)| is_package_id(package) && is_revision_id(revision))
}

/// Text that may span lines: tab, LF and CR are the only control characters allowed.
pub(super) fn is_multiline(text: &str, max: usize, nonblank: bool) -> bool {
    text.encode_utf16().count() <= max
        && (!nonblank || text.chars().any(|character| !is_js_space(character)))
        && text.chars().all(|character| {
            matches!(character, '\t' | '\n' | '\r')
                || (character as u32 >= 32 && character as u32 != 127)
        })
}

// ---- field rules ----

impl Check {
    fn pattern(
        &mut self,
        value: Option<&Value>,
        path: &str,
        accepts: fn(&str) -> bool,
        message: &str,
    ) -> Option<String> {
        let value = value?;
        match value.as_str() {
            Some(text) if accepts(text) => Some(text.to_owned()),
            _ => {
                self.fail(path, message);
                None
            }
        }
    }

    fn digest(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(
            value,
            path,
            is_digest,
            "expected a lowercase SHA-256 digest",
        )
    }

    fn revision_id(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(value, path, is_revision_id, "expected a skill revision id")
    }

    fn package_id(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(value, path, is_package_id, "expected a skill package id")
    }

    fn skill_path(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(
            value,
            path,
            is_skill_path,
            "expected a package-relative path",
        )
    }

    fn principal(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(
            value,
            path,
            is_user_principal,
            "expected the local user principal",
        )
    }

    fn reason(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(value, path, is_reason, "expected a reason code")
    }

    fn timestamp(&mut self, value: Option<&Value>, path: &str) -> Option<String> {
        self.pattern(
            value,
            path,
            |text| parse_utc(text).is_some(),
            "expected a real UTC timestamp",
        )
    }

    fn multiline(
        &mut self,
        value: Option<&Value>,
        path: &str,
        max: usize,
        nonblank: bool,
    ) -> Option<String> {
        let value = value?;
        match value.as_str() {
            Some(text) if is_multiline(text, max, nonblank) => Some(text.to_owned()),
            _ => {
                self.fail(path, &format!("expected text of at most {max} characters"));
                None
            }
        }
    }

    fn boolean(&mut self, value: Option<&Value>, path: &str) -> Option<bool> {
        let value = value?;
        let flag = value.as_bool();
        if flag.is_none() {
            self.fail(path, "expected a boolean");
        }
        flag
    }

    fn one_of(&mut self, value: Option<&Value>, path: &str, all: &[&str]) -> Option<()> {
        let value = value?;
        if value.as_str().is_some_and(|text| all.contains(&text)) {
            Some(())
        } else {
            self.fail(path, &format!("expected one of {}", all.join(", ")));
            None
        }
    }

    fn state(&mut self, value: Option<&Value>, path: &str) -> Option<RevisionState> {
        self.name(value, path, RevisionState::parse)
    }

    /// `SkillWorkspaceId`: a host workspace id or a lowercase UUID.
    fn workspace_opt(&mut self, value: Option<&Value>, path: &str) -> Option<Option<String>> {
        match value {
            None => Some(None),
            Some(value) => self
                .pattern(
                    Some(value),
                    path,
                    is_workspace_id,
                    "expected a workspace id (w_… or a lowercase UUID)",
                )
                .map(Some),
        }
    }

    fn count(&mut self, value: Option<&Value>, path: &str, min: u64, max: u64) -> Option<u64> {
        value.and_then(|value| self.integer(value, path, min, max))
    }

    /// An array of at most `max` items, each checked by `item`.
    fn items(
        &mut self,
        value: Option<&Value>,
        path: &str,
        max: usize,
        item: fn(&mut Check, &Value, &str) -> Option<()>,
    ) -> Option<()> {
        let value = value?;
        let Some(items) = value.as_array().filter(|items| items.len() <= max) else {
            self.fail(path, &format!("expected an array with 0 to {max} items"));
            return None;
        };
        let mut ok = true;
        for (index, value) in items.iter().enumerate() {
            ok &= item(self, value, &format!("{path}[{index}]")).is_some();
        }
        ok.then_some(())
    }
}

/// `Some(())` when every listed check passed (each one reports its own failure).
fn all(results: &[bool]) -> Option<()> {
    results.iter().all(|ok| *ok).then_some(())
}

// ---- requests ----

pub(super) fn request(check: &mut Check, op: Op, params: &Value) -> Option<RequestParams> {
    let at = |key: &str| format!("{PARAMS}.{key}");
    let request = match op {
        Op::SkillImport => {
            let fields = check.object(params, PARAMS, &["origin", "path"], &["sourceRef"])?;
            let origin = check.name(fields.get("origin"), &at("origin"), Origin::parse);
            let path = check.skill_path(fields.get("path"), &at("path"));
            let source_ref = match fields.get("sourceRef") {
                None => Some(None),
                Some(value) => check
                    .text(Some(value), &at("sourceRef"), MAX_SOURCE_REF)
                    .map(Some),
            };
            SkillRequest::Import {
                origin: origin?,
                path: path?,
                source_ref: source_ref?,
            }
        }
        Op::SkillList => {
            let fields = check.object(params, PARAMS, &[], &["cursor", "limit", "packageId"])?;
            let cursor = match fields.get("cursor") {
                None => Some(None),
                Some(value) => check
                    .pattern(Some(value), &at("cursor"), is_cursor, "expected a cursor")
                    .map(Some),
            };
            let limit = match fields.get("limit") {
                None => Some(None),
                Some(value) => check
                    .integer(value, &at("limit"), 1, LIST_MAX_LIMIT)
                    .map(Some),
            };
            let package_id = match fields.get("packageId") {
                None => Some(None),
                Some(value) => check.package_id(Some(value), &at("packageId")).map(Some),
            };
            SkillRequest::List {
                cursor: cursor?,
                limit: limit?,
                package_id: package_id?,
            }
        }
        Op::SkillInspect => {
            let fields = check.object(params, PARAMS, &["revisionId"], &["workspaceId"])?;
            let revision_id = check.revision_id(fields.get("revisionId"), &at("revisionId"));
            let workspace_id = check.workspace_opt(fields.get("workspaceId"), &at("workspaceId"));
            SkillRequest::Inspect {
                revision_id: revision_id?,
                workspace_id: workspace_id?,
            }
        }
        Op::SkillReview => {
            let fields = check.object(
                params,
                PARAMS,
                &["revisionId", "treeSha256", "principal", "decision"],
                &["note"],
            )?;
            let revision_id = check.revision_id(fields.get("revisionId"), &at("revisionId"));
            let tree_sha256 = check.digest(fields.get("treeSha256"), &at("treeSha256"));
            let principal = check.principal(fields.get("principal"), &at("principal"));
            let decision = check.name(
                fields.get("decision"),
                &at("decision"),
                ReviewDecision::parse,
            );
            let note = match fields.get("note") {
                None => Some(None),
                Some(value) => check
                    .multiline(Some(value), &at("note"), MAX_NOTE, true)
                    .map(Some),
            };
            SkillRequest::Review {
                revision_id: revision_id?,
                tree_sha256: tree_sha256?,
                principal: principal?,
                decision: decision?,
                note: note?,
            }
        }
        Op::SkillApprove => {
            let fields = check.object(
                params,
                PARAMS,
                &["revisionId", "treeSha256", "permissionDigest", "principal"],
                &["workspaceId", "expiresAt"],
            )?;
            let revision_id = check.revision_id(fields.get("revisionId"), &at("revisionId"));
            let tree_sha256 = check.digest(fields.get("treeSha256"), &at("treeSha256"));
            let permission_digest =
                check.digest(fields.get("permissionDigest"), &at("permissionDigest"));
            let principal = check.principal(fields.get("principal"), &at("principal"));
            let workspace_id = check.workspace_opt(fields.get("workspaceId"), &at("workspaceId"));
            let expires_at = match fields.get("expiresAt") {
                None => Some(None),
                Some(value) => check.timestamp(Some(value), &at("expiresAt")).map(Some),
            };
            SkillRequest::Approve {
                revision_id: revision_id?,
                tree_sha256: tree_sha256?,
                permission_digest: permission_digest?,
                principal: principal?,
                workspace_id: workspace_id?,
                expires_at: expires_at?,
            }
        }
        Op::SkillActivate => {
            let fields = check.object(params, PARAMS, &["revisionId", "approvalId"], &[])?;
            let revision_id = check.revision_id(fields.get("revisionId"), &at("revisionId"));
            let approval_id = check.count(
                fields.get("approvalId"),
                &at("approvalId"),
                1,
                MAX_SAFE_INTEGER,
            );
            SkillRequest::Activate {
                revision_id: revision_id?,
                approval_id: approval_id?,
            }
        }
        Op::SkillDeactivate => {
            let fields = check.object(params, PARAMS, &["packageId"], &[])?;
            SkillRequest::Deactivate {
                package_id: check.package_id(fields.get("packageId"), &at("packageId"))?,
            }
        }
        Op::SkillRollback => {
            let fields = check.object(params, PARAMS, &["packageId", "revisionId"], &[])?;
            let package_id = check.package_id(fields.get("packageId"), &at("packageId"));
            let revision_id = check.revision_id(fields.get("revisionId"), &at("revisionId"));
            SkillRequest::Rollback {
                package_id: package_id?,
                revision_id: revision_id?,
            }
        }
        Op::SkillRevoke => {
            let fields = check.object(params, PARAMS, &["revisionId"], &[])?;
            SkillRequest::Revoke {
                revision_id: check.revision_id(fields.get("revisionId"), &at("revisionId"))?,
            }
        }
        Op::SkillRoutingPreview => routing::request(check, params)?,
        Op::SkillPreflight => preflight::request(check, params)?,
        Op::SkillScanner => {
            check.object(params, PARAMS, &[], &[])?;
            SkillRequest::Scanner
        }
        Op::SkillRead => {
            let fields = check.object(params, PARAMS, &["revisionId", "path"], &[])?;
            let revision_id = check.revision_id(fields.get("revisionId"), &at("revisionId"));
            let path = check.skill_path(fields.get("path"), &at("path"));
            SkillRequest::Read {
                revision_id: revision_id?,
                path: path?,
            }
        }
        _ => return None,
    };
    Some(RequestParams::Skill(request))
}

// ---- results ----

fn summary(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(
        value,
        path,
        &[
            "packageId",
            "revisionId",
            "origin",
            "version",
            "treeSha256",
            "skillMdSha256",
            "state",
            "riskClass",
            "manifestInferred",
            "permissionDigest",
            "permissions",
            "active",
            "createdAt",
            "updatedAt",
        ],
        &["stateReason"],
    )?;
    let reason = match fields.get("stateReason") {
        None => true,
        Some(value) => check.reason(Some(value), &at("stateReason")).is_some(),
    };
    all(&[
        check
            .package_id(fields.get("packageId"), &at("packageId"))
            .is_some(),
        check
            .revision_id(fields.get("revisionId"), &at("revisionId"))
            .is_some(),
        check
            .one_of(fields.get("origin"), &at("origin"), ORIGINS)
            .is_some(),
        check
            .text(fields.get("version"), &at("version"), 128)
            .is_some(),
        check
            .digest(fields.get("treeSha256"), &at("treeSha256"))
            .is_some(),
        check
            .digest(fields.get("skillMdSha256"), &at("skillMdSha256"))
            .is_some(),
        check.state(fields.get("state"), &at("state")).is_some(),
        reason,
        check
            .one_of(fields.get("riskClass"), &at("riskClass"), RISK_CLASSES)
            .is_some(),
        check
            .boolean(fields.get("manifestInferred"), &at("manifestInferred"))
            .is_some(),
        check
            .digest(fields.get("permissionDigest"), &at("permissionDigest"))
            .is_some(),
        check
            .items(
                fields.get("permissions"),
                &at("permissions"),
                MAX_PERMISSIONS,
                permission,
            )
            .is_some(),
        check.boolean(fields.get("active"), &at("active")).is_some(),
        check
            .timestamp(fields.get("createdAt"), &at("createdAt"))
            .is_some(),
        check
            .timestamp(fields.get("updatedAt"), &at("updatedAt"))
            .is_some(),
    ])
}

fn permission(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let fields = check.object(value, path, &["capability", "scope"], &[])?;
    all(&[
        check
            .one_of(
                fields.get("capability"),
                &format!("{path}.capability"),
                CAPABILITIES,
            )
            .is_some(),
        check
            .text(fields.get("scope"), &format!("{path}.scope"), 256)
            .is_some(),
    ])
}

fn file(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(value, path, &["path", "size", "sha256", "executable"], &[])?;
    all(&[
        check.skill_path(fields.get("path"), &at("path")).is_some(),
        check
            .count(fields.get("size"), &at("size"), 0, MAX_SAFE_INTEGER)
            .is_some(),
        check.digest(fields.get("sha256"), &at("sha256")).is_some(),
        check
            .boolean(fields.get("executable"), &at("executable"))
            .is_some(),
    ])
}

/// Optional field: absent passes, present must satisfy `rule`.
fn optional_field(
    check: &mut Check,
    fields: &Map<String, Value>,
    key: &str,
    path: &str,
    rule: impl FnOnce(&mut Check, &Value, &str) -> bool,
) -> bool {
    match fields.get(key) {
        None => true,
        Some(value) => rule(check, value, &format!("{path}.{key}")),
    }
}

fn inspection(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(
        value,
        path,
        &[
            "inspectionId",
            "scannerId",
            "policyVersion",
            "outcome",
            "coverage",
            "startedAt",
            "finishedAt",
        ],
        &["scannerPin", "scannerVersion", "verdict"],
    )?;
    all(&[
        check
            .count(
                fields.get("inspectionId"),
                &at("inspectionId"),
                1,
                MAX_SAFE_INTEGER,
            )
            .is_some(),
        check
            .text(fields.get("scannerId"), &at("scannerId"), 128)
            .is_some(),
        optional_field(check, fields, "scannerPin", path, |check, value, path| {
            check.text(Some(value), path, 256).is_some()
        }),
        optional_field(
            check,
            fields,
            "scannerVersion",
            path,
            |check, value, path| check.text(Some(value), path, 128).is_some(),
        ),
        check
            .text(fields.get("policyVersion"), &at("policyVersion"), 128)
            .is_some(),
        check
            .one_of(fields.get("outcome"), &at("outcome"), OUTCOMES)
            .is_some(),
        check
            .one_of(fields.get("coverage"), &at("coverage"), COVERAGES)
            .is_some(),
        optional_field(check, fields, "verdict", path, |check, value, path| {
            check.one_of(Some(value), path, VERDICTS).is_some()
        }),
        check
            .timestamp(fields.get("startedAt"), &at("startedAt"))
            .is_some(),
        check
            .timestamp(fields.get("finishedAt"), &at("finishedAt"))
            .is_some(),
    ])
}

fn approval(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(
        value,
        path,
        &[
            "approvalId",
            "kind",
            "approver",
            "status",
            "permissionDigest",
            "createdAt",
            "expiresAt",
        ],
        &["workspaceId", "revokedAt"],
    )?;
    all(&[
        check
            .count(
                fields.get("approvalId"),
                &at("approvalId"),
                1,
                MAX_SAFE_INTEGER,
            )
            .is_some(),
        check
            .one_of(fields.get("kind"), &at("kind"), &["user", "auto"])
            .is_some(),
        check
            .text(fields.get("approver"), &at("approver"), 128)
            .is_some(),
        check
            .one_of(fields.get("status"), &at("status"), &["granted", "revoked"])
            .is_some(),
        check
            .workspace_opt(fields.get("workspaceId"), &at("workspaceId"))
            .is_some(),
        check
            .digest(fields.get("permissionDigest"), &at("permissionDigest"))
            .is_some(),
        check
            .timestamp(fields.get("createdAt"), &at("createdAt"))
            .is_some(),
        check
            .timestamp(fields.get("expiresAt"), &at("expiresAt"))
            .is_some(),
        optional_field(check, fields, "revokedAt", path, |check, value, path| {
            check.timestamp(Some(value), path).is_some()
        }),
    ])
}

fn state_event(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(
        value,
        path,
        &["seq", "toState", "at"],
        &["fromState", "reason"],
    )?;
    all(&[
        check
            .count(fields.get("seq"), &at("seq"), 1, MAX_SAFE_INTEGER)
            .is_some(),
        optional_field(check, fields, "fromState", path, |check, value, path| {
            check.state(Some(value), path).is_some()
        }),
        check.state(fields.get("toState"), &at("toState")).is_some(),
        optional_field(check, fields, "reason", path, |check, value, path| {
            check.reason(Some(value), path).is_some()
        }),
        check.timestamp(fields.get("at"), &at("at")).is_some(),
    ])
}

fn consent(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(
        value,
        path,
        &["path", "sha256"],
        &["allowedAt", "workspaceId"],
    )?;
    let skill_md = fields.get("path").is_none_or(|value| {
        let ok = value.as_str() == Some("SKILL.md");
        if !ok {
            check.fail(&at("path"), "expected \"SKILL.md\"");
        }
        ok
    });
    all(&[
        skill_md,
        check.digest(fields.get("sha256"), &at("sha256")).is_some(),
        optional_field(check, fields, "allowedAt", path, |check, value, path| {
            check.timestamp(Some(value), path).is_some()
        }),
        check
            .workspace_opt(fields.get("workspaceId"), &at("workspaceId"))
            .is_some(),
    ])
}

fn activation(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let at = |key: &str| format!("{path}.{key}");
    let fields = check.object(
        value,
        path,
        &[
            "packageId",
            "revisionId",
            "approvalId",
            "activatedAt",
            "indexGeneration",
        ],
        &[],
    )?;
    all(&[
        check
            .package_id(fields.get("packageId"), &at("packageId"))
            .is_some(),
        check
            .revision_id(fields.get("revisionId"), &at("revisionId"))
            .is_some(),
        check
            .count(
                fields.get("approvalId"),
                &at("approvalId"),
                1,
                MAX_SAFE_INTEGER,
            )
            .is_some(),
        check
            .timestamp(fields.get("activatedAt"), &at("activatedAt"))
            .is_some(),
        check
            .count(
                fields.get("indexGeneration"),
                &at("indexGeneration"),
                0,
                MAX_SAFE_INTEGER,
            )
            .is_some(),
    ])
}

pub(super) fn result(check: &mut Check, op: Op, result: &Value) -> Option<ResponseResult> {
    let at = |key: &str| format!("{RESULT}.{key}");
    let valid = match op {
        Op::SkillImport => {
            let fields = check.object(
                result,
                RESULT,
                &[
                    "packageId",
                    "revisionId",
                    "treeSha256",
                    "version",
                    "state",
                    "created",
                ],
                &["stateReason"],
            )?;
            all(&[
                check
                    .package_id(fields.get("packageId"), &at("packageId"))
                    .is_some(),
                check
                    .revision_id(fields.get("revisionId"), &at("revisionId"))
                    .is_some(),
                check
                    .digest(fields.get("treeSha256"), &at("treeSha256"))
                    .is_some(),
                check
                    .text(fields.get("version"), &at("version"), 128)
                    .is_some(),
                check.state(fields.get("state"), &at("state")).is_some(),
                optional_field(
                    check,
                    fields,
                    "stateReason",
                    RESULT,
                    |check, value, path| check.reason(Some(value), path).is_some(),
                ),
                check
                    .boolean(fields.get("created"), &at("created"))
                    .is_some(),
            ])
        }
        Op::SkillList => {
            let fields = check.object(
                result,
                RESULT,
                &["revisions", "indexGeneration"],
                &["nextCursor"],
            )?;
            all(&[
                check
                    .items(
                        fields.get("revisions"),
                        &at("revisions"),
                        LIST_MAX_LIMIT as usize,
                        summary,
                    )
                    .is_some(),
                optional_field(check, fields, "nextCursor", RESULT, |check, value, path| {
                    check
                        .pattern(Some(value), path, is_cursor, "expected a cursor")
                        .is_some()
                }),
                check
                    .count(
                        fields.get("indexGeneration"),
                        &at("indexGeneration"),
                        0,
                        MAX_SAFE_INTEGER,
                    )
                    .is_some(),
            ])
        }
        Op::SkillInspect => {
            let fields = check.object(
                result,
                RESULT,
                &[
                    "revision",
                    "manifest",
                    "files",
                    "inspections",
                    "approvals",
                    "history",
                    "consent",
                ],
                &[],
            )?;
            all(&[
                fields
                    .get("revision")
                    .is_none_or(|value| summary(check, value, &at("revision")).is_some()),
                check
                    .text(fields.get("manifest"), &at("manifest"), MAX_MANIFEST)
                    .is_some(),
                check
                    .items(fields.get("files"), &at("files"), MAX_FILES, file)
                    .is_some(),
                check
                    .items(
                        fields.get("inspections"),
                        &at("inspections"),
                        MAX_INSPECTIONS,
                        inspection,
                    )
                    .is_some(),
                check
                    .items(
                        fields.get("approvals"),
                        &at("approvals"),
                        MAX_APPROVALS,
                        approval,
                    )
                    .is_some(),
                check
                    .items(
                        fields.get("history"),
                        &at("history"),
                        MAX_HISTORY,
                        state_event,
                    )
                    .is_some(),
                check
                    .items(fields.get("consent"), &at("consent"), MAX_CONSENT, consent)
                    .is_some(),
            ])
        }
        Op::SkillReview => {
            let fields = check.object(
                result,
                RESULT,
                &["revisionId", "decision", "state"],
                &["stateReason", "reviewId"],
            )?;
            all(&[
                check
                    .revision_id(fields.get("revisionId"), &at("revisionId"))
                    .is_some(),
                check
                    .name(
                        fields.get("decision"),
                        &at("decision"),
                        ReviewDecision::parse,
                    )
                    .is_some(),
                check.state(fields.get("state"), &at("state")).is_some(),
                optional_field(
                    check,
                    fields,
                    "stateReason",
                    RESULT,
                    |check, value, path| check.reason(Some(value), path).is_some(),
                ),
                optional_field(check, fields, "reviewId", RESULT, |check, value, path| {
                    check
                        .count(Some(value), path, 1, MAX_SAFE_INTEGER)
                        .is_some()
                }),
            ])
        }
        Op::SkillApprove => {
            let fields = check.object(
                result,
                RESULT,
                &["approvalId", "revisionId", "state", "expiresAt"],
                &[],
            )?;
            all(&[
                check
                    .count(
                        fields.get("approvalId"),
                        &at("approvalId"),
                        1,
                        MAX_SAFE_INTEGER,
                    )
                    .is_some(),
                check
                    .revision_id(fields.get("revisionId"), &at("revisionId"))
                    .is_some(),
                check.state(fields.get("state"), &at("state")).is_some(),
                check
                    .timestamp(fields.get("expiresAt"), &at("expiresAt"))
                    .is_some(),
            ])
        }
        Op::SkillActivate | Op::SkillRollback => activation(check, result, RESULT),
        Op::SkillDeactivate => {
            let fields = check.object(
                result,
                RESULT,
                &["packageId", "revisionId", "state", "indexGeneration"],
                &[],
            )?;
            all(&[
                check
                    .package_id(fields.get("packageId"), &at("packageId"))
                    .is_some(),
                check
                    .revision_id(fields.get("revisionId"), &at("revisionId"))
                    .is_some(),
                check.state(fields.get("state"), &at("state")).is_some(),
                check
                    .count(
                        fields.get("indexGeneration"),
                        &at("indexGeneration"),
                        0,
                        MAX_SAFE_INTEGER,
                    )
                    .is_some(),
            ])
        }
        Op::SkillRevoke => {
            let fields = check.object(
                result,
                RESULT,
                &["revisionId", "state", "indexGeneration"],
                &[],
            )?;
            all(&[
                check
                    .revision_id(fields.get("revisionId"), &at("revisionId"))
                    .is_some(),
                check.state(fields.get("state"), &at("state")).is_some(),
                check
                    .count(
                        fields.get("indexGeneration"),
                        &at("indexGeneration"),
                        0,
                        MAX_SAFE_INTEGER,
                    )
                    .is_some(),
            ])
        }
        Op::SkillRead => {
            let fields = check.object(
                result,
                RESULT,
                &[
                    "revisionId",
                    "packageId",
                    "path",
                    "size",
                    "sha256",
                    "content",
                ],
                &[],
            )?;
            all(&[
                check
                    .revision_id(fields.get("revisionId"), &at("revisionId"))
                    .is_some(),
                check
                    .package_id(fields.get("packageId"), &at("packageId"))
                    .is_some(),
                check.skill_path(fields.get("path"), &at("path")).is_some(),
                check
                    .count(fields.get("size"), &at("size"), 0, READ_MAX_BYTES)
                    .is_some(),
                check.digest(fields.get("sha256"), &at("sha256")).is_some(),
                check
                    .multiline(
                        fields.get("content"),
                        &at("content"),
                        READ_MAX_BYTES as usize,
                        false,
                    )
                    .is_some(),
            ])
        }
        Op::SkillRoutingPreview => routing::result(check, result),
        Op::SkillPreflight => preflight::result(check, result),
        Op::SkillScanner => {
            let fields = check.object(
                result,
                RESULT,
                &["scannerId", "pinned", "policyVersion", "status"],
                &["pin", "version", "normalizerVersion"],
            )?;
            let text_opt = |check: &mut Check, key: &str, max: usize| {
                optional_field(check, fields, key, RESULT, |check, value, path| {
                    check.text(Some(value), path, max).is_some()
                })
            };
            all(&[
                check
                    .text(fields.get("scannerId"), &at("scannerId"), 128)
                    .is_some(),
                check.boolean(fields.get("pinned"), &at("pinned")).is_some(),
                text_opt(check, "pin", 256),
                text_opt(check, "version", 128),
                text_opt(check, "normalizerVersion", 128),
                check
                    .text(fields.get("policyVersion"), &at("policyVersion"), 128)
                    .is_some(),
                check
                    .one_of(fields.get("status"), &at("status"), SCANNER_STATUSES)
                    .is_some(),
            ])
        }
        _ => return None,
    };
    valid.map(|()| ResponseResult::Skill {
        op,
        result: result.clone(),
    })
}
