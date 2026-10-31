//! Bounded presentation projection of the core's read-only diagnostic snapshot.
use super::*;
use extalia_core::skills::registry::RegistryPreflightRequest;
use extalia_core::skills::resolver::{PreflightIssue as Issue, ResolverLimits};
use std::collections::BTreeMap;

pub(super) fn run(
    skills: &Skills,
    store: &mut CoreStore,
    root: &str,
    pins: &BTreeMap<String, String>,
    ctx: &PolicyContext,
    now: i64,
) -> Result<Value, SkillError> {
    let request = RegistryPreflightRequest {
        root_revision_id: root.to_owned(),
        pins: pins.clone(),
        runtime_facts: BTreeMap::new(),
        permissions_ceiling: Permissions::default(),
        limits: ResolverLimits::default(),
    };
    let report = skills
        .registry(store)
        .dependency_preflight(&request, ctx, now)?;
    let value = if let Some(plan) = report.plan {
        json!({"rootRevisionId":root,"dispatchEligible":false,"status":"consistent","issues":[],"truncated":false,
            "plan":plan.into_iter().map(|p| json!({"packageId":p.package_id,"version":p.version,"revisionId":p.revision_id,
                "treeSha256":p.tree_sha256,"permissionDigest":p.permissions_digest})).collect::<Vec<_>>()})
    } else {
        let truncated = report.issues.len() > 256;
        json!({"rootRevisionId":root,"dispatchEligible":false,"status":"blocked","truncated":truncated,
            "issues":report.issues.iter().take(256).map(issue).collect::<Vec<_>>()})
    };
    if serde_json::to_vec(&value)
        .map_err(|_| SkillError::Denied("preflight_output_bound"))?
        .len()
        > 256 * 1024
    {
        return Err(SkillError::Denied("preflight_output_bound"));
    }
    Ok(value)
}

fn issue(issue: &Issue) -> Value {
    let (code, package, related) = match issue {
        Issue::BadPin { package_id, .. } => ("bad_pin", package_id.as_deref(), None),
        Issue::MissingPin {
            package_id,
            dependency_id,
        } => (
            "missing_pin",
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        Issue::DependencyUnavailable {
            package_id,
            dependency_id,
        } => (
            "dependency_unavailable",
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        Issue::DependencyInactive {
            package_id,
            dependency_id,
        } => (
            "dependency_inactive",
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        Issue::RootUnavailable { package_id } => {
            ("root_unavailable", Some(package_id.as_str()), None)
        }
        Issue::RangeMismatch {
            package_id,
            dependency_id,
        } => (
            "range_mismatch",
            Some(package_id.as_str()),
            Some(dependency_id.as_str()),
        ),
        Issue::UnsupportedRange { package_id, .. } => {
            ("unsupported_range", Some(package_id.as_str()), None)
        }
        Issue::CompatibilityUnknown { package_id, .. } => {
            ("compatibility_unknown", Some(package_id.as_str()), None)
        }
        Issue::CompatibilityMismatch { package_id, .. } => {
            ("compatibility_mismatch", Some(package_id.as_str()), None)
        }
        Issue::Conflict {
            package_id,
            conflicting_id,
        } => (
            "conflict",
            Some(package_id.as_str()),
            Some(conflicting_id.as_str()),
        ),
        Issue::Cycle { packages } => ("cycle", packages.first().map(String::as_str), None),
        Issue::PermissionOutsideCeiling { package_id, .. } => (
            "permission_outside_ceiling",
            Some(package_id.as_str()),
            None,
        ),
        Issue::BoundExceeded { .. } => ("bound_exceeded", None, None),
    };
    let mut value = json!({"code":code});
    if let Some(package) = package {
        value["packageId"] = json!(package);
    }
    if let Some(related) = related {
        value["relatedPackageId"] = json!(related);
    }
    value
}
