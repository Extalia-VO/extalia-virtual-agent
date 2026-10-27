//! Minimal, strict front matter parser (a small YAML subset).
//!
//! A note has front matter only when its first line is exactly `---`; the block ends at
//! the next line that is `---` or `...`. An unterminated block is invalid.
//!
//! Accepted inside the block, one key per line at column 0 (`[A-Za-z_][A-Za-z0-9_-]*:`):
//!
//! - a scalar: plain (`value`, a trailing ` # comment` is removed), single quoted
//!   (`'it''s'`) or double quoted (escapes `\\ \" \n \t \/` only);
//! - a flow sequence of scalars: `[a, "b c", 'd']`;
//! - an empty value followed by a block sequence: lines `- item` (indented or not);
//! - `null`, `~` or nothing: absent.
//!
//! Blank lines and `#` comment lines are ignored. Known keys are typed and validated:
//! `id`, `kind`, `profile`, `verification`, `source_task_ids`, `revision`, `aliases`,
//! `tags`. Any other key is preserved by name in [`FrontMatter::extra_keys`] and its value
//! is ignored, including nested or block-scalar values (indented continuation lines).
//! Anything else (a duplicate key, anchors, tags, a block scalar or mapping as the value of
//! a known key, an invalid value) makes the whole block invalid: the note is skipped and
//! reported, never indexed with guessed metadata. Front matter is untrusted data
//! (ADR 0027): `verification` is a mirror only and never changes trust.

use crate::skills::ProfileId;

const MAX_LIST_ITEMS: usize = 64;
const MAX_ALIAS_BYTES: usize = 256;
const MAX_TAG_BYTES: usize = 128;
const MAX_TASK_ID_BYTES: usize = 128;

/// Parsed front matter. Absent keys are `None` or empty.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrontMatter {
    /// `^[a-z0-9][a-z0-9._-]{0,127}$`, for example `know.laravel.n-plus-one`.
    pub id: Option<String>,
    /// `^[a-z][a-z0-9_-]{0,31}$`, for example `knowledge`, `experience`, `memory`.
    pub kind: Option<String>,
    pub profile: Option<ProfileId>,
    /// Declared verification, a mirror of core evidence only (ADR 0027 §3).
    pub verification: Option<String>,
    pub source_task_ids: Vec<String>,
    pub revision: Option<u32>,
    pub aliases: Vec<String>,
    /// Without a leading `#`.
    pub tags: Vec<String>,
    /// Names of other keys, in order of appearance; their values are ignored.
    pub extra_keys: Vec<String>,
}

/// A note split into its front matter and body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split<'a> {
    pub front_matter: FrontMatter,
    pub body: &'a str,
    /// 1-based line number of the first body line in the file.
    pub body_first_line: u32,
}

/// Why front matter was refused (reported as `invalid_front_matter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidFrontMatter;

/// Split `text` (already without a byte order mark) into front matter and body.
pub fn split(text: &str) -> Result<Split<'_>, InvalidFrontMatter> {
    let Some(first_end) = line_end(text, 0) else {
        return Ok(no_front_matter(text));
    };
    if trim_eol(&text[..first_end]) != "---" {
        return Ok(no_front_matter(text));
    }
    let mut lines = Vec::new();
    let mut start = first_end;
    loop {
        if start >= text.len() {
            return Err(InvalidFrontMatter);
        }
        let end = line_end(text, start).unwrap_or(text.len());
        let line = trim_eol(&text[start..end]);
        if line.trim_end() == "---" || line.trim_end() == "..." {
            let front_matter = parse_block(&lines)?;
            let line_count = u32::try_from(lines.len() + 2).map_err(|_| InvalidFrontMatter)?;
            return Ok(Split {
                front_matter,
                body: &text[end..],
                body_first_line: line_count + 1,
            });
        }
        lines.push(line);
        start = end;
    }
}

fn no_front_matter(text: &str) -> Split<'_> {
    Split {
        front_matter: FrontMatter::default(),
        body: text,
        body_first_line: 1,
    }
}

/// Byte index just after the `\n` ending the line that starts at `start`, if any.
fn line_end(text: &str, start: usize) -> Option<usize> {
    text[start..].find('\n').map(|index| start + index + 1)
}

fn trim_eol(line: &str) -> &str {
    line.trim_end_matches('\n').trim_end_matches('\r')
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Null,
    Scalar(String),
    Seq(Vec<String>),
    /// Value of an unknown key that is not in the subset (mapping, block scalar, ...).
    Opaque,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    None,
    /// Known key with an empty value: block sequence items may follow.
    Known,
    /// Unknown key: indented continuation lines are ignored.
    Unknown,
}

fn parse_block(lines: &[&str]) -> Result<FrontMatter, InvalidFrontMatter> {
    let mut entries: Vec<(String, Value)> = Vec::new();
    let mut pending = Pending::None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indented = line.starts_with([' ', '\t']);
        if trimmed == "-" || trimmed.starts_with("- ") {
            match pending {
                Pending::Known => {
                    let item = scalar(trimmed[1..].trim())?;
                    let Some((_, value)) = entries.last_mut() else {
                        return Err(InvalidFrontMatter);
                    };
                    let Some(item) = item else {
                        return Err(InvalidFrontMatter);
                    };
                    match value {
                        Value::Null => *value = Value::Seq(vec![item]),
                        Value::Seq(items) => items.push(item),
                        _ => return Err(InvalidFrontMatter),
                    }
                    continue;
                }
                Pending::Unknown => continue,
                Pending::None => return Err(InvalidFrontMatter),
            }
        }
        if indented {
            if pending == Pending::Unknown {
                continue;
            }
            return Err(InvalidFrontMatter);
        }
        let (key, rest) = line.split_once(':').ok_or(InvalidFrontMatter)?;
        if !is_key(key) || entries.iter().any(|(existing, _)| existing == key) {
            return Err(InvalidFrontMatter);
        }
        let rest = rest.trim();
        let known = is_known(key);
        let value = if rest.is_empty() {
            Value::Null
        } else if rest.starts_with('[') {
            match flow_sequence(rest) {
                Ok(items) => Value::Seq(items),
                Err(error) if known => return Err(error),
                Err(_) => Value::Opaque,
            }
        } else {
            match scalar(rest) {
                Ok(Some(text)) => Value::Scalar(text),
                Ok(None) => Value::Null,
                Err(error) if known => return Err(error),
                Err(_) => Value::Opaque,
            }
        };
        pending = match (known, rest.is_empty(), &value) {
            (true, true, _) => Pending::Known,
            (false, _, _) => Pending::Unknown,
            _ => Pending::None,
        };
        entries.push((key.to_owned(), value));
    }
    typed(entries)
}

fn is_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_known(key: &str) -> bool {
    matches!(
        key,
        "id" | "kind"
            | "profile"
            | "verification"
            | "source_task_ids"
            | "revision"
            | "aliases"
            | "tags"
    )
}

/// One scalar; `None` for `null`, `~` or an empty value.
fn scalar(text: &str) -> Result<Option<String>, InvalidFrontMatter> {
    let text = text.trim();
    if let Some(inner) = text.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = inner.chars();
        loop {
            match chars.next() {
                None => return Err(InvalidFrontMatter),
                Some('"') => break,
                Some('\\') => out.push(match chars.next() {
                    Some('\\') => '\\',
                    Some('"') => '"',
                    Some('/') => '/',
                    Some('n') => '\n',
                    Some('t') => '\t',
                    _ => return Err(InvalidFrontMatter),
                }),
                Some(other) => out.push(other),
            }
        }
        return rest_is_comment(chars.as_str())
            .then_some(Some(out))
            .ok_or(InvalidFrontMatter);
    }
    if let Some(inner) = text.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        loop {
            match chars.next() {
                None => return Err(InvalidFrontMatter),
                Some('\'') if chars.peek() == Some(&'\'') => {
                    chars.next();
                    out.push('\'');
                }
                Some('\'') => break,
                Some(other) => out.push(other),
            }
        }
        let rest: String = chars.collect();
        return rest_is_comment(&rest)
            .then_some(Some(out))
            .ok_or(InvalidFrontMatter);
    }
    let plain = match text.find(" #") {
        Some(index) => text[..index].trim_end(),
        None => text,
    };
    // `key: # comment` is a null value in YAML.
    if plain.is_empty() || plain == "~" || plain == "null" || plain.starts_with('#') {
        return Ok(None);
    }
    if plain.starts_with(['&', '*', '!', '%', '@', '`', '|', '>', '{', '[', ']', '}'])
        || plain.contains(": ")
    {
        return Err(InvalidFrontMatter);
    }
    Ok(Some(plain.to_owned()))
}

fn rest_is_comment(rest: &str) -> bool {
    let rest = rest.trim();
    rest.is_empty() || rest.starts_with('#')
}

/// `[a, "b", 'c']`: scalars separated by commas outside quotes.
fn flow_sequence(text: &str) -> Result<Vec<String>, InvalidFrontMatter> {
    let inner = text.strip_prefix('[').ok_or(InvalidFrontMatter)?;
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = inner.chars();
    let mut closed = false;
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some('"'), '\\') => {
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (Some(open), _) if ch == open => {
                quote = None;
                current.push(ch);
            }
            (Some(_), _) => current.push(ch),
            (None, '"' | '\'') => {
                quote = Some(ch);
                current.push(ch);
            }
            (None, ',') => {
                items.push(std::mem::take(&mut current));
            }
            (None, ']') => {
                closed = true;
                break;
            }
            (None, '[' | '{') => return Err(InvalidFrontMatter),
            (None, _) => current.push(ch),
        }
    }
    if !closed || !rest_is_comment(chars.as_str()) {
        return Err(InvalidFrontMatter);
    }
    if !current.trim().is_empty() || !items.is_empty() {
        items.push(current);
    }
    let mut out = Vec::new();
    for item in items {
        match scalar(&item)? {
            Some(value) => out.push(value),
            None => return Err(InvalidFrontMatter),
        }
    }
    Ok(out)
}

fn typed(entries: Vec<(String, Value)>) -> Result<FrontMatter, InvalidFrontMatter> {
    let mut out = FrontMatter::default();
    for (key, value) in entries {
        match key.as_str() {
            "id" => out.id = single(value, is_note_id)?,
            "kind" => out.kind = single(value, |text| is_word(text, 32))?,
            "verification" => out.verification = single(value, |text| is_word(text, 32))?,
            "profile" => {
                out.profile = single(value, |text| ProfileId::parse(text).is_some())?
                    .and_then(|text| ProfileId::parse(&text));
            }
            "revision" => {
                out.revision = single(value, |text| {
                    !text.is_empty()
                        && text.len() <= 9
                        && text.bytes().all(|byte| byte.is_ascii_digit())
                })?
                .map(|text| text.parse::<u32>().map_err(|_| InvalidFrontMatter))
                .transpose()?;
            }
            "source_task_ids" => {
                out.source_task_ids = list(value, |text| {
                    text.len() <= MAX_TASK_ID_BYTES && !text.chars().any(char::is_control)
                })?;
            }
            "aliases" => {
                out.aliases = list(value, |text| {
                    text.len() <= MAX_ALIAS_BYTES
                        && !text.chars().any(char::is_control)
                        && !text.contains(['[', ']', '|', '#'])
                })?;
            }
            "tags" => {
                out.tags = list(value, |text| {
                    let tag = text.strip_prefix('#').unwrap_or(text);
                    !tag.is_empty()
                        && tag.len() <= MAX_TAG_BYTES
                        && !tag.chars().any(|ch| ch.is_whitespace() || ch.is_control())
                })?
                .into_iter()
                .map(|tag| tag.strip_prefix('#').unwrap_or(&tag).to_owned())
                .collect();
            }
            _ => out.extra_keys.push(key),
        }
    }
    Ok(out)
}

fn single(
    value: Value,
    valid: impl Fn(&str) -> bool,
) -> Result<Option<String>, InvalidFrontMatter> {
    match value {
        Value::Null => Ok(None),
        Value::Scalar(text) if valid(&text) => Ok(Some(text)),
        _ => Err(InvalidFrontMatter),
    }
}

/// A sequence, or a single scalar as a one-item list (Obsidian accepts both).
fn list(value: Value, valid: impl Fn(&str) -> bool) -> Result<Vec<String>, InvalidFrontMatter> {
    let items = match value {
        Value::Null => Vec::new(),
        Value::Scalar(text) => vec![text],
        Value::Seq(items) => items,
        Value::Opaque => return Err(InvalidFrontMatter),
    };
    if items.len() > MAX_LIST_ITEMS
        || items
            .iter()
            .any(|item| item.trim().is_empty() || !valid(item))
    {
        return Err(InvalidFrontMatter);
    }
    Ok(items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .collect())
}

/// Front matter note id: `^[a-z0-9][a-z0-9._-]{0,127}$` (no `:`, so it never collides with
/// a derived `path:` id).
pub fn is_note_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn is_word(text: &str, max: usize) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}
