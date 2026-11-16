use super::*;
fn subject(check: &mut Check, value: Option<&Value>, path: &str) -> Option<()> {
    check.one_of(value, path, &["candidate", "baseline"])
}
fn case(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let f = check.object(value, path, &["id", "input"], &[])?;
    check.package_id(f.get("id"), &format!("{path}.id"))?;
    check.multiline(f.get("input"), &format!("{path}.input"), 2000, true)?;
    Some(())
}
fn reference(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let f = check.object(value, path, &["path", "content"], &[])?;
    check.skill_path(f.get("path"), &format!("{path}.path"))?;
    check.multiline(f.get("content"), &format!("{path}.content"), 16384, true)?;
    Some(())
}
fn plan_subject(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let f = check.object(
        value,
        path,
        &["subject", "instructions", "references", "cases"],
        &[],
    )?;
    subject(check, f.get("subject"), &format!("{path}.subject"))?;
    check.multiline(
        f.get("instructions"),
        &format!("{path}.instructions"),
        65536,
        true,
    )?;
    check.items(
        f.get("references"),
        &format!("{path}.references"),
        4,
        reference,
    )?;
    check.items(f.get("cases"), &format!("{path}.cases"), 6, case)?;
    Some(())
}
fn output(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let f = check.object(value, path, &["caseId", "text"], &[])?;
    check.package_id(f.get("caseId"), &format!("{path}.caseId"))?;
    check.multiline(f.get("text"), &format!("{path}.text"), 12000, true)?;
    Some(())
}
fn output_subject(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let f = check.object(value, path, &["subject", "outputs"], &[])?;
    subject(check, f.get("subject"), &format!("{path}.subject"))?;
    check.items(f.get("outputs"), &format!("{path}.outputs"), 6, output)?;
    Some(())
}
pub(super) fn request(check: &mut Check, op: Op, value: &Value) -> Option<SkillRequest> {
    if op == Op::SkillEvaluationBegin {
        let f = check.object(value, PARAMS, &["revisionId", "treeSha256"], &[])?;
        check.revision_id(f.get("revisionId"), "frame.params.revisionId")?;
        check.digest(f.get("treeSha256"), "frame.params.treeSha256")?;
    } else {
        let f = check.object(
            value,
            PARAMS,
            &["evaluationId", "subjects", "provider", "model"],
            &[],
        )?;
        check.text(f.get("evaluationId"), "frame.params.evaluationId", 128)?;
        check.text(f.get("provider"), "frame.params.provider", 128)?;
        check.text(f.get("model"), "frame.params.model", 256)?;
        check.items(
            f.get("subjects"),
            "frame.params.subjects",
            2,
            output_subject,
        )?;
    }
    Some(SkillRequest::Evaluation {
        complete: op == Op::SkillEvaluationComplete,
        input: value.clone(),
    })
}
pub(super) fn quality(check: &mut Check, value: &Value, path: &str) -> Option<()> {
    let f = check.object(
        value,
        path,
        &["complete", "missingSections", "testCount"],
        &["baseline", "evaluation"],
    )?;
    check.boolean(f.get("complete"), &format!("{path}.complete"))?;
    check.items(
        f.get("missingSections"),
        &format!("{path}.missingSections"),
        32,
        |c, v, p| c.text(Some(v), p, 128).map(|_| ()),
    )?;
    check.count(f.get("testCount"), &format!("{path}.testCount"), 0, 6)?;
    if let Some(v) = f.get("baseline") {
        let p = format!("{path}.baseline");
        let b = check.object(v, &p, &["revisionId", "treeSha256"], &[])?;
        check.revision_id(b.get("revisionId"), &format!("{p}.revisionId"))?;
        check.digest(b.get("treeSha256"), &format!("{p}.treeSha256"))?;
    }
    if let Some(v) = f.get("evaluation") {
        let p = format!("{path}.evaluation");
        let e = check.object(
            v,
            &p,
            &[
                "revisionId",
                "treeSha256",
                "status",
                "passed",
                "total",
                "evaluatedAt",
                "scope",
            ],
            &[
                "baselineRevisionId",
                "baselineTreeSha256",
                "baselinePassed",
                "issues",
            ],
        )?;
        check.revision_id(e.get("revisionId"), &format!("{p}.revisionId"))?;
        check.digest(e.get("treeSha256"), &format!("{p}.treeSha256"))?;
        check.one_of(
            e.get("status"),
            &format!("{p}.status"),
            &["passed", "failed", "insufficient-evidence", "stale"],
        )?;
        check.count(e.get("passed"), &format!("{p}.passed"), 0, 6)?;
        check.count(e.get("total"), &format!("{p}.total"), 0, 6)?;
        check.timestamp(e.get("evaluatedAt"), &format!("{p}.evaluatedAt"))?;
        check.one_of(
            e.get("scope"),
            &format!("{p}.scope"),
            &["synthetic-declarative"],
        )?;
        if let Some(v) = e.get("baselineRevisionId") {
            check.revision_id(Some(v), &format!("{p}.baselineRevisionId"))?;
        }
        if let Some(v) = e.get("baselineTreeSha256") {
            check.digest(Some(v), &format!("{p}.baselineTreeSha256"))?;
        }
        if let Some(v) = e.get("baselinePassed") {
            check.count(Some(v), &format!("{p}.baselinePassed"), 0, 6)?;
        }
        if let Some(v) = e.get("issues") {
            check.items(Some(v), &format!("{p}.issues"), 32, |c, v, p| {
                c.text(Some(v), p, 500).map(|_| ())
            })?;
        }
    }
    Some(())
}
pub(super) fn result(check: &mut Check, op: Op, value: &Value) -> Option<()> {
    if op == Op::SkillEvaluationBegin {
        let f = check.object(
            value,
            RESULT,
            &["evaluationId", "revisionId", "treeSha256", "subjects"],
            &["baselineRevisionId", "baselineTreeSha256"],
        )?;
        check.text(f.get("evaluationId"), "frame.result.evaluationId", 128)?;
        check.revision_id(f.get("revisionId"), "frame.result.revisionId")?;
        check.digest(f.get("treeSha256"), "frame.result.treeSha256")?;
        if let Some(v) = f.get("baselineRevisionId") {
            check.revision_id(Some(v), "frame.result.baselineRevisionId")?;
        }
        if let Some(v) = f.get("baselineTreeSha256") {
            check.digest(Some(v), "frame.result.baselineTreeSha256")?;
        }
        if f.get("subjects")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            check.fail("frame.result.subjects", "expected subjects");
            return None;
        }
        check.items(f.get("subjects"), "frame.result.subjects", 2, plan_subject)?;
    } else {
        let f = check.object(
            value,
            RESULT,
            &["revisionId", "state", "learnedQuality"],
            &[],
        )?;
        check.revision_id(f.get("revisionId"), "frame.result.revisionId")?;
        check.state(f.get("state"), "frame.result.state")?;
        quality(
            check,
            f.get("learnedQuality")?,
            "frame.result.learnedQuality",
        )?;
    }
    Some(())
}
