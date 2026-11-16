//! Bounded attributed Observe episodes. Claims never become verified task evidence.
//! The profile-local SQLite file is authoritative; source scope is checked by the
//! host before and after every operation, including association/privacy changes.
use crate::skills::ProfileId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
const SCHEMA: &str = include_str!("schema.sql");
const PROFILE_LIMIT: i64 = 4096;
const SOURCE_LIMIT: i64 = 256;
const STORE_BYTES: u64 = 512 * 1024 * 1024;
const APPLICATION: i64 = 0x45584f4d;
#[derive(Debug)]
pub enum ObservedMemoryError {
    Denied(&'static str),
    Storage,
}
impl std::fmt::Display for ObservedMemoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(reason) => write!(f, "Observed memory unavailable: {reason}"),
            Self::Storage => f.write_str("Observed memory storage unavailable"),
        }
    }
}
impl std::error::Error for ObservedMemoryError {}
type Result<T> = std::result::Result<T, ObservedMemoryError>;
fn denied(reason: &'static str) -> ObservedMemoryError {
    ObservedMemoryError::Denied(reason)
}
fn storage(_: impl std::fmt::Debug) -> ObservedMemoryError {
    ObservedMemoryError::Storage
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn ident(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 200
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
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
    for k in [
        "profileId",
        "workspaceId",
        "sessionId",
        "sourceId",
        "nativeSessionId",
    ] {
        if !ident(text(scope, k)) {
            return Err(denied("invalid_scope"));
        }
    }
    if text(scope, "profileId") != profile.as_str() || !digest(text(scope, "boundary")) {
        return Err(denied("invalid_scope"));
    }
    // Observed aliases of the exact same native conversation deduplicate together.
    Ok(hash(
        &json!([
            scope["profileId"],
            scope["workspaceId"],
            scope["sourceId"],
            scope["nativeSessionId"],
            scope["boundary"]
        ])
        .to_string(),
    ))
}
fn checked_record(body: &str, key: &str, profile: &ProfileId) -> Result<Value> {
    if body.len() > 256 * 1024 {
        return Err(denied("corrupt_episode"));
    }
    let record: Value = serde_json::from_str(body).map_err(storage)?;
    let entries = record["entries"]
        .as_array()
        .ok_or(denied("corrupt_episode"))?;
    if record["trust"] != "untrusted-observed"
        || scope_key(&record["scope"], profile)? != key
        || !ident(text(&record, "episodeId"))
        || entries.is_empty()
        || entries.len() > 32
        || entries.iter().any(|entry| {
            !ident(text(entry, "id"))
                || !["user", "assistant", "tool", "file", "status"].contains(&text(entry, "kind"))
                || text(entry, "text").encode_utf16().count() > 2000
        })
        || text(&record, "id") != hash(&format!("{key}:{}", text(&record, "episodeId")))
        || text(&record, "revision")
            != hash(
                &json!([
                    record["sourceRevision"],
                    record["entries"],
                    record["coverage"]
                ])
                .to_string(),
            )
    {
        return Err(denied("corrupt_episode"));
    }
    Ok(record)
}
fn metadata(record: &Value) -> Value {
    let mut out = record.clone();
    let entries = out["entries"].as_array().map_or(0, Vec::len);
    out["entries"] = entries.into();
    out
}
fn private(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(storage)?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}
fn regular(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(info) if !info.file_type().is_file() || info.len() > STORE_BYTES => {
            Err(denied("unsafe_store"))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    }
}
fn schema(conn: &Connection) -> rusqlite::Result<Vec<(String, String, String)>> {
    conn.prepare("SELECT type,name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect()
}
/// Single-writer store. Opening never clears corrupt, foreign or newer data.
#[derive(Debug)]
pub struct ObservedMemoryStore {
    conn: Connection,
    profile: ProfileId,
    _lock: File,
    directory: PathBuf,
    directory_identity: fs::Metadata,
    file: PathBuf,
    file_identity: fs::Metadata,
}
impl ObservedMemoryStore {
    pub fn open(data: &Path, profile: &ProfileId) -> Result<Self> {
        if !data.is_absolute() {
            return Err(denied("invalid_root"));
        }
        let root = fs::canonicalize(data).map_err(storage)?;
        let profiles = root.join("profiles");
        for folder in [&profiles, &profiles.join(profile.as_str())] {
            match fs::symlink_metadata(folder) {
                Ok(info) if !info.file_type().is_dir() => {
                    return Err(denied("unsafe_profile_directory"));
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    match fs::create_dir(folder) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                            if !fs::symlink_metadata(folder)
                                .map_err(storage)?
                                .file_type()
                                .is_dir()
                            {
                                return Err(denied("unsafe_profile_directory"));
                            }
                        }
                        Err(e) => return Err(storage(e)),
                    }
                }
                Err(e) => return Err(storage(e)),
            }
            private(folder, 0o700)?;
        }
        let file = profiles
            .join(profile.as_str())
            .join("observed-memory.sqlite");
        let sibling = |suffix: &str| PathBuf::from(format!("{}{suffix}", file.to_string_lossy()));
        for p in [
            file.clone(),
            sibling("-wal"),
            sibling("-shm"),
            sibling(".lock"),
        ] {
            regular(&p)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(sibling(".lock")).map_err(storage)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(denied("locked")),
            Err(TryLockError::Error(e)) => return Err(storage(e)),
        }
        regular(&file)?;
        let fresh = !file.exists();
        if fresh {
            options.open(&file).map_err(storage)?;
        }
        let mut conn = Connection::open_with_flags(
            &file,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(storage)?;
        conn.busy_timeout(Duration::from_secs(1)).map_err(storage)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(storage)?;
        let app: i64 = conn
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(storage)?;
        if version == 0 && app == 0 && schema(&conn).map_err(storage)?.is_empty() {
            let tx = conn.transaction().map_err(storage)?;
            tx.execute_batch(SCHEMA).map_err(storage)?;
            tx.execute(
                "INSERT INTO observed_state(profile_id) VALUES(?1)",
                [profile.as_str()],
            )
            .map_err(storage)?;
            tx.pragma_update(None, "application_id", APPLICATION)
                .map_err(storage)?;
            tx.pragma_update(None, "user_version", 1).map_err(storage)?;
            tx.commit().map_err(storage)?;
        } else if version != 1 || app != APPLICATION {
            return Err(denied("foreign_or_newer_schema"));
        }
        let expected = Connection::open_in_memory().map_err(storage)?;
        expected.execute_batch(SCHEMA).map_err(storage)?;
        if schema(&conn).map_err(storage)? != schema(&expected).map_err(storage)? {
            return Err(denied("schema_mismatch"));
        }
        let owners: Vec<String> = conn
            .prepare("SELECT profile_id FROM observed_state ORDER BY profile_id")
            .map_err(storage)?
            .query_map([], |r| r.get(0))
            .map_err(storage)?
            .collect::<std::result::Result<_, _>>()
            .map_err(storage)?;
        if owners != [profile.as_str()] {
            return Err(denied("wrong_profile"));
        }
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(storage)?;
        if check != "ok" {
            return Err(denied("integrity"));
        }
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(storage)?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(denied("journal_mode"));
        }
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(storage)?;
        for p in [
            file.clone(),
            sibling("-wal"),
            sibling("-shm"),
            sibling(".lock"),
        ] {
            if p.exists() {
                regular(&p)?;
                private(&p, 0o600)?;
            }
        }
        let directory = file.parent().ok_or(denied("invalid_root"))?.to_path_buf();
        let directory_identity = fs::symlink_metadata(&directory).map_err(storage)?;
        let file_identity = fs::symlink_metadata(&file).map_err(storage)?;
        Ok(Self {
            conn,
            profile: profile.clone(),
            _lock: lock,
            directory,
            directory_identity,
            file,
            file_identity,
        })
    }
    fn check_storage(&self) -> Result<()> {
        let directory = fs::symlink_metadata(&self.directory).map_err(storage)?;
        let file = fs::symlink_metadata(&self.file).map_err(storage)?;
        if !directory.file_type().is_dir()
            || !file.file_type().is_file()
            || file.len() > STORE_BYTES
            || fs::canonicalize(&self.directory).map_err(storage)? != self.directory
        {
            return Err(denied("store_changed"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if directory.dev() != self.directory_identity.dev()
                || directory.ino() != self.directory_identity.ino()
                || file.dev() != self.file_identity.dev()
                || file.ino() != self.file_identity.ino()
            {
                return Err(denied("store_changed"));
            }
        }
        #[cfg(not(unix))]
        {
            if directory.created().ok() != self.directory_identity.created().ok()
                || file.created().ok() != self.file_identity.created().ok()
            {
                return Err(denied("store_changed"));
            }
        }
        Ok(())
    }
    pub fn capture(&mut self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        let scope = &input["scope"];
        let key = scope_key(scope, &self.profile)?;
        let episode = text(input, "episodeId");
        let source_revision = text(input, "sourceRevision");
        if !ident(episode) || source_revision.is_empty() || source_revision.len() > 512 {
            return Err(denied("invalid_episode"));
        }
        let raw = input["entries"]
            .as_array()
            .ok_or(denied("invalid_entries"))?;
        if raw.is_empty() || raw.len() > 32 {
            return Err(denied("invalid_entries"));
        }
        let mut seen = std::collections::HashSet::new();
        let mut entries = Vec::new();
        let mut clipped = false;
        for row in raw {
            let kind = text(row, "kind");
            let content = text(row, "text");
            if !ident(text(row, "id"))
                || !seen.insert(text(row, "id"))
                || !["user", "assistant", "tool", "file", "status"].contains(&kind)
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
            let mut entry = json!({"id":row["id"],"kind":kind,"text":filtered});
            if let Some(at) = row.get("at") {
                let at = at.as_str().ok_or(denied("invalid_time"))?;
                if at.len() > 80 {
                    return Err(denied("invalid_time"));
                }
                entry["at"] = clean(at, 80).into();
            }
            entries.push(entry);
        }
        let coverage = &input["coverage"];
        if !["partial", "unknown"].contains(&text(coverage, "mode"))
            || coverage["omittedEntries"].as_u64().is_none()
            || !coverage["truncated"].is_boolean()
        {
            return Err(denied("invalid_coverage"));
        }
        let limits = coverage["limits"]
            .as_array()
            .ok_or(denied("invalid_coverage"))?;
        if limits.len() > 8
            || limits
                .iter()
                .any(|s| s.as_str().is_none_or(|s| s.encode_utf16().count() > 500))
        {
            return Err(denied("invalid_coverage"));
        }
        let coverage = json!({"mode":coverage["mode"],"omittedEntries":coverage["omittedEntries"],"truncated":coverage["truncated"]==true||clipped,"limits":limits.iter().map(|s|clean(s.as_str().unwrap_or(""),500)).collect::<Vec<_>>()});
        let id = hash(&format!("{key}:{episode}"));
        let revision = hash(&json!([source_revision, &entries, &coverage]).to_string());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(storage)?
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let record = json!({"id":id,"episodeId":episode,"scope":scope,"revision":revision,"sourceRevision":source_revision,"capturedAt":crate::time::format_utc(now),"entries":entries,"trust":"untrusted-observed","coverage":coverage});
        let tx = self.conn.transaction().map_err(storage)?;
        let previous:Option<(String,String)>=tx.query_row("SELECT revision,record_json FROM observed_episodes WHERE scope_key=?1 AND episode_key=?2",params![key,episode],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage)?;
        if let Some((prior, data)) = previous {
            if prior != revision {
                return Err(denied("episode_conflict"));
            }
            let stored = checked_record(&data, &key, &self.profile)?;
            return Ok(json!({"episode":metadata(&stored),"created":false}));
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM observed_episodes", [], |r| r.get(0))
            .map_err(storage)?;
        let scoped: i64 = tx
            .query_row(
                "SELECT count(*) FROM observed_episodes WHERE scope_key=?1",
                [&key],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if count >= PROFILE_LIMIT || scoped >= SOURCE_LIMIT {
            return Err(denied("capacity_reached"));
        }
        let searchable = record["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| text(e, "text"))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        tx.execute("INSERT INTO observed_episodes(id,scope_key,episode_key,revision,captured_at,record_json,searchable) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,key,episode,revision,now,record.to_string(),searchable]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(json!({"episode":metadata(&record),"created":true}))
    }
    pub fn read(&self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        let key = scope_key(&input["scope"], &self.profile)?;
        let episode = text(input, "episodeId");
        let revision = text(input, "revision");
        if !digest(episode) || !digest(revision) {
            return Err(denied("invalid_revision"));
        }
        let data: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT revision,record_json FROM observed_episodes WHERE id=?1 AND scope_key=?2",
                params![episode, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (current, body) = data.ok_or(denied("missing_episode"))?;
        if current != revision {
            return Err(denied("stale_revision"));
        }
        let record = checked_record(&body, &key, &self.profile)?;
        let entries = record["entries"]
            .as_array()
            .ok_or(denied("corrupt_episode"))?;
        let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
        if !(1..=32).contains(&limit) {
            return Err(denied("invalid_page"));
        }
        let end = offset.saturating_add(limit).min(entries.len());
        let page = if offset < entries.len() {
            entries[offset..end].to_vec()
        } else {
            Vec::new()
        };
        let mut out = json!({"episode":metadata(&record),"entries":page,"offset":offset,"total":entries.len()});
        if end < entries.len() {
            out["nextOffset"] = end.into();
        }
        Ok(out)
    }
    pub fn search(&self, input: &Value) -> Result<Value> {
        self.check_storage()?;
        let key = scope_key(&input["scope"], &self.profile)?;
        let query = text(input, "query");
        if query.encode_utf16().count() > 500 {
            return Err(denied("invalid_query"));
        }
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(6) as usize;
        if !(1..=12).contains(&limit) {
            return Err(denied("invalid_limit"));
        }
        let lower = query.to_lowercase();
        let terms: Vec<_> = lower
            .split_whitespace()
            .filter(|s| s.chars().count() >= 2)
            .take(12)
            .collect();
        let mut stmt=self.conn.prepare("SELECT record_json,searchable FROM observed_episodes WHERE scope_key=?1 ORDER BY captured_at DESC,id LIMIT 256").map_err(storage)?;
        let mut found = Vec::new();
        for row in stmt
            .query_map([&key], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(storage)?
        {
            let (body, searchable) = row.map_err(storage)?;
            let score = terms
                .iter()
                .filter(|term| searchable.contains(**term))
                .count();
            if !terms.is_empty() && score == 0 {
                continue;
            }
            let record = checked_record(&body, &key, &self.profile)?;
            let excerpt = record["entries"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|e| {
                    terms.is_empty()
                        || terms
                            .iter()
                            .any(|term| text(e, "text").to_lowercase().contains(term))
                })
                .map(|e| clean(text(e, "text"), 600))
                .unwrap_or_default();
            found.push((
                score,
                json!({"episode":metadata(&record),"excerpt":excerpt}),
            ));
        }
        found.sort_by_key(|row| std::cmp::Reverse(row.0));
        let omitted = found.len().saturating_sub(limit);
        Ok(
            json!({"hits":found.into_iter().take(limit).map(|(_,v)|v).collect::<Vec<_>>(),"omitted":omitted}),
        )
    }
    pub fn revoke(&mut self, scope: &Value) -> Result<Value> {
        self.check_storage()?;
        let key = scope_key(scope, &self.profile)?;
        let removed = self
            .conn
            .execute("DELETE FROM observed_episodes WHERE scope_key=?1", [key])
            .map_err(storage)?;
        Ok(json!({"removed":removed}))
    }
}
#[cfg(test)]
mod tests;
