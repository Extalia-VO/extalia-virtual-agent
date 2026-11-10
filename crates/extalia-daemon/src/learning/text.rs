use super::*;
use std::collections::HashSet;
pub(super) fn clean(v: &str, max: usize) -> String {
    let masked = extalia_core::knowledge::import::mask_credentials(v).0;
    let mut n = 0;
    masked
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= max
        })
        .collect()
}
fn format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{08e2}'
            | '\u{180e}'
            | '\u{feff}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{e0001}'
    ) || matches!(c as u32,0x600..=0x605|0x890..=0x891|0x200b..=0x200f|0x202a..=0x202e|0x2060..=0x2064|0x2066..=0x206f|0xfff9..=0xfffb|0x13430..=0x1343f|0x1bca0..=0x1bca3|0x1d173..=0x1d17a|0xe0020..=0xe007f)
}
pub(super) fn trim(v: &str) -> &str {
    v.trim_matches(|c:char| matches!(c as u32,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff))
}
fn plain(v: &str, multiline: bool) -> bool {
    v.chars()
        .all(|c| (!c.is_control() || multiline && "\r\n\t".contains(c)) && !format_char(c))
}
pub(super) fn proposal(v: &Value) -> Result<Value> {
    let name = s(v, "name");
    let description = s(v, "description");
    let instructions = s(v, "instructions");
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || !name.as_bytes()[0].is_ascii_lowercase() && !name.as_bytes()[0].is_ascii_digit()
    {
        return Err(refuse("invalid_skill_proposal"));
    }
    if trim(description).is_empty()
        || description.encode_utf16().count() > 500
        || !plain(description, false)
        || description.contains(['\u{2028}', '\u{2029}'])
        || trim(instructions).is_empty()
        || instructions.len() > 65536
        || !plain(instructions, true)
    {
        return Err(refuse("invalid_skill_proposal"));
    }
    let mut out =
        json!({"name":name,"description":trim(description),"instructions":trim(instructions)});
    if let Some(urls) = v.get("sourceUrls") {
        for url in urls.as_array().ok_or(refuse("invalid_source_url"))? {
            let url = url.as_str().ok_or(refuse("invalid_source_url"))?;
            let rest = url
                .strip_prefix("https://")
                .or_else(|| url.strip_prefix("http://"))
                .ok_or(refuse("invalid_source_url"))?;
            let authority = rest.split(['/', '#']).next().unwrap_or("");
            if authority.is_empty()
                || authority.contains('@')
                || url.contains(['?', '\\'])
                || !plain(url, false)
                || url.chars().any(char::is_whitespace)
                || url.len() > 2048
            {
                return Err(refuse("invalid_source_url"));
            }
        }
        out["sourceUrls"] = urls.clone();
    }
    Ok(out)
}
pub(super) fn provenance(v: &Value) -> Result<Value> {
    for k in ["sessionId", "workspaceId"] {
        let t = s(v, k);
        if t.is_empty()
            || t.len() > 160
            || !t
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(refuse("invalid_provenance"));
        }
    }
    for k in ["profileId", "runId"] {
        if v.get(k).is_some() && !id(s(v, k)) {
            return Err(refuse("invalid_provenance"));
        }
    }
    if !digest(s(v, "promptSha256")) {
        return Err(refuse("invalid_provenance"));
    }
    Ok(v.clone())
}
// JSON.stringify on the historical normalized objects uses this insertion order.
// serde_json::Value sorts keys; do not hash its serialization for legacy receipts.
pub(super) fn proposal_json(v: &Value) -> String {
    let mut out = format!(
        "{{\"name\":{},\"description\":{},\"instructions\":{}",
        v["name"], v["description"], v["instructions"]
    );
    if let Some(urls) = v.get("sourceUrls") {
        out.push_str(&format!(",\"sourceUrls\":{urls}"));
    }
    out.push('}');
    out
}
pub(super) fn content_hash(v: &Value) -> String {
    hash(format!(
        "{{\"lesson\":{},\"skill\":{}}}",
        v["lesson"],
        v.get("skill")
            .map(proposal_json)
            .unwrap_or_else(|| "null".into())
    ))
}
pub(super) fn submission(v: &Value, evidence: &[Value]) -> Result<Value> {
    let o = v.as_object().ok_or(refuse("invalid_submission"))?;
    if o.keys()
        .any(|k| !["title", "lesson", "evidenceIds", "skill", "skipReason"].contains(&k.as_str()))
    {
        return Err(refuse("invalid_submission"));
    }
    if let Some(skip) = v.get("skipReason") {
        let skip = skip.as_str().ok_or(refuse("invalid_submission"))?;
        if o.len() != 1 || trim(skip).is_empty() || skip.encode_utf16().count() > 500 {
            return Err(refuse("invalid_submission"));
        }
        return Ok(json!({"skipReason":clean(skip,500)}));
    }
    let title = s(v, "title");
    let lesson = s(v, "lesson");
    let ev = v["evidenceIds"]
        .as_array()
        .ok_or(refuse("invalid_submission"))?;
    let mut seen = HashSet::new();
    if trim(title).is_empty()
        || title.encode_utf16().count() > 200
        || title.contains(['\r', '\n'])
        || trim(lesson).is_empty()
        || lesson.encode_utf16().count() > 8000
        || ev.is_empty()
        || ev.len() > 10
        || ev
            .iter()
            .any(|id| !seen.insert(id.to_string()) || !evidence.iter().any(|e| e["id"] == *id))
    {
        return Err(refuse("invalid_submission"));
    }
    let mut out =
        json!({"title":clean(trim(title),200),"lesson":clean(trim(lesson),8000),"evidenceIds":ev});
    if let Some(raw) = v.get("skill") {
        let mut skill = proposal(raw)?;
        skill["description"] = clean(s(&skill, "description"), 500).into();
        skill["instructions"] = clean(s(&skill, "instructions"), 65536).into();
        out["skill"] = skill;
    }
    Ok(out)
}
pub(super) fn learning_markdown(v: &Value) -> Result<String> {
    ids(v, &["profileId", "workspaceId", "sessionId", "runId"])?;
    if !digest(s(v, "promptSha256"))
        || s(v, "title").contains(['\r', '\n'])
        || trim(s(v, "title")).is_empty()
        || trim(s(v, "lesson")).is_empty()
    {
        return Err(refuse("invalid_note"));
    }
    let mut seen = HashSet::new();
    let evidence = v["evidence"].as_array().ok_or(refuse("invalid_note"))?;
    if evidence.iter().any(|e| !seen.insert(s(e, "id"))) {
        return Err(refuse("invalid_note"));
    }
    let mut rows = vec!["---".into(), "type: generated-learning".into()];
    for (key, field) in [
        ("profile", "profileId"),
        ("policy_revision", "revision"),
        ("workspace", "workspaceId"),
        ("session", "sessionId"),
        ("run_id", "runId"),
        ("prompt_sha256", "promptSha256"),
    ] {
        rows.push(format!("{key}: {}", v[field]));
    }
    rows.extend(["---".into(),"".into(),format!("# {}",s(v,"title")),"".into(),"Generated findings from a completed source turn. Evidence is limited to successful tool results captured in that invocation; these findings are not independently verified.".into(),"".into(),"## Lesson".into(),"".into(),s(v,"lesson").into(),"".into(),"## Current-turn evidence".into(),"".into()]);
    for e in evidence {
        rows.extend([
            format!("### {} · {}", s(e, "id"), s(e, "name")),
            "".into(),
            s(e, "content").into(),
            "".into(),
        ]);
    }
    rows.extend(["## Skill candidate".into(), "".into()]);
    if let Some(skill) = v.get("skill") {
        rows.extend([format!("User-library package: {}",skill["packageId"]),format!("Revision: {}",skill["revisionId"]),format!("State: {}; inspection: {}{}.",s(skill,"state"),s(skill,"inspection"),skill.get("inspectionOutcome").map(|_|format!(" ({})",s(skill,"inspectionOutcome"))).unwrap_or_default()),"This profile is provenance only. The candidate is in the user library; no activation or profile-specific skill isolation is implied.".into()]);
    } else {
        rows.push("No skill receipt was recorded.".into());
    }
    rows.push("".into());
    Ok(clean(&rows.join("\n"), 100000))
}
pub(super) fn meeting_markdown(v: &Value, p: &Value) -> Result<String> {
    ids(v, &["meetingId"])?;
    let participants = v["participants"].as_array().ok_or(refuse("invalid_note"))?;
    let contributions = v["contributions"]
        .as_array()
        .ok_or(refuse("invalid_note"))?;
    let ids: HashSet<_> = participants.iter().map(|p| s(p, "agentId")).collect();
    if ids.len() != participants.len()
        || contributions.iter().any(|c| !ids.contains(s(c, "agentId")))
    {
        return Err(refuse("unknown_participant"));
    }
    let mut rows = vec!["---".into(), "type: meeting".into()];
    for (key, field) in [
        ("profile", "profileId"),
        ("workspace", "workspaceId"),
        ("session", "sessionId"),
    ] {
        rows.push(format!("{key}: {}", p[field]));
    }
    for (key, field) in [
        ("meeting_id", "meetingId"),
        ("outcome", "outcome"),
        ("started_at", "startedAt"),
        ("completed_at", "completedAt"),
    ] {
        rows.push(format!("{key}: {}", v[field]));
    }
    rows.extend([
        "---".into(),
        "".into(),
        format!("# {}", s(v, "topic")),
        "".into(),
        format!(
            "Room: {}",
            v["roomId"]
                .as_str()
                .unwrap_or("Automatic Office allocation")
        ),
        "".into(),
        "## Participants".into(),
        "".into(),
    ]);
    for p in participants {
        rows.push(format!(
            "- {} ({}; {})",
            s(p, "name"),
            s(p, "role"),
            s(p, "agentId")
        ));
    }
    rows.extend(["".into(), "## Discussion".into(), "".into()]);
    for round in [1, 2] {
        let items: Vec<_> = contributions
            .iter()
            .filter(|c| c["round"] == round)
            .collect();
        if items.is_empty() {
            continue;
        }
        rows.extend([format!("### Round {round}"), "".into()]);
        for c in items {
            let p = participants
                .iter()
                .find(|p| p["agentId"] == c["agentId"])
                .unwrap();
            rows.extend([
                format!("#### {}", s(p, "name")),
                "".into(),
                s(c, "text").into(),
                "".into(),
            ]);
        }
    }
    rows.extend(["## Outcome".into(),"".into(),format!("Discussion status: {}.",s(v,"outcome")),"".into(),"This note records the reported participant contributions. Final lead synthesis, decisions and subsequent work remain in the source conversation.".into(),"".into()]);
    Ok(rows.join("\n"))
}
