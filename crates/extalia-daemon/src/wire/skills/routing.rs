//! Strict bounded diagnostic contract; these values can never authorize execution.
use super::*;
use extalia_core::skills::manifest::{is_category_id, is_intent};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_BYTES: usize = 512 * 1024;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingInput {
    pub categories: Vec<String>,
    pub intents: Vec<String>,
    pub candidate_revision_ids: Vec<String>,
    pub pins: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub max_results: usize,
}
impl RoutingInput {
    fn valid(&self) -> bool {
        let unique = |values: &[String], max| {
            values.len() <= max && values.iter().collect::<BTreeSet<_>>().len() == values.len()
        };
        (!self.categories.is_empty() || !self.intents.is_empty())
            && unique(&self.categories, 32)
            && self.categories.iter().all(|s| is_category_id(s))
            && unique(&self.intents, 32)
            && self.intents.iter().all(|s| is_intent(s))
            && unique(&self.candidate_revision_ids, 16)
            && self.candidate_revision_ids.iter().all(|s| revision_ok(s))
            && self.pins.len() <= 128
            && self
                .pins
                .iter()
                .all(|(p, r)| is_package_id(p) && revision_ok(r))
            && self.workspace_id.as_deref().is_none_or(is_workspace_id)
            && (1..=16).contains(&self.max_results)
    }
}
fn revision_ok(s: &str) -> bool {
    s.strip_prefix("skr_").is_some_and(hash_ok)
}
fn hash_ok(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn request(check: &mut Check, value: &Value) -> Option<SkillRequest> {
    let parsed = serde_json::from_value::<RoutingInput>(value.clone())
        .ok()
        .filter(|p| p.valid() && !value.get("workspaceId").is_some_and(Value::is_null));
    if let Some(input) = parsed {
        Some(SkillRequest::RoutingPreview { input })
    } else {
        check.fail(PARAMS, "invalid routing preview input");
        None
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    package_id: String,
    version: String,
    revision_id: String,
    tree_sha256: String,
    permission_digest: String,
}
impl Identity {
    fn valid(&self) -> bool {
        is_package_id(&self.package_id)
            && extalia_core::skills::manifest::is_semver(&self.version)
            && self.revision_id == format!("skr_{}", self.tree_sha256)
            && hash_ok(&self.tree_sha256)
            && hash_ok(&self.permission_digest)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Score {
    exact_intents: usize,
    exact_categories: usize,
    descendant_categories: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pair {
    requested: String,
    declared: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Matches {
    exact_intents: Vec<String>,
    exact_categories: Vec<String>,
    descendant_categories: Vec<Pair>,
    rationale_truncated: bool,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    identity: Identity,
    score: Score,
    matches: Matches,
    plan: Vec<Identity>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exclusion {
    identity: Identity,
    reason: String,
    diagnostics: Vec<Value>,
    omitted_diagnostics: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    input: RoutingInput,
    dispatch_eligible: bool,
    status: String,
    candidates: Vec<Candidate>,
    exclusions: Vec<Exclusion>,
    issues: Vec<String>,
    eligible_count: usize,
    top_tie_count: usize,
}
const ISSUES: &[&str] = &[
    "empty_selectors",
    "selector_limit",
    "invalid_category",
    "invalid_intent",
    "invalid_result_limit",
    "candidate_limit",
    "context_limit",
    "graph_node_limit",
    "graph_edge_limit",
    "metadata_limit",
    "invalid_claim",
    "invalid_context",
    "duplicate_candidate_package",
    "runtime_fact_limit",
    "permission_ceiling_limit",
];
impl Report {
    fn valid(&self, check: &mut Check) -> bool {
        let r = self;
        if !r.input.valid()
            || r.dispatch_eligible
            || r.candidates.len() > 16
            || r.exclusions.len() > 16
            || r.eligible_count > 16
            || r.top_tie_count > 16
            || r.issues.len() > ISSUES.len()
            || r.issues.iter().any(|s| !ISSUES.contains(&s.as_str()))
            || r.issues.iter().collect::<BTreeSet<_>>().len() != r.issues.len()
        {
            return false;
        }
        if r.status == "invalid" {
            return !r.issues.is_empty()
                && r.candidates.is_empty()
                && r.exclusions.is_empty()
                && r.eligible_count == 0
                && r.top_tie_count == 0;
        }
        if !r.issues.is_empty()
            || r.eligible_count + r.exclusions.len() != r.input.candidate_revision_ids.len()
            || r.candidates.len() != r.eligible_count.min(r.input.max_results)
            || r.top_tie_count > r.eligible_count
            || (r.eligible_count > 0) != (r.top_tie_count > 0)
            || r.status
                != match r.top_tie_count {
                    0 => "no_safe_skill",
                    1 => "matched",
                    _ => "ambiguous",
                }
        {
            return false;
        }
        let mut packages = BTreeSet::new();
        let mut revisions = BTreeSet::new();
        let mut identities = BTreeMap::new();
        for identity in r
            .candidates
            .iter()
            .map(|candidate| &candidate.identity)
            .chain(r.exclusions.iter().map(|exclusion| &exclusion.identity))
            .chain(r.candidates.iter().flat_map(|candidate| &candidate.plan))
        {
            if let Some(previous) = identities.insert(&identity.revision_id, identity)
                && previous != identity
            {
                return false;
            }
        }
        for i in r
            .candidates
            .iter()
            .map(|c| &c.identity)
            .chain(r.exclusions.iter().map(|e| &e.identity))
        {
            if !i.valid()
                || !r.input.candidate_revision_ids.contains(&i.revision_id)
                || !packages.insert(&i.package_id)
                || !revisions.insert(&i.revision_id)
            {
                return false;
            }
        }
        let mut diagnostics = 0;
        for e in &r.exclusions {
            diagnostics += e.diagnostics.len();
            if ![
                "selector_mismatch",
                "root_inactive",
                "root_unavailable",
                "inconsistent_preflight",
            ]
            .contains(&e.reason.as_str())
                || e.diagnostics.len() > 32
                || e.omitted_diagnostics > MAX_SAFE_INTEGER
            {
                return false;
            }
            for d in &e.diagnostics {
                if preflight::issue(check, d, "frame.result.exclusions.diagnostics").is_none() {
                    return false;
                }
            }
        }
        if diagnostics > 128 {
            return false;
        }
        for c in &r.candidates {
            let m = &c.matches;
            let s = &c.score;
            let unique =
                |values: &[String]| values.iter().collect::<BTreeSet<_>>().len() == values.len();
            if s.exact_intents > 32
                || s.exact_categories > 32
                || s.descendant_categories > 32
                || m.exact_intents.len() > 32
                || m.exact_categories.len() > 32
                || m.descendant_categories.len() > 32
                || !unique(&m.exact_intents)
                || !unique(&m.exact_categories)
                || s.exact_intents != m.exact_intents.len()
                || s.exact_categories != m.exact_categories.len()
                || m.exact_intents.iter().any(|i| !r.input.intents.contains(i))
                || m.exact_categories
                    .iter()
                    .any(|i| !r.input.categories.contains(i))
                || (!r.input.intents.is_empty() && s.exact_intents == 0)
                || (!r.input.categories.is_empty()
                    && s.exact_categories == 0
                    && s.descendant_categories == 0)
            {
                return false;
            }
            let mut pairs = BTreeSet::new();
            let mut selectors = BTreeSet::new();
            for p in &m.descendant_categories {
                if !is_category_id(&p.declared)
                    || !r.input.categories.contains(&p.requested)
                    || !p.declared.starts_with(&format!("{}.", p.requested))
                    || !pairs.insert((&p.requested, &p.declared))
                {
                    return false;
                }
                selectors.insert(&p.requested);
            }
            if s.descendant_categories > r.input.categories.len()
                || (if m.rationale_truncated {
                    m.descendant_categories.len() != 32 || s.descendant_categories < selectors.len()
                } else {
                    s.descendant_categories != selectors.len()
                })
            {
                return false;
            }
            if c.plan.is_empty() || c.plan.len() > 128 || c.plan.last() != Some(&c.identity) {
                return false;
            }
            let mut planned = BTreeSet::new();
            for p in &c.plan {
                if !p.valid()
                    || !planned.insert(&p.package_id)
                    || (p.package_id != c.identity.package_id
                        && r.input.pins.get(&p.package_id) != Some(&p.revision_id))
                {
                    return false;
                }
            }
        }
        if r.candidates.windows(2).any(|p| {
            p[0].score < p[1].score
                || (p[0].score == p[1].score
                    && (&p[0].identity.package_id, &p[0].identity.revision_id)
                        > (&p[1].identity.package_id, &p[1].identity.revision_id))
        }) {
            return false;
        }
        if let Some(top) = r.candidates.first()
            && r.candidates.iter().filter(|c| c.score == top.score).count()
                != r.top_tie_count.min(r.candidates.len())
        {
            return false;
        }
        true
    }
}
pub(super) fn result(check: &mut Check, value: &Value) -> Option<()> {
    let bounded = serde_json::to_vec(value)
        .ok()
        .is_some_and(|b| b.len() <= MAX_BYTES);
    let parsed = serde_json::from_value::<Report>(value.clone()).ok();
    if bounded
        && !value
            .get("input")
            .and_then(|v| v.get("workspaceId"))
            .is_some_and(Value::is_null)
        && parsed.is_some_and(|r| r.valid(check))
    {
        Some(())
    } else {
        check.fail(RESULT, "invalid routing preview diagnostics");
        None
    }
}
