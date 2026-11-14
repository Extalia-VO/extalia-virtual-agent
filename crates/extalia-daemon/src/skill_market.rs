//! One-shot, untrusted marketplace discovery and immutable review staging. Never executes packages.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use extalia_core::skills::manifest::{self, MANIFEST_FILE, SKILL_FILE, parse_front_matter};
use extalia_core::skills::tree::{Tree, TreeFile, check_relative_path, check_segment};
use extalia_core::time::{format_utc, now_millis};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod files;
#[cfg(test)]
mod tests;
use files::Directory;

const SCHEMA: &str = "extalia.skill-market.v1";
const FILE_LIMIT: usize = 512 * 1024;
const TOTAL_LIMIT: usize = 2 * 1024 * 1024;
const NETWORK_LIMIT: usize = 8 * 1024 * 1024;
const TREE_LIMIT: usize = 6 * 1024 * 1024;
const REVIEW_TTL: i64 = 10 * 60_000;
const CACHE_TTL: i64 = 5 * 60_000;
const REQUEST_LIMIT: u64 = 16 * 1024;
const REPLY_LIMIT: usize = 128 * 1024;
const MAX_REVIEWS: usize = 32;
const MAX_FILES: usize = 128;
const MAX_PREVIEW_PERMISSIONS: usize = 32;
const MAX_PREVIEW_COMPATIBILITY: usize = 16;
type Result<T> = std::result::Result<T, Failure>;

#[derive(Debug, Clone, Copy)]
struct Failure {
    code: &'static str,
    status: Option<u16>,
}
impl Failure {
    fn new(code: &'static str) -> Self {
        Self { code, status: None }
    }
}
fn fail(code: &'static str) -> Failure {
    Failure::new(code)
}
fn io_error(_: impl std::fmt::Debug) -> Failure {
    fail("storage")
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    extalia_core::mission::contract::is_uuid(value)
}
fn plain(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.encode_utf16().count() <= max
        && !value.chars().any(char::is_control)
}
fn repository(value: &str) -> bool {
    value.len() <= 255
        && value.split('/').count() == 2
        && value.split('/').all(|part| {
            !part.is_empty()
                && part.len() <= 128
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && !part.ends_with('.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}
fn skill_path(value: &str) -> bool {
    check_relative_path(value).is_ok() && value.split('/').count() <= 8
}
fn upstream_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value.split('/').count() <= 16
        && value.split('/').all(|part| check_segment(part).is_ok())
}

fn profile_location(directory: &Path) -> Result<(&Path, &str)> {
    let profile = directory.parent().ok_or_else(|| fail("invalid_request"))?;
    if cfg!(unix)
        && profile.file_name().and_then(|v| v.to_str()) == Some("skills")
        && directory.file_name().and_then(|v| v.to_str()) == Some("market")
    {
        return Ok((
            profile.parent().ok_or_else(|| fail("invalid_request"))?,
            "default",
        ));
    }
    if directory.file_name().and_then(|v| v.to_str()) != Some("skill-market") {
        return Err(fail("invalid_request"));
    }
    let id = profile
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|id| extalia_core::skills::ProfileId::parse(id).is_some())
        .ok_or_else(|| fail("invalid_request"))?;
    let profiles = profile
        .parent()
        .filter(|path| path.file_name().and_then(|value| value.to_str()) == Some("profiles"))
        .ok_or_else(|| fail("invalid_request"))?;
    if cfg!(unix) && id == "default" {
        return Err(fail("invalid_request"));
    }
    Ok((
        profiles.parent().ok_or_else(|| fail("invalid_request"))?,
        id,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema: String,
    request_id: String,
    client_version: String,
    operation: String,
    directory: PathBuf,
    timeout_ms: u64,
    query: Option<String>,
    refresh: Option<bool>,
    repository: Option<String>,
    skill: Option<String>,
    review_id: Option<String>,
}
impl Request {
    fn validate(&self) -> Result<()> {
        profile_location(&self.directory)?;
        if self.schema != SCHEMA
            || !uuid(&self.request_id)
            || !plain(&self.client_version, 64)
            || !(1..=45_000).contains(&self.timeout_ms)
            || !self.directory.is_absolute()
            || !matches!(
                self.directory.file_name().and_then(|v| v.to_str()),
                Some("skill-market" | "market")
            )
            || self.directory.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(fail("invalid_request"));
        }
        let valid = match self.operation.as_str() {
            "search" => {
                self.query
                    .as_deref()
                    .is_some_and(|v| plain(v, 120) && v == v.trim())
                    && self.repository.is_none()
                    && self.skill.is_none()
                    && self.review_id.is_none()
            }
            "preview" => {
                self.repository.as_deref().is_some_and(repository)
                    && self.skill.as_deref().is_some_and(skill_path)
                    && self.query.is_none()
                    && self.refresh.is_none()
                    && self.review_id.is_none()
            }
            "stage" | "discard" => {
                self.review_id.as_deref().is_some_and(uuid)
                    && self.query.is_none()
                    && self.refresh.is_none()
                    && self.repository.is_none()
                    && self.skill.is_none()
            }
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(fail("invalid_request"))
        }
    }
}

trait Http {
    fn get(&mut self, url: &str, limit: usize) -> Result<Vec<u8>>;
}
struct Network {
    client: Client,
    started: Instant,
    timeout: Duration,
    bytes: usize,
}
impl Network {
    fn new(timeout_ms: u64) -> Result<Self> {
        let timeout = Duration::from_millis(timeout_ms);
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(timeout)
            .timeout(timeout)
            .user_agent("Extalia-Skill-Market/1")
            .build()
            .map_err(|_| fail("network"))?;
        Ok(Self {
            client,
            started: Instant::now(),
            timeout,
            bytes: 0,
        })
    }
}
impl Http for Network {
    fn get(&mut self, value: &str, limit: usize) -> Result<Vec<u8>> {
        let url = reqwest::Url::parse(value).map_err(|_| fail("invalid_request"))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || !matches!(
                url.host_str(),
                Some("skills.sh" | "api.github.com" | "raw.githubusercontent.com")
            )
        {
            return Err(fail("invalid_request"));
        }
        let remaining = self
            .timeout
            .checked_sub(self.started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| fail("timeout"))?;
        let mut response = self
            .client
            .get(url)
            .header("Accept", "application/json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .timeout(remaining)
            .send()
            .map_err(|e| fail(if e.is_timeout() { "timeout" } else { "network" }))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            return Err(Failure {
                code: match status {
                    404 => "not_found",
                    403 | 429 => "rate_limited",
                    _ => "network",
                },
                status: Some(status),
            });
        }
        if response.content_length().is_some_and(|v| v > limit as u64) {
            return Err(fail("too_large"));
        }
        let mut body = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            if self.started.elapsed() >= self.timeout {
                return Err(fail("timeout"));
            }
            let n = response.read(&mut chunk).map_err(|error| {
                let timed_out = error.kind() == std::io::ErrorKind::TimedOut
                    || error
                        .get_ref()
                        .and_then(|inner| inner.downcast_ref::<reqwest::Error>())
                        .is_some_and(reqwest::Error::is_timeout);
                fail(if timed_out { "timeout" } else { "network" })
            })?;
            if n == 0 {
                break;
            }
            if body.len() + n > limit || self.bytes + n > NETWORK_LIMIT {
                return Err(fail("too_large"));
            }
            body.extend_from_slice(&chunk[..n]);
            self.bytes += n;
        }
        Ok(body)
    }
}
fn json_body(http: &mut impl Http, url: &str, limit: usize) -> Result<Value> {
    let bytes = http.get(url, limit)?;
    if bytes.len() > limit {
        return Err(fail("too_large"));
    }
    serde_json::from_slice(&bytes).map_err(|_| fail("network"))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchEntry {
    id: String,
    name: String,
    source: String,
    installs: u64,
    url: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchCache {
    query: String,
    fetched_at: i64,
    entries: Vec<SearchEntry>,
}
fn search_rows(value: &Value) -> Result<Vec<SearchEntry>> {
    let rows = value
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| fail("network"))?;
    if rows.len() > 500 {
        return Err(fail("too_large"));
    }
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows {
        let Some(source) = row
            .get("source")
            .and_then(Value::as_str)
            .filter(|v| repository(v))
        else {
            continue;
        };
        let Some(id) = row
            .get("skillId")
            .and_then(Value::as_str)
            .filter(|v| check_segment(v).is_ok())
        else {
            continue;
        };
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|v| plain(v, 200))
            .unwrap_or(id);
        if !seen.insert(format!("{source}/{id}")) {
            continue;
        }
        entries.push(SearchEntry {
            id: id.into(),
            name: name.into(),
            source: source.into(),
            installs: row
                .get("installs")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(9_007_199_254_740_991),
            url: format!("https://skills.sh/{source}/{id}"),
        });
        if entries.len() == 50 {
            break;
        }
    }
    Ok(entries)
}
fn cache_valid(cache: &SearchCache, query: &str, now: i64) -> bool {
    cache.query == query
        && cache.fetched_at <= now
        && cache.fetched_at > 0
        && cache.entries.len() <= 50
        && cache.entries.iter().all(|entry| {
            repository(&entry.source)
                && check_segment(&entry.id).is_ok()
                && plain(&entry.name, 200)
                && entry.url == format!("https://skills.sh/{}/{}", entry.source, entry.id)
                && entry.installs <= 9_007_199_254_740_991
        })
}
fn search(request: &Request, root: &Directory, http: &mut impl Http, now: i64) -> Result<Value> {
    let query = request
        .query
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    let cache_dir = root.child("cache", true)?;
    let key = format!("{}.json", digest(query.as_bytes()));
    let cache = cache_dir
        .read_optional(&key, 128 * 1024)?
        .and_then(|bytes| serde_json::from_slice::<SearchCache>(&bytes).ok())
        .filter(|cache| cache_valid(cache, query, now));
    let result = |cache: &SearchCache, cached: bool, stale: bool, problem: Option<&str>| {
        let mut value = json!({"provider":"skills-sh", "query":query, "entries":cache.entries,"fetchedAt":format_utc(cache.fetched_at),"cached":cached,"stale":stale});
        if let Some(problem) = problem {
            value["problem"] = json!(problem);
        }
        value
    };
    if !request.refresh.unwrap_or(false)
        && let Some(cache) = &cache
        && now - cache.fetched_at <= CACHE_TTL
    {
        return Ok(result(cache, true, false, None));
    }
    let mut url =
        reqwest::Url::parse("https://skills.sh/api/search").map_err(|_| fail("invalid_request"))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", "50");
    match json_body(http, url.as_str(), 512 * 1024).and_then(|body| search_rows(&body)) {
        Ok(entries) => {
            let next = SearchCache {
                query: query.into(),
                fetched_at: now,
                entries,
            };
            let mut saved = Vec::new();
            for name in cache_dir.names()? {
                if name.strip_suffix(".json").is_some_and(|hash| hex(hash, 64)) {
                    let at = cache_dir
                        .read_optional(&name, 128 * 1024)?
                        .and_then(|bytes| serde_json::from_slice::<SearchCache>(&bytes).ok())
                        .map_or(0, |row| row.fetched_at);
                    saved.push((at, name));
                } else if name.starts_with("temp-") && name.ends_with(".json") {
                    // Interrupted atomic cache writes contain no shared package payload.
                    cache_dir.remove_file(&name)?;
                }
            }
            saved.sort();
            let incoming = usize::from(!saved.iter().any(|(_, name)| name == &key));
            let remove = (saved.len() + incoming).saturating_sub(64);
            for (_, name) in saved
                .into_iter()
                .filter(|(_, name)| name != &key)
                .take(remove)
            {
                cache_dir.remove_file(&name)?;
            }
            cache_dir.replace(
                &key,
                &serde_json::to_vec(&next).map_err(io_error)?,
                &request.request_id,
            )?;
            Ok(result(&next, false, false, None))
        }
        Err(error) => {
            if let Some(cache) = cache {
                Ok(result(&cache, true, true, Some(error.code)))
            } else {
                Err(error)
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketFile {
    path: String,
    size: u64,
    sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    review_id: String,
    created_at: i64,
    expires_at: i64,
    repository: String,
    commit: String,
    directory: String,
    source_ref: String,
    files: Vec<MarketFile>,
    total_bytes: u64,
    tree_sha256: String,
    license: Option<String>,
    warnings: Vec<String>,
}
impl Review {
    fn result(&self, manifest: Value) -> Value {
        let mut value = json!({"reviewId":self.review_id,"expiresAt":format_utc(self.expires_at),"repository":self.repository,"commit":self.commit,
            "directory":self.directory,"sourceRef":self.source_ref,"files":self.files,"totalBytes":self.total_bytes,"treeSha256":self.tree_sha256,
            "manifest":manifest,"warnings":self.warnings});
        if let Some(license) = &self.license {
            value["license"] = json!(license);
        }
        value
    }
    fn validate(&self, id: &str) -> Result<()> {
        if self.review_id != id
            || !uuid(id)
            || !repository(&self.repository)
            || !hex(&self.commit, 40)
            || !hex(&self.tree_sha256, 64)
            || self.source_ref.len() > 512
            || !self.directory.is_empty() && !skill_path(&self.directory)
            || self.source_ref
                != format!(
                    "github:{}@{}#{}",
                    self.repository, self.commit, self.directory
                )
            || self.expires_at.checked_sub(self.created_at) != Some(REVIEW_TTL)
            || self.created_at <= 0
            || self.files.is_empty()
            || self.files.len() > MAX_FILES
            || self.total_bytes > TOTAL_LIMIT as u64
            || self.files.iter().any(|file| {
                !skill_path(&file.path) || !hex(&file.sha256, 64) || file.size > FILE_LIMIT as u64
            })
            || self.files.iter().map(|file| file.size).sum::<u64>() != self.total_bytes
            || self.files.iter().filter(|f| f.path == "SKILL.md").count() != 1
        {
            return Err(fail("integrity"));
        }
        validate_paths(self.files.iter().map(|file| file.path.as_str()))?;
        if tree(&self.files).sha256 != self.tree_sha256 {
            return Err(fail("integrity"));
        }
        Ok(())
    }
}
fn tree(files: &[MarketFile]) -> Tree {
    Tree::from_files(
        files
            .iter()
            .map(|f| TreeFile {
                path: f.path.clone(),
                size: f.size,
                sha256: f.sha256.clone(),
                executable: false,
            })
            .collect(),
    )
}

/// Resolve the same immutable bytes and file modes that the registry import will see.
/// These declarations inform review. They do not authorize tools or establish compatibility.
fn preview_manifest(tree: &Tree, payloads: &BTreeMap<String, Vec<u8>>) -> Result<Value> {
    let skill = payloads
        .get(SKILL_FILE)
        .ok_or_else(|| fail("invalid_tree"))?;
    let resolved = manifest::resolve(tree, payloads.get(MANIFEST_FILE).map(Vec::as_slice), skill)
        .map_err(|_| fail("invalid_manifest"))?;
    let manifest = resolved.manifest;
    let permissions = manifest.permissions.entries();
    let permissions_total = permissions.len();
    let permissions: Vec<_> = permissions
        .into_iter()
        .take(MAX_PREVIEW_PERMISSIONS)
        .map(|(capability, scope)| json!({"capability":capability.as_str(),"scope":scope}))
        .collect();
    let compatibility: Vec<_> = manifest
        .compatibility
        .iter()
        .take(MAX_PREVIEW_COMPATIBILITY)
        .map(|(id, range)| {
            let range = range.split_whitespace().collect::<Vec<_>>().join(" ");
            json!({"id":id,"range":range})
        })
        .collect();
    Ok(json!({
        "id": manifest.id,
        "version": manifest.version,
        "inferred": resolved.inferred,
        "riskClass": manifest.risk_class.as_str(),
        "permissions": permissions,
        "permissionsTotal": permissions_total,
        "compatibility": compatibility,
        "compatibilityTotal": manifest.compatibility.len(),
    }))
}

fn validate_paths<'a>(paths: impl IntoIterator<Item = &'a str>) -> Result<()> {
    let mut names = BTreeMap::new();
    let mut files = BTreeSet::new();
    for path in paths {
        if !skill_path(path) || !files.insert(path.to_owned()) {
            return Err(fail("invalid_tree"));
        }
        let mut prefix = String::new();
        for part in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if let Some(previous) = names.insert(prefix.to_ascii_lowercase(), prefix.clone())
                && previous != prefix
            {
                return Err(fail("invalid_tree"));
            }
        }
    }
    if files.iter().any(|path| {
        path.split('/')
            .scan(String::new(), |prefix, part| {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                Some(prefix.clone())
            })
            .any(|prefix| prefix != *path && files.contains(&prefix))
    }) {
        return Err(fail("invalid_tree"));
    }
    Ok(())
}
#[derive(Clone, Debug)]
struct Blob {
    path: String,
    size: u64,
}
fn raw(http: &mut impl Http, repo: &str, commit: &str, path: &str) -> Result<Vec<u8>> {
    if !hex(commit, 40) || !upstream_path(path) {
        return Err(fail("invalid_tree"));
    }
    let bytes = http.get(
        &format!("https://raw.githubusercontent.com/{repo}/{commit}/{path}"),
        FILE_LIMIT,
    )?;
    if bytes.len() > FILE_LIMIT {
        return Err(fail("too_large"));
    }
    Ok(bytes)
}
fn resolve_tree(request: &Request, http: &mut impl Http) -> Result<(String, Vec<Value>)> {
    let repo = request
        .repository
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    let commit = json_body(
        http,
        &format!("https://api.github.com/repos/{repo}/commits/HEAD"),
        512 * 1024,
    )?;
    let sha = commit
        .get("sha")
        .and_then(Value::as_str)
        .filter(|v| hex(v, 40))
        .ok_or_else(|| fail("network"))?
        .to_owned();
    let expected_tree = commit
        .pointer("/commit/tree/sha")
        .and_then(Value::as_str)
        .filter(|v| hex(v, 40))
        .ok_or_else(|| fail("network"))?;
    let value = json_body(
        http,
        &format!("https://api.github.com/repos/{repo}/git/trees/{expected_tree}?recursive=1"),
        TREE_LIMIT,
    )?;
    if value.get("truncated") != Some(&json!(false))
        || value.get("sha").and_then(Value::as_str) != Some(expected_tree)
    {
        return Err(fail("invalid_tree"));
    }
    let entries = value
        .get("tree")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= 50_000)
        .ok_or_else(|| fail("too_large"))?
        .clone();
    Ok((sha, entries))
}
fn selected_directory(
    request: &Request,
    commit: &str,
    rows: &[Value],
    http: &mut impl Http,
) -> Result<(String, BTreeMap<String, Vec<u8>>)> {
    let requested = request
        .skill
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    let repo = request
        .repository
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    let candidates: Vec<_> = rows
        .iter()
        .filter_map(|row| row.get("path").and_then(Value::as_str))
        .filter(|path| *path == "SKILL.md" || path.ends_with("/SKILL.md"))
        .collect();
    let explicit = if requested == "SKILL.md" || requested.ends_with("/SKILL.md") {
        requested.to_owned()
    } else {
        format!("{requested}/SKILL.md")
    };
    if candidates.iter().any(|path| *path == explicit) {
        return Ok((
            explicit.strip_suffix("/SKILL.md").unwrap_or("").to_owned(),
            BTreeMap::new(),
        ));
    }
    if requested.contains('/') {
        return Err(fail("not_found"));
    }
    if candidates.len() > 32 {
        return Err(fail("too_large"));
    }
    let mut found = Vec::new();
    let mut prefetched = BTreeMap::new();
    let mut total = 0;
    for candidate in candidates {
        if !upstream_path(candidate) {
            continue;
        }
        let Some(row) = rows
            .iter()
            .find(|row| row.get("path").and_then(Value::as_str) == Some(candidate))
        else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("blob")
            || !matches!(
                row.get("mode").and_then(Value::as_str),
                Some("100644" | "100755")
            )
        {
            return Err(fail("invalid_tree"));
        }
        let bytes = raw(http, repo, commit, candidate)?;
        total += bytes.len();
        if total > TOTAL_LIMIT {
            return Err(fail("too_large"));
        }
        if parse_front_matter(&bytes).is_ok_and(|front| front.name == requested) {
            found.push(candidate.strip_suffix("/SKILL.md").unwrap_or("").to_owned());
        }
        prefetched.insert(candidate.to_owned(), bytes);
    }
    if found.len() != 1 {
        return Err(fail(if found.is_empty() {
            "not_found"
        } else {
            "invalid_tree"
        }));
    }
    Ok((found.remove(0), prefetched))
}
fn selected_blobs(rows: &[Value], directory: &str) -> Result<Vec<Blob>> {
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    let mut blobs = Vec::new();
    let mut total = 0u64;
    let mut all_paths = BTreeMap::new();
    for row in rows {
        let Some(full) = row.get("path").and_then(Value::as_str) else {
            return Err(fail("invalid_tree"));
        };
        let Some(path) = full.strip_prefix(&prefix) else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        if !skill_path(path) {
            return Err(fail("invalid_tree"));
        }
        if let Some(old) = all_paths.insert(path.to_ascii_lowercase(), path.to_owned())
            && old != path
        {
            return Err(fail("invalid_tree"));
        }
        match (
            row.get("type").and_then(Value::as_str),
            row.get("mode").and_then(Value::as_str),
        ) {
            (Some("tree"), Some("040000")) => {}
            (Some("blob"), Some("100644" | "100755")) => {
                let size = row
                    .get("size")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| fail("invalid_tree"))?;
                if size > FILE_LIMIT as u64 {
                    return Err(fail("too_large"));
                }
                total = total.checked_add(size).ok_or_else(|| fail("too_large"))?;
                if total > TOTAL_LIMIT as u64 || blobs.len() >= MAX_FILES {
                    return Err(fail("too_large"));
                }
                blobs.push(Blob {
                    path: path.into(),
                    size,
                });
            }
            _ => return Err(fail("invalid_tree")),
        }
    }
    validate_paths(blobs.iter().map(|b| b.path.as_str()))?;
    if !blobs.iter().any(|b| b.path == "SKILL.md") {
        return Err(fail("not_found"));
    }
    blobs.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(blobs)
}
fn preview(
    request: &Request,
    root: &Directory,
    profile: &Directory,
    global: bool,
    http: &mut impl Http,
    now: i64,
) -> Result<Value> {
    let names = root.names()?;
    if names.iter().any(|name| name == &request.request_id) {
        return Err(fail("review_conflict"));
    }
    // Only this module's UUID namespace is eligible for expiry cleanup.
    for name in names.iter().filter(|name| uuid(name)) {
        let Ok(dir) = root.child(name, false) else {
            continue;
        };
        let review = dir
            .read("review.json", REPLY_LIMIT)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Review>(&bytes).ok());
        let expired = review
            .as_ref()
            .is_some_and(|review| review.validate(name).is_ok() && review.expires_at <= now);
        let abandoned = review.is_none()
            && dir
                .modified_millis()
                .is_ok_and(|modified| modified + REVIEW_TTL <= now);
        if expired || abandoned {
            root.remove_tree(name, 0, &mut 1024)?;
        }
    }
    for name in root.names()? {
        let Some(id) = name
            .strip_prefix("stage-")
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|id| uuid(id))
        else {
            continue;
        };
        let Some(bytes) = root.read_optional(&name, REPLY_LIMIT)? else {
            continue;
        };
        let Ok(review) = serde_json::from_slice::<Review>(&bytes) else {
            continue;
        };
        // Give a confirmed stage an hour beyond its preview deadline for an in-flight registry import.
        if review.validate(id).is_ok() && review.expires_at.saturating_add(60 * 60_000) <= now {
            remove_owned(root, profile, id, global)?;
        }
    }
    if root.names()?.iter().filter(|name| uuid(name)).count() >= MAX_REVIEWS {
        return Err(fail("review_conflict"));
    }
    let repo = request
        .repository
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    let (commit, rows) = resolve_tree(request, http)?;
    let (directory, mut prefetched) = selected_directory(request, &commit, &rows, http)?;
    let blobs = selected_blobs(&rows, &directory)?;
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    let mut payloads = BTreeMap::new();
    let mut total = 0usize;
    for blob in blobs {
        let full = format!("{prefix}{}", blob.path);
        let bytes = match prefetched.remove(&full) {
            Some(bytes) => bytes,
            None => raw(http, repo, &commit, &full)?,
        };
        if bytes.len() as u64 != blob.size {
            return Err(fail("integrity"));
        }
        total += bytes.len();
        if total > TOTAL_LIMIT {
            return Err(fail("too_large"));
        }
        payloads.insert(blob.path, bytes);
    }
    let mut license_files: Vec<String> = payloads
        .keys()
        .filter(|path| license_name(path))
        .cloned()
        .collect();
    // Retain repository-wide license notices with the copied package, without claiming legal permission.
    if license_files.is_empty() && !directory.is_empty() {
        for row in rows
            .iter()
            .filter(|row| {
                row.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(license_name)
            })
            .take(4)
        {
            let path = row
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| fail("invalid_tree"))?;
            if path.contains('/') {
                continue;
            }
            if row.get("type").and_then(Value::as_str) != Some("blob")
                || !matches!(
                    row.get("mode").and_then(Value::as_str),
                    Some("100644" | "100755")
                )
            {
                return Err(fail("invalid_tree"));
            }
            let bytes = raw(http, repo, &commit, path)?;
            if row.get("size").and_then(Value::as_u64) != Some(bytes.len() as u64) {
                return Err(fail("integrity"));
            }
            total += bytes.len();
            if total > TOTAL_LIMIT || payloads.len() >= MAX_FILES {
                return Err(fail("too_large"));
            }
            let name = format!("{path}.upstream");
            payloads.insert(name.clone(), bytes);
            license_files.push(name);
        }
    }
    validate_paths(payloads.keys().map(String::as_str))?;
    let files: Vec<_> = payloads
        .iter()
        .map(|(path, bytes)| MarketFile {
            path: path.clone(),
            size: bytes.len() as u64,
            sha256: digest(bytes),
        })
        .collect();
    let tree = tree(&files);
    let manifest = preview_manifest(&tree, &payloads)?;
    let license = (!license_files.is_empty()).then(|| {
        format!(
            "License notices: {}. Terms require your review.",
            license_files.join(", ")
        )
    });
    let mut warnings = vec!["Marketplace entries and repository content are untrusted. No code was executed and nothing was activated.".into(), "Files are copied without executable permission; installation still requires the existing quarantine and review gates.".into()];
    if license.is_none() {
        warnings.push("No license notice was found for this package. Marketplace listing does not establish permission to use or redistribute it.".into());
    } else {
        warnings.push("License notices are included as source evidence, not a legal compatibility determination.".into());
    }
    let review = Review {
        review_id: request.request_id.clone(),
        created_at: now,
        expires_at: now + REVIEW_TTL,
        repository: repo.into(),
        commit: commit.clone(),
        directory: directory.clone(),
        source_ref: format!("github:{repo}@{commit}#{directory}"),
        tree_sha256: tree.sha256,
        files,
        total_bytes: total as u64,
        license,
        warnings,
    };
    review.validate(&request.request_id)?;
    let dir = root.exclusive_child(&request.request_id)?;
    let written = (|| -> Result<()> {
        for (index, file) in review.files.iter().enumerate() {
            dir.create(
                &format!("payload-{index:03}.bin"),
                payloads.get(&file.path).ok_or_else(|| fail("integrity"))?,
            )?;
        }
        dir.create(
            "review.json",
            &serde_json::to_vec(&review).map_err(io_error)?,
        )
    })();
    if let Err(error) = written {
        let _ = root.remove_tree(&request.request_id, 0, &mut 1024);
        return Err(error);
    }
    Ok(review.result(manifest))
}
fn license_name(path: &str) -> bool {
    !path.contains('/')
        && matches!(
            path.to_ascii_lowercase().as_str(),
            "license"
                | "license.md"
                | "license.txt"
                | "licence"
                | "licence.md"
                | "licence.txt"
                | "copying"
                | "notice"
        )
}
fn load_review(root: &Directory, id: &str) -> Result<(Directory, Review)> {
    let dir = root.child(id, false)?;
    let bytes = dir.read("review.json", REPLY_LIMIT)?;
    let review: Review = serde_json::from_slice(&bytes).map_err(|_| fail("integrity"))?;
    review.validate(id)?;
    Ok((dir, review))
}
fn stage_paths(dir: &Directory, prefix: &str, budget: &mut usize) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    for name in dir.names()? {
        *budget = budget.checked_sub(1).ok_or_else(|| fail("too_large"))?;
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if !skill_path(&path) {
            return Err(fail("integrity"));
        }
        if let Ok(child) = dir.child(&name, false) {
            paths.extend(stage_paths(&child, &path, budget)?);
        } else {
            dir.read(&name, FILE_LIMIT)?;
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}
fn verify_stage(dir: &Directory, review: &Review) -> Result<()> {
    let expected: Vec<_> = review.files.iter().map(|file| file.path.clone()).collect();
    if stage_paths(dir, "", &mut 1024)? != expected {
        return Err(fail("integrity"));
    }
    for file in &review.files {
        let bytes = dir.read_path(&file.path, FILE_LIMIT)?;
        if bytes.len() as u64 != file.size || digest(&bytes) != file.sha256 {
            return Err(fail("integrity"));
        }
    }
    Ok(())
}
fn stage(
    request: &Request,
    root: &Directory,
    profile: &Directory,
    global: bool,
    now: i64,
) -> Result<Value> {
    let id = request
        .review_id
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    let (dir, review) = load_review(root, id)?;
    if review.expires_at <= now || review.created_at > now {
        return Err(fail("review_expired"));
    }
    let mut payloads = Vec::new();
    for (index, file) in review.files.iter().enumerate() {
        let bytes = dir.read(&format!("payload-{index:03}.bin"), FILE_LIMIT)?;
        if bytes.len() as u64 != file.size || digest(&bytes) != file.sha256 {
            return Err(fail("integrity"));
        }
        payloads.push(bytes);
    }
    let inbox = profile.child(if global { "imports" } else { "skill-imports" }, true)?;
    let path = format!("market-{id}");
    let marker = format!("stage-{id}.json");
    let result =
        || json!({"path":path,"treeSha256":review.tree_sha256,"sourceRef":review.source_ref});
    if let Some(bytes) = root.read_optional(&marker, REPLY_LIMIT)? {
        let recorded: Review = serde_json::from_slice(&bytes).map_err(|_| fail("integrity"))?;
        recorded.validate(id)?;
        if recorded.tree_sha256 != review.tree_sha256 || recorded.source_ref != review.source_ref {
            return Err(fail("integrity"));
        }
        verify_stage(&inbox.child(&path, false)?, &review)?;
        return Ok(result());
    }
    if root
        .names()?
        .iter()
        .filter(|name| name.starts_with("stage-"))
        .count()
        >= MAX_REVIEWS
    {
        return Err(fail("review_conflict"));
    }
    if inbox.names()?.iter().any(|name| name == &path) {
        return Err(fail("review_conflict"));
    }
    root.create(&marker, &serde_json::to_vec(&review).map_err(io_error)?)?;
    let staged = inbox.exclusive_child(&path)?;
    for (file, bytes) in review.files.iter().zip(payloads.iter()) {
        staged.write_path(&file.path, bytes)?;
    }
    verify_stage(&staged, &review)?;
    Ok(result())
}
fn remove_owned(root: &Directory, profile: &Directory, id: &str, global: bool) -> Result<bool> {
    let mut discarded = false;
    let marker = format!("stage-{id}.json");
    if let Some(bytes) = root.read_optional(&marker, REPLY_LIMIT)? {
        let review: Review = serde_json::from_slice(&bytes).map_err(|_| fail("integrity"))?;
        review.validate(id)?;
        let inbox = profile.child(if global { "imports" } else { "skill-imports" }, true)?;
        let name = format!("market-{id}");
        if inbox.names()?.contains(&name) {
            inbox.remove_tree(&name, 0, &mut 1024)?;
        }
        root.remove_file(&marker)?;
        discarded = true;
    }
    if root.names()?.iter().any(|name| name == id) {
        root.remove_tree(id, 0, &mut 1024)?;
        discarded = true;
    }
    Ok(discarded)
}
fn discard(
    request: &Request,
    root: &Directory,
    profile: &Directory,
    global: bool,
) -> Result<Value> {
    let id = request
        .review_id
        .as_deref()
        .ok_or_else(|| fail("invalid_request"))?;
    Ok(json!({"discarded":remove_owned(root, profile, id, global)?}))
}
fn execute(request: &Request, http: &mut impl Http, now: i64) -> Result<Value> {
    request.validate()?;
    let (data_root, profile_id) = profile_location(&request.directory)?;
    let profile_id = extalia_core::skills::ProfileId::parse(profile_id)
        .ok_or_else(|| fail("invalid_request"))?;
    let _layout = extalia_core::skills::storage::prepare(data_root, &profile_id)
        .map_err(|_| fail("storage"))?;
    let data = Directory::trusted_root(data_root)?;
    let global = extalia_core::skills::storage::is_global(&profile_id);
    let profile = if global {
        data.child("skills", false)?
    } else {
        data.child("profiles", true)?
            .child(profile_id.as_str(), true)?
    };
    let root = profile.child(if global { "market" } else { "skill-market" }, true)?;
    let _ownership = root.lock()?;
    match request.operation.as_str() {
        "search" => search(request, &root, http, now),
        "preview" => preview(request, &root, &profile, global, http, now),
        "stage" => stage(request, &root, &profile, global, now),
        "discard" => discard(request, &root, &profile, global),
        _ => Err(fail("invalid_request")),
    }
}
/// EOF-delimited one-shot JSON. No profile initialization, ambient credentials, shell or provider runtime.
pub fn serve(mut input: impl Read, mut output: impl Write) -> u8 {
    let mut bytes = Vec::new();
    if input
        .by_ref()
        .take(REQUEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > REQUEST_LIMIT as usize
    {
        return 2;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return 2;
    };
    let Some(id) = value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|id| uuid(id))
    else {
        return 2;
    };
    let request: std::result::Result<Request, _> = serde_json::from_slice(&bytes);
    let result = request
        .as_ref()
        .map_err(|_| fail("invalid_request"))
        .and_then(|request| {
            request.validate()?;
            if value
                .as_object()
                .is_some_and(|fields| fields.values().any(Value::is_null))
            {
                return Err(fail("invalid_request"));
            }
            let mut http = Network::new(request.timeout_ms)?;
            execute(request, &mut http, now_millis())
        });
    let mut reply = json!({"schema":SCHEMA,"requestId":id});
    match result {
        Ok(result) => {
            reply["outcome"] = json!("ok");
            reply["operation"] =
                json!(request.as_ref().map(|r| r.operation.as_str()).unwrap_or(""));
            reply["result"] = result;
        }
        Err(error) => {
            reply["outcome"] = json!("error");
            reply["code"] = json!(error.code);
            if let Some(status) = error.status {
                reply["status"] = json!(status);
            }
        }
    }
    let Ok(mut bytes) = serde_json::to_vec(&reply) else {
        return 1;
    };
    bytes.push(b'\n');
    if bytes.len() > REPLY_LIMIT
        || output
            .write_all(&bytes)
            .and_then(|()| output.flush())
            .is_err()
    {
        return 1;
    }
    0
}
pub fn run_stdio() -> u8 {
    serve(std::io::stdin().lock(), std::io::stdout().lock())
}
