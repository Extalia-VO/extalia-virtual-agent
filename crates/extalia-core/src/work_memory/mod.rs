//! Scoped operational memory shared by Native context and learning consumers.
//! Capture and its FTS index commit together. No inference or provider credentials
//! are used here; outcomes and summaries remain attributed evidence, not truth.
use crate::skills::ProfileId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
mod storage;
pub use storage::WorkMemoryStore;
const SCHEMA: &str = include_str!("schema.sql");
const PROFILE_LIMIT: i64 = 4096;
const SCOPE_LIMIT: i64 = 1024;
const STORE_BYTES: u64 = 512 * 1024 * 1024;
const APPLICATION: i64 = 0x4558574d;
const SOURCE_KINDS: &[&str] = &["native", "observed", "knowledge", "skill"];
const ENTRY_KINDS: &[&str] = &[
    "user",
    "assistant",
    "tool",
    "file",
    "status",
    "knowledge",
    "skill",
];

#[derive(Debug)]
pub enum WorkMemoryError {
    Denied(&'static str),
    Storage,
}
impl std::fmt::Display for WorkMemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(reason) => write!(f, "Work memory unavailable: {reason}"),
            Self::Storage => f.write_str("Work memory storage unavailable"),
        }
    }
}
impl std::error::Error for WorkMemoryError {}
type Result<T> = std::result::Result<T, WorkMemoryError>;
fn denied(reason: &'static str) -> WorkMemoryError {
    WorkMemoryError::Denied(reason)
}
fn storage(_: impl std::fmt::Debug) -> WorkMemoryError {
    WorkMemoryError::Storage
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn ident(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 200
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        && crate::knowledge::import::mask_credentials(v).0 == v
}
fn digest(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hash(v: &str) -> String {
    crate::sha256::digest(v.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn clean(v: &str, max: usize) -> String {
    let masked = crate::knowledge::import::mask_credentials(v).0;
    let mut units = 0;
    masked
        .chars()
        .filter(|c| !c.is_control() || "\r\n\t".contains(*c))
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}
fn scope_key(scope: &Value, profile: &ProfileId) -> Result<String> {
    if !ident(text(scope, "profileId"))
        || text(scope, "profileId") != profile.as_str()
        || !ident(text(scope, "workspaceId"))
        || !digest(text(scope, "boundary"))
    {
        return Err(denied("invalid_scope"));
    }
    Ok(hash(
        &json!([scope["profileId"], scope["workspaceId"], scope["boundary"]]).to_string(),
    ))
}
fn source_value(source: &Value) -> Result<Value> {
    let kind = text(source, "kind");
    if !SOURCE_KINDS.contains(&kind)
        || !["sourceId", "sessionId", "episodeId"]
            .iter()
            .all(|k| ident(text(source, k)))
        || !digest(text(source, "revision"))
        || source
            .get("accessKey")
            .is_some_and(|v| !v.as_str().is_some_and(digest))
        || kind == "observed" && !digest(text(source, "accessKey"))
    {
        return Err(denied("invalid_source"));
    }
    let mut out = json!({"kind":kind,"sourceId":source["sourceId"],"sessionId":source["sessionId"],"episodeId":source["episodeId"],"revision":source["revision"]});
    if let Some(key) = source.get("accessKey") {
        out["accessKey"] = key.clone();
    }
    Ok(out)
}
fn record_id(key: &str, source: &Value) -> String {
    hash(
        &json!([
            key,
            source["kind"],
            source["sourceId"],
            source["sessionId"],
            source["episodeId"],
            source["accessKey"]
        ])
        .to_string(),
    )
}
fn record_revision(record: &Value) -> String {
    hash(
        &json!([
            record["source"],
            record["outcome"],
            record["title"],
            record["summary"],
            record["entries"],
            record["coverage"]
        ])
        .to_string(),
    )
}
fn checked_record(body: &str, key: &str, profile: &ProfileId) -> Result<Value> {
    if body.len() > 256 * 1024 {
        return Err(denied("corrupt_record"));
    }
    let record: Value = serde_json::from_str(body).map_err(storage)?;
    let entries = record["entries"]
        .as_array()
        .ok_or(denied("corrupt_record"))?;
    source_value(&record["source"])?;
    if record["trust"] != "attributed-evidence"
        || scope_key(&record["scope"], profile)? != key
        || !["completed", "failed", "cancelled"].contains(&text(&record, "outcome"))
        || text(&record, "title").is_empty()
        || clean(text(&record, "title"), 200) != text(&record, "title")
        || clean(text(&record, "summary"), 2000) != text(&record, "summary")
        || entries.is_empty()
        || entries.len() > 32
        || entries.iter().any(|e| {
            !ident(text(e, "id"))
                || !ENTRY_KINDS.contains(&text(e, "kind"))
                || clean(text(e, "text"), 2000) != text(e, "text")
        })
        || text(&record, "id") != record_id(key, &record["source"])
        || text(&record, "revision") != record_revision(&record)
    {
        return Err(denied("corrupt_record"));
    }
    Ok(record)
}
fn metadata(record: &Value) -> Value {
    let mut out = record.clone();
    out["entries"] = record["entries"].as_array().map_or(0, Vec::len).into();
    out
}
fn observed_keys(input: &Value) -> Result<Vec<String>> {
    let Some(value) = input.get("observedSourceKeys") else {
        return Ok(Vec::new());
    };
    let keys = value.as_array().ok_or(denied("invalid_sources"))?;
    if keys.len() > 32 || keys.iter().any(|v| !v.as_str().is_some_and(digest)) {
        return Err(denied("invalid_sources"));
    }
    let mut result = keys
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    Ok(result)
}
fn source_allowed(record: &Value, keys: &[String]) -> bool {
    record["source"]["kind"] != "observed"
        || keys
            .iter()
            .any(|k| k == text(&record["source"], "accessKey"))
}
fn query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.chars().count() >= 2)
        .map(|s| s.chars().take(64).collect::<String>().to_lowercase())
        .filter(|s| {
            ![
                "the", "and", "for", "with", "from", "this", "that", "dan", "yang", "untuk",
                "dari", "dengan",
            ]
            .contains(&s.as_str())
        })
        .filter(|s| seen.insert(s.clone()))
        .take(12)
        .collect()
}

impl WorkMemoryStore {
    /// Idempotent atomic persistence. A caller may safely retry the exact same
    /// capture after an ambiguous transport result; conflicting evidence is refused.
    pub fn capture(&mut self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        if input.to_string().len() > 96 * 1024 {
            return Err(denied("capture_too_large"));
        }
        let key = scope_key(&input["scope"], &self.profile)?;
        let scope = json!({"profileId":input["scope"]["profileId"],"workspaceId":input["scope"]["workspaceId"],"boundary":input["scope"]["boundary"]});
        let source = source_value(&input["source"])?;
        let outcome = text(input, "outcome");
        if !["completed", "failed", "cancelled"].contains(&outcome)
            || clean(text(input, "title"), 200).trim().is_empty()
            || text(input, "title").encode_utf16().count() > 200
            || text(input, "summary").encode_utf16().count() > 2000
        {
            return Err(denied("invalid_summary"));
        }
        let raw = input["entries"]
            .as_array()
            .ok_or(denied("invalid_entries"))?;
        if raw.is_empty() || raw.len() > 32 {
            return Err(denied("invalid_entries"));
        }
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        let mut clipped = false;
        for row in raw {
            let content = text(row, "text");
            if !ident(text(row, "id"))
                || !seen.insert(text(row, "id"))
                || !ENTRY_KINDS.contains(&text(row, "kind"))
                || !row["text"].is_string()
                || content.encode_utf16().count() > 8000
            {
                return Err(denied("invalid_entry"));
            }
            let filtered = clean(content, 2000);
            clipped |= filtered.encode_utf16().count()
                < crate::knowledge::import::mask_credentials(content)
                    .0
                    .encode_utf16()
                    .count();
            let mut entry = json!({"id":row["id"],"kind":row["kind"],"text":filtered});
            if let Some(at) = row.get("at") {
                let at = at.as_str().ok_or(denied("invalid_time"))?;
                if at.encode_utf16().count() > 80 {
                    return Err(denied("invalid_time"));
                }
                entry["at"] = clean(at, 80).into();
            }
            entries.push(entry);
        }
        let coverage = &input["coverage"];
        let limits = coverage["limits"]
            .as_array()
            .ok_or(denied("invalid_coverage"))?;
        if !["partial", "unknown"].contains(&text(coverage, "mode"))
            || coverage["omittedEntries"].as_u64().is_none()
            || !coverage["truncated"].is_boolean()
            || limits.len() > 8
            || limits
                .iter()
                .any(|v| v.as_str().is_none_or(|s| s.encode_utf16().count() > 500))
        {
            return Err(denied("invalid_coverage"));
        }
        let coverage = json!({"mode":coverage["mode"],"omittedEntries":coverage["omittedEntries"],"truncated":coverage["truncated"]==true||clipped,"limits":limits.iter().map(|s|clean(s.as_str().unwrap_or(""),500)).collect::<Vec<_>>()});
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(storage)?
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let id = record_id(&key, &source);
        let mut record = json!({"id":id,"scope":scope,"source":source,"outcome":outcome,"title":clean(text(input,"title"),200),"summary":clean(text(input,"summary"),2000),"capturedAt":crate::time::format_utc(now),"entries":entries,"trust":"attributed-evidence","coverage":coverage});
        record["revision"] = record_revision(&record).into();
        let tx = self.conn.transaction().map_err(storage)?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT revision,record_json FROM work_memory_records WHERE id=?1 AND scope_key=?2",
                params![id, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        if let Some((revision, body)) = prior {
            if revision != text(&record, "revision") {
                return Err(denied("record_conflict"));
            }
            let stored = checked_record(&body, &key, &self.profile)?;
            if text(&stored, "revision") != revision {
                return Err(denied("corrupt_record"));
            }
            return Ok(json!({"record":metadata(&stored),"created":false}));
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM work_memory_records", [], |r| r.get(0))
            .map_err(storage)?;
        let scoped: i64 = tx
            .query_row(
                "SELECT count(*) FROM work_memory_records WHERE scope_key=?1",
                [&key],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if count >= PROFILE_LIMIT || scoped >= SCOPE_LIMIT {
            return Err(denied("capacity_reached"));
        }
        tx.execute("INSERT INTO work_memory_records(id,scope_key,source_kind,source_id,source_session,source_episode,source_access,revision,captured_at,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,key,text(&source,"kind"),text(&source,"sourceId"),text(&source,"sessionId"),text(&source,"episodeId"),text(&source,"accessKey"),text(&record,"revision"),now,record.to_string()]).map_err(storage)?;
        let rowid = tx.last_insert_rowid();
        let body = entries
            .iter()
            .map(|e| text(e, "text"))
            .collect::<Vec<_>>()
            .join("\n");
        tx.execute(
            "INSERT INTO work_memory_fts(rowid,title,summary,body) VALUES(?1,?2,?3,?4)",
            params![
                rowid,
                text(&record, "title"),
                text(&record, "summary"),
                body
            ],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(json!({"record":metadata(&record),"created":true}))
    }

    pub fn read(&self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        let key = scope_key(&input["scope"], &self.profile)?;
        let keys = observed_keys(input)?;
        let id = text(input, "id");
        if !digest(id) || !digest(text(input, "revision")) {
            return Err(denied("invalid_revision"));
        }
        let data: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT revision,record_json FROM work_memory_records WHERE id=?1 AND scope_key=?2",
                params![id, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (revision, body) = data.ok_or(denied("missing_record"))?;
        if revision != text(input, "revision") {
            return Err(denied("stale_revision"));
        }
        let record = checked_record(&body, &key, &self.profile)?;
        if text(&record, "revision") != revision {
            return Err(denied("corrupt_record"));
        }
        if !source_allowed(&record, &keys) {
            return Err(denied("source_not_authorized"));
        }
        let entries = record["entries"]
            .as_array()
            .ok_or(denied("corrupt_record"))?;
        let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
        if offset > entries.len() || !(1..=32).contains(&limit) {
            return Err(denied("invalid_page"));
        }
        let end = offset.saturating_add(limit).min(entries.len());
        let mut result = json!({"record":metadata(&record),"entries":entries[offset..end],"offset":offset,"total":entries.len()});
        if end < entries.len() {
            result["nextOffset"] = end.into();
        }
        Ok(result)
    }

    pub fn search(&self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        let key = scope_key(&input["scope"], &self.profile)?;
        let keys = observed_keys(input)?;
        let query = text(input, "query");
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(6) as usize;
        if !input["query"].is_string()
            || query.encode_utf16().count() > 500
            || !(1..=12).contains(&limit)
        {
            return Err(denied("invalid_query"));
        }
        let terms = query_terms(query);
        if terms.is_empty() {
            return Ok(json!({"hits":[],"omitted":0}));
        }
        // Tokens are derived from alphanumeric text, quoted and parameter-bound;
        // callers cannot inject FTS operators, column filters or arbitrary SQL.
        let expression = terms
            .iter()
            .map(|t| format!("\"{t}\"*"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let access = if keys.is_empty() {
            "r.source_kind<>'observed'".into()
        } else {
            format!("(r.source_kind<>'observed' OR r.source_access IN ({placeholders}))")
        };
        let predicate = format!("work_memory_fts MATCH ? AND r.scope_key=? AND {access}");
        let mut args = vec![expression, key.clone()];
        args.extend(keys.clone());
        let count: i64 = self.conn.query_row(&format!("SELECT count(*) FROM work_memory_fts JOIN work_memory_records r ON r.rowid=work_memory_fts.rowid WHERE {predicate}"),params_from_iter(args.iter()),|r|r.get(0)).map_err(storage)?;
        let mut stmt = self.conn.prepare(&format!("SELECT r.record_json FROM work_memory_fts JOIN work_memory_records r ON r.rowid=work_memory_fts.rowid WHERE {predicate} ORDER BY bm25(work_memory_fts,4.0,2.0,1.0),r.captured_at DESC,r.id LIMIT {limit}")).map_err(storage)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| r.get::<_, String>(0))
            .map_err(storage)?;
        let mut hits = Vec::new();
        for row in rows {
            let record = checked_record(&row.map_err(storage)?, &key, &self.profile)?;
            if !source_allowed(&record, &keys) {
                return Err(denied("corrupt_source_index"));
            }
            let excerpt = record["entries"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|e| {
                    terms
                        .iter()
                        .any(|term| text(e, "text").to_lowercase().contains(term))
                })
                .map(|e| clean(text(e, "text"), 1000))
                .unwrap_or_else(|| clean(text(&record, "summary"), 1000));
            hits.push(json!({"record":metadata(&record),"excerpt":excerpt}));
        }
        Ok(json!({"omitted":(count as usize).saturating_sub(hits.len()),"hits":hits}))
    }

    pub fn revoke(&mut self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        let key = scope_key(&input["scope"], &self.profile)?;
        let mut predicate = "scope_key=?".to_owned();
        let mut args = vec![key];
        for (field, column) in [
            ("sourceKind", "source_kind"),
            ("sourceId", "source_id"),
            ("sessionId", "source_session"),
            ("episodeId", "source_episode"),
            ("accessKey", "source_access"),
        ] {
            if let Some(value) = input.get(field) {
                let value = value.as_str().ok_or(denied("invalid_source"))?;
                if field == "sourceKind" && !SOURCE_KINDS.contains(&value)
                    || ["sourceId", "sessionId", "episodeId"].contains(&field) && !ident(value)
                    || field == "accessKey" && !digest(value)
                {
                    return Err(denied("invalid_source"));
                }
                predicate.push_str(&format!(" AND {column}=?"));
                args.push(value.into());
            }
        }
        let tx = self.conn.transaction().map_err(storage)?;
        tx.execute(&format!("DELETE FROM work_memory_fts WHERE rowid IN (SELECT rowid FROM work_memory_records WHERE {predicate})"),params_from_iter(args.iter())).map_err(storage)?;
        let removed = tx
            .execute(
                &format!("DELETE FROM work_memory_records WHERE {predicate}"),
                params_from_iter(args.iter()),
            )
            .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(json!({"removed":removed}))
    }
}

#[cfg(test)]
mod tests;
