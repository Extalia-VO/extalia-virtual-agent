//! One-shot public-source fetch receipts. Retrieved text is untrusted data, never scanner evidence.
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{Url, blocking::Client, header};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

const SCHEMA: &str = "extalia.learning-source.v1";
const BODY_LIMIT: usize = 128 * 1024;
const EXCERPT_LIMIT: usize = 32 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
type Result<T> = std::result::Result<T, &'static str>;

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema: String,
    request_id: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceReadResult {
    source_url: String,
    final_url: String,
    content_type: String,
    bytes: usize,
    sha256: String,
    excerpt: String,
    truncated: bool,
}

fn normalize_url(raw: &str) -> Result<Url> {
    if raw.is_empty()
        || raw.len() > 2048
        || raw.chars().any(|c| c.is_whitespace() || c.is_control())
        || raw.contains('\\')
    {
        return Err("invalid_url");
    }
    let mut url = Url::parse(raw).map_err(|_| "invalid_url")?;
    let authority = raw.split_once("://").ok_or("invalid_url")?.1;
    let authority = authority.split(['/', '?', '#']).next().unwrap_or("");
    if !matches!(url.scheme(), "http" | "https")
        || authority.is_empty()
        || authority.contains('@')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.port().is_some()
        || url.host_str().is_none()
    {
        return Err("invalid_url");
    }
    url.set_fragment(None);
    let host = url.host_str().ok_or("invalid_url")?;
    let hostname = host.trim_end_matches('.').to_ascii_lowercase();
    if hostname == "localhost"
        || hostname.ends_with(".localhost")
        || hostname.ends_with(".local")
        || !hostname.contains('.') && !hostname.contains(':')
    {
        return Err("blocked_address");
    }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
        && !public_ip(ip)
    {
        return Err("blocked_address");
    }
    Ok(url)
}

/// Conservative admission: special-purpose and transition ranges are excluded too.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && (b == 168 || b == 0 && matches!(c, 0 | 2) || b == 88 && c == 99))
                && !(a == 198 && (matches!(b, 18 | 19) || b == 51 && c == 100))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn admit_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>> {
    if addresses.is_empty() || addresses.len() > 64 {
        return Err("network");
    }
    if addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("blocked_address");
    }
    Ok(addresses)
}

fn resolve(url: &Url) -> Result<Vec<SocketAddr>> {
    let host = url
        .host_str()
        .ok_or("invalid_url")?
        .trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or("invalid_url")?;
    // DNS may block in the OS resolver; the independent host child deadline bounds it.
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| "network")?
        .take(65)
        .collect();
    admit_addresses(addresses)
}

struct Hop {
    status: u16,
    location: Option<String>,
    content_type: String,
    body: Vec<u8>,
}

struct PinnedDns {
    host: String,
    addresses: Vec<SocketAddr>,
}

impl reqwest::dns::Resolve for PinnedDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let result = if name.as_str().eq_ignore_ascii_case(&self.host) {
            Ok(Box::new(self.addresses.clone().into_iter()) as reqwest::dns::Addrs)
        } else {
            Err(std::io::Error::other("unadmitted DNS name").into())
        };
        Box::pin(std::future::ready(result))
    }
}

fn bounded_body(mut input: impl Read, content_length: Option<u64>) -> Result<Vec<u8>> {
    if content_length.is_some_and(|length| length > BODY_LIMIT as u64) {
        return Err("too_large");
    }
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(BODY_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "network")?;
    if bytes.len() > BODY_LIMIT {
        return Err("too_large");
    }
    Ok(bytes)
}

fn fetch_hop(url: &Url, addresses: &[SocketAddr], remaining: Duration) -> Result<Hop> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(remaining)
        .connect_timeout(remaining.min(Duration::from_secs(5)))
        .dns_resolver(Arc::new(PinnedDns {
            host: url.host_str().ok_or("invalid_url")?.to_owned(),
            addresses: addresses.to_vec(),
        }))
        .build()
        .map_err(|_| "network")?;
    let response = client
        .get(url.clone())
        .header(
            header::ACCEPT,
            "text/plain, text/html, text/markdown, application/json",
        )
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                "timeout"
            } else {
                "network"
            }
        })?;
    let status = response.status().as_u16();
    if matches!(status, 301 | 302 | 303 | 307 | 308) {
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 2048)
            .ok_or("invalid_redirect")?
            .to_owned();
        return Ok(Hop {
            status,
            location: Some(location),
            content_type: String::new(),
            body: Vec::new(),
        });
    }
    if !(200..300).contains(&status) {
        return Err("http_status");
    }
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v != "identity")
    {
        return Err("unsupported_content");
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 256)
        .ok_or("unsupported_content")?
        .to_owned();
    text_kind(&content_type)?;
    let length = response.content_length();
    Ok(Hop {
        status,
        location: None,
        content_type,
        body: bounded_body(response, length)?,
    })
}

fn text_kind(content_type: &str) -> Result<bool> {
    let mut parts = content_type.split(';');
    let mime = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "text/plain"
            | "text/html"
            | "text/markdown"
            | "text/x-markdown"
            | "text/xml"
            | "text/csv"
            | "application/json"
            | "application/xml"
            | "application/xhtml+xml"
    ) {
        return Err("unsupported_content");
    }
    for part in parts {
        if let Some((key, value)) = part.trim().split_once('=')
            && key.trim().eq_ignore_ascii_case("charset")
            && !matches!(
                value.trim().trim_matches('"').to_ascii_lowercase().as_str(),
                "utf-8" | "utf8" | "us-ascii"
            )
        {
            return Err("unsupported_content");
        }
    }
    Ok(matches!(
        mime.as_str(),
        "text/html" | "application/xhtml+xml"
    ))
}

/// Bounded tag scanner; comments and script/style/template/noscript contents never enter the excerpt.
fn html_text(input: &str) -> String {
    let mut output = String::new();
    let mut rest = input;
    let mut suppressed: Option<String> = None;
    while !rest.is_empty() {
        if rest.starts_with("<!--") {
            let Some(end) = rest.find("-->") else { break };
            rest = &rest[end + 3..];
            continue;
        }
        if rest.starts_with('<') {
            let mut quote = None;
            let mut end = None;
            for (index, c) in rest.char_indices().skip(1) {
                match (quote, c) {
                    (Some(q), c) if q == c => quote = None,
                    (None, '\'' | '"') => quote = Some(c),
                    (None, '>') => {
                        end = Some(index);
                        break;
                    }
                    _ => {}
                }
            }
            let Some(end) = end else { break };
            let tag = rest[1..end].trim();
            let closing = tag.starts_with('/');
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            if suppressed.as_deref() == Some(&name) && closing {
                suppressed = None;
            } else if suppressed.is_none()
                && !closing
                && matches!(
                    name.as_str(),
                    "script" | "style" | "template" | "noscript" | "head"
                )
            {
                suppressed = Some(name);
            }
            if suppressed.is_none() {
                output.push(' ');
            }
            rest = &rest[end + 1..];
            continue;
        }
        let end = rest.find('<').unwrap_or(rest.len());
        if suppressed.is_none() {
            output.push_str(&rest[..end]);
        }
        rest = &rest[end..];
    }
    decode_entities(&output)
}

fn decode_entities(input: &str) -> String {
    let mut output = String::new();
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        rest = &rest[start..];
        let entity = rest.bytes().take(13).position(|byte| byte == b';');
        let decoded = entity.and_then(|end| {
            let value = &rest[1..end];
            match value {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => value
                    .strip_prefix("#x")
                    .or_else(|| value.strip_prefix("#X"))
                    .and_then(|n| u32::from_str_radix(n, 16).ok())
                    .or_else(|| value.strip_prefix('#').and_then(|n| n.parse().ok()))
                    .and_then(char::from_u32),
            }
        });
        if let (Some(end), Some(c)) = (entity, decoded) {
            output.push(c);
            rest = &rest[end + 1..];
        } else {
            output.push('&');
            rest = &rest[1..];
        }
    }
    output.push_str(rest);
    output
}

fn receipt(source: &Url, final_url: &Url, hop: Hop) -> Result<SourceReadResult> {
    let html = text_kind(&hop.content_type)?;
    if hop.body.len() > BODY_LIMIT {
        return Err("too_large");
    }
    let text = std::str::from_utf8(&hop.body).map_err(|_| "unsupported_content")?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("unsupported_content");
    }
    let visible = if html {
        html_text(text)
    } else {
        text.to_owned()
    };
    let mut excerpt = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    // Entity decoding may introduce control characters; never forward those.
    excerpt.retain(|c| !c.is_control());
    if excerpt.trim().is_empty() {
        return Err("unsupported_content");
    }
    let truncated = excerpt.len() > EXCERPT_LIMIT;
    let mut end = excerpt.len().min(EXCERPT_LIMIT);
    while !excerpt.is_char_boundary(end) {
        end -= 1;
    }
    excerpt.truncate(end);
    Ok(SourceReadResult {
        source_url: source.to_string(),
        final_url: final_url.to_string(),
        content_type: hop.content_type,
        bytes: hop.body.len(),
        sha256: digest(&hop.body),
        excerpt,
        truncated,
    })
}

fn read_with(
    raw: &str,
    mut lookup: impl FnMut(&Url) -> Result<Vec<SocketAddr>>,
    mut fetch: impl FnMut(&Url, &[SocketAddr], Duration) -> Result<Hop>,
) -> Result<SourceReadResult> {
    let source = normalize_url(raw)?;
    let mut url = source.clone();
    let start = Instant::now();
    for redirects in 0..=3 {
        let addresses = admit_addresses(lookup(&url)?)?;
        let remaining = TIMEOUT
            .checked_sub(start.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or("timeout")?;
        let hop = fetch(&url, &addresses, remaining)?;
        if start.elapsed() >= TIMEOUT {
            return Err("timeout");
        }
        if matches!(hop.status, 301 | 302 | 303 | 307 | 308) {
            if redirects == 3 {
                return Err("redirect_limit");
            }
            let location = hop.location.ok_or("invalid_redirect")?;
            // Validate the raw redirect too: URL joining otherwise removes whitespace and empty queries.
            if location.len() > 2048
                || location
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace())
                || location.contains('\\')
            {
                return Err("invalid_redirect");
            }
            if location
                .split_once("://")
                .map(|(_, rest)| rest)
                .or_else(|| location.strip_prefix("//"))
                .and_then(|rest| rest.trim_start_matches('/').split(['/', '?', '#']).next())
                .is_some_and(|authority| authority.contains('@'))
            {
                return Err("invalid_redirect");
            }
            let next = url.join(&location).map_err(|_| "invalid_redirect")?;
            url = normalize_url(next.as_str())?;
        } else {
            if !(200..300).contains(&hop.status) {
                return Err("http_status");
            }
            return receipt(&source, &url, hop);
        }
    }
    Err("redirect_limit")
}

/// Independent stdin/stdout mode. No profile, files, credential store, or daemon state is opened.
pub fn run_stdio() -> u8 {
    serve(std::io::stdin().lock(), std::io::stdout().lock())
}

fn serve(input: impl Read, mut output: impl Write) -> u8 {
    let mut bytes = Vec::new();
    if input.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
        return 2;
    }
    let Ok(request) = serde_json::from_slice::<Request>(&bytes) else {
        return 2;
    };
    if request.schema != SCHEMA || !extalia_core::mission::contract::is_uuid(&request.request_id) {
        return 2;
    }
    let reply = match read_with(&request.url, resolve, fetch_hop) {
        Ok(result) => {
            json!({ "schema": SCHEMA, "requestId": request.request_id, "outcome": "ok", "result": result })
        }
        Err(code) => {
            json!({ "schema": SCHEMA, "requestId": request.request_id, "outcome": "error", "code": code })
        }
    };
    match serde_json::to_vec(&reply) {
        Ok(reply) if reply.len() <= 256 * 1024 && output.write_all(&reply).is_ok() => 0,
        _ => 1,
    }
}
