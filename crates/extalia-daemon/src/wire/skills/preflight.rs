use super::*;
use std::collections::BTreeMap;

pub(super) fn request(check: &mut Check, params: &Value) -> Option<SkillRequest> {
    let fields = check.object(params, PARAMS, &["rootRevisionId", "pins"], &[])?;
    let root_revision_id =
        check.revision_id(fields.get("rootRevisionId"), "frame.params.rootRevisionId")?;
    let Some(values) = fields
        .get("pins")
        .and_then(Value::as_object)
        .filter(|values| values.len() <= 128)
    else {
        check.fail(
            "frame.params.pins",
            "expected at most 128 exact package pins",
        );
        return None;
    };
    let mut pins = BTreeMap::new();
    for (package, revision) in values {
        if !is_package_id(package) {
            check.fail("frame.params.pins", "invalid package identity");
            return None;
        }
        pins.insert(
            package.clone(),
            check.revision_id(Some(revision), "frame.params.pins.revisionId")?,
        );
    }
    Some(SkillRequest::Preflight {
        root_revision_id,
        pins,
    })
}

pub(super) fn issue(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let fields = check.object(value, path, &["code"], &["packageId", "relatedPackageId"])?;
    check.one_of(
        fields.get("code"),
        &format!("{path}.code"),
        &[
            "bad_pin",
            "missing_pin",
            "dependency_unavailable",
            "dependency_inactive",
            "root_unavailable",
            "range_mismatch",
            "unsupported_range",
            "compatibility_unknown",
            "compatibility_mismatch",
            "conflict",
            "cycle",
            "permission_outside_ceiling",
            "bound_exceeded",
        ],
    )?;
    for key in ["packageId", "relatedPackageId"] {
        if let Some(value) = fields.get(key) {
            check.package_id(Some(value), &format!("{path}.{key}"))?;
        }
    }
    Some(())
}

fn planned(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let fields = check.object(
        value,
        path,
        &[
            "packageId",
            "version",
            "revisionId",
            "treeSha256",
            "permissionDigest",
        ],
        &[],
    )?;
    check.package_id(fields.get("packageId"), &format!("{path}.packageId"))?;
    check.text(fields.get("version"), &format!("{path}.version"), 128)?;
    check.revision_id(fields.get("revisionId"), &format!("{path}.revisionId"))?;
    check.digest(fields.get("treeSha256"), &format!("{path}.treeSha256"))?;
    check.digest(
        fields.get("permissionDigest"),
        &format!("{path}.permissionDigest"),
    )?;
    Some(())
}

pub(super) fn result(check: &mut Check, value: &Value) -> Option<()> {
    let consistent = value.get("status").and_then(Value::as_str) == Some("consistent");
    let required: &[&str] = if consistent {
        &[
            "rootRevisionId",
            "dispatchEligible",
            "status",
            "issues",
            "truncated",
            "plan",
        ]
    } else {
        &[
            "rootRevisionId",
            "dispatchEligible",
            "status",
            "issues",
            "truncated",
        ]
    };
    let fields = check.object(value, RESULT, required, &[])?;
    check.revision_id(fields.get("rootRevisionId"), "frame.result.rootRevisionId")?;
    if check.boolean(
        fields.get("dispatchEligible"),
        "frame.result.dispatchEligible",
    )? {
        check.fail("frame.result.dispatchEligible", "expected false");
        return None;
    }
    check.one_of(
        fields.get("status"),
        "frame.result.status",
        if consistent {
            &["consistent"]
        } else {
            &["blocked"]
        },
    )?;
    let truncated = check.boolean(fields.get("truncated"), "frame.result.truncated")?;
    check.items(
        fields.get("issues"),
        "frame.result.issues",
        if consistent { 0 } else { 256 },
        issue,
    )?;
    if consistent {
        if truncated {
            check.fail("frame.result.truncated", "expected false");
            return None;
        }
        check.items(fields.get("plan"), "frame.result.plan", 128, planned)?;
        if fields.get("plan")?.as_array()?.is_empty() {
            check.fail("frame.result.plan", "expected nonempty plan");
            return None;
        }
    } else if fields.get("issues")?.as_array()?.is_empty() {
        check.fail("frame.result.issues", "expected at least one issue");
        return None;
    }
    Some(())
}
