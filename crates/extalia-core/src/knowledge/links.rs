//! Wikilink parser for a note body.
//!
//! Recognized, on one line: `[[Target]]`, `[[Target|display]]`, `[[Target#Heading]]`,
//! `[[Target#^block]]` (kept as heading `^block`), `[[folder/Target]]`, relative
//! `[[./Sibling]]` / `[[../Up]]`, vault-absolute `[[/Folder/Target]]`, and embeds
//! `![[...]]` (stored as links with `embed`). Inside a link `\|` is the display separator
//! (Obsidian's table form).
//!
//! Not links: anything in a fenced code block (```` ``` ```` or `~~~`, up to three spaces
//! of indent, closed by a fence of the same character at least as long; an unclosed fence
//! runs to the end of the note), anything in an inline code span (a backtick run closed by
//! a run of the same length on the same line), a bracket escaped with `\` (`\[[x]]`), a
//! link whose target is empty (`[[#Heading]]`, same note) or longer than 512 bytes, and an
//! unclosed `[[`. Indented code blocks, HTML comments and `%%` comments are not detected
//! (Obsidian lists often indent four spaces).
//!
//! Edge types come from a line label before the first `:` of the line, ignoring list
//! markers, `**`/`__` and case: `Related:` → `related_to`, `Learned from:` →
//! `learned_from`, `Depends on:` → `depends_on`, `Supersedes:` → `supersedes`,
//! `Used by:` → `used_by` (`_`/`-` count as spaces, so `learned_from:` works too). Every
//! link on such a line has that type; all other links are `links_to`.
//!
//! The note's display title is its first ATX level-1 heading (`# Title`) outside code.

pub const MAX_LINK_BYTES: usize = 512;
const MAX_TITLE_BYTES: usize = 512;

/// Typed edge kinds (ADR 0024 §4 plus plain wikilinks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeType {
    LinksTo,
    RelatedTo,
    LearnedFrom,
    DependsOn,
    Supersedes,
    UsedBy,
}

impl EdgeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LinksTo => "links_to",
            Self::RelatedTo => "related_to",
            Self::LearnedFrom => "learned_from",
            Self::DependsOn => "depends_on",
            Self::Supersedes => "supersedes",
            Self::UsedBy => "used_by",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "links_to" => Self::LinksTo,
            "related_to" => Self::RelatedTo,
            "learned_from" => Self::LearnedFrom,
            "depends_on" => Self::DependsOn,
            "supersedes" => Self::Supersedes,
            "used_by" => Self::UsedBy,
            _ => return None,
        })
    }
}

/// One link occurrence, as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Target part, trimmed, without `#heading` and `|display`.
    pub target: String,
    pub heading: Option<String>,
    pub display: Option<String>,
    pub embed: bool,
    pub edge_type: EdgeType,
    /// 1-based line in the file.
    pub line: u32,
}

/// Links and display title of a body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    pub title: Option<String>,
    pub links: Vec<Link>,
}

/// Parse `body`, whose first line is line `first_line` of the file.
pub fn parse(body: &str, first_line: u32) -> Parsed {
    let mut out = Parsed::default();
    let mut fence: Option<(char, usize)> = None;
    for (index, raw) in body.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let number = first_line.saturating_add(u32::try_from(index).unwrap_or(u32::MAX));
        if let Some((ch, len)) = fence {
            if let Some((close_ch, close_len, rest)) = fence_marker(line)
                && close_ch == ch
                && close_len >= len
                && rest.trim().is_empty()
            {
                fence = None;
            }
            continue;
        }
        if let Some((ch, len, rest)) = fence_marker(line)
            && !(ch == '`' && rest.contains('`'))
        {
            fence = Some((ch, len));
            continue;
        }
        if out.title.is_none() {
            out.title = heading_title(line);
        }
        let edge_type = line_label(line).unwrap_or(EdgeType::LinksTo);
        scan_line(line, number, edge_type, &mut out.links);
    }
    out
}

/// `(char, length, info string)` when the line opens or closes a fence.
fn fence_marker(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next().filter(|ch| matches!(ch, '`' | '~'))?;
    let len = rest.len() - rest.trim_start_matches(ch).len();
    (len >= 3).then(|| (ch, len, &rest[len..]))
}

fn heading_title(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = line[indent..].strip_prefix('#')?;
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let mut text = rest.trim();
    let without_closing = text.trim_end_matches('#');
    if without_closing.is_empty() || without_closing.ends_with([' ', '\t']) {
        text = without_closing.trim_end();
    }
    if text.is_empty() {
        return None;
    }
    Some(clip(text, MAX_TITLE_BYTES))
}

/// Cut at a character boundary to at most `max` bytes.
pub fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn line_label(line: &str) -> Option<EdgeType> {
    let (prefix, _) = line.split_once(':')?;
    if prefix.len() > 48 || prefix.contains(['[', '`', '\\']) {
        return None;
    }
    let mut text = prefix.trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = text.strip_prefix(marker) {
            text = rest;
            break;
        }
    }
    if let Some((number, rest)) = text.split_once(". ")
        && !number.is_empty()
        && number.bytes().all(|byte| byte.is_ascii_digit())
    {
        text = rest;
    }
    let label: String = text
        .trim()
        .trim_matches(['*', '_'])
        .chars()
        .map(|ch| if ch == '_' || ch == '-' { ' ' } else { ch })
        .collect::<String>()
        .to_lowercase();
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(match label.as_str() {
        "related" | "related to" => EdgeType::RelatedTo,
        "learned from" => EdgeType::LearnedFrom,
        "depends on" => EdgeType::DependsOn,
        "supersedes" => EdgeType::Supersedes,
        "used by" => EdgeType::UsedBy,
        _ => return None,
    })
}

fn scan_line(line: &str, number: u32, edge_type: EdgeType, links: &mut Vec<Link>) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'`' => {
                let run = bytes[index..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                index += run;
                if let Some(close) = closing_run(bytes, index, run) {
                    index = close + run;
                }
            }
            b'[' if bytes.get(index + 1) == Some(&b'[') => {
                let embed = index > 0 && bytes[index - 1] == b'!' && !escaped(bytes, index - 1);
                let start = index + 2;
                match line[start..].find("]]") {
                    Some(offset) => {
                        let content = &line[start..start + offset];
                        if let Some(inner) = content.rfind("[[") {
                            // `[[a [[b]]`: only the innermost opening can be a link.
                            index = start + inner;
                            continue;
                        }
                        if let Some(link) = link(content, embed, edge_type, number) {
                            links.push(link);
                        }
                        index = start + offset + 2;
                    }
                    None => index = start,
                }
            }
            _ => index += 1,
        }
    }
}

/// Whether the byte at `index` is preceded by an odd number of backslashes.
fn escaped(bytes: &[u8], index: usize) -> bool {
    bytes[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count()
        % 2
        == 1
}

/// Start of the next backtick run of exactly `run` bytes at or after `from`.
fn closing_run(bytes: &[u8], from: usize, run: usize) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let len = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            if len == run {
                return Some(index);
            }
            index += len;
        } else {
            index += 1;
        }
    }
    None
}

fn link(content: &str, embed: bool, edge_type: EdgeType, line: u32) -> Option<Link> {
    if content.len() > MAX_LINK_BYTES {
        return None;
    }
    let (target_part, display) = match content.find('|') {
        Some(bar) => {
            let target = &content[..bar];
            let target = target.strip_suffix('\\').unwrap_or(target);
            (target, Some(&content[bar + 1..]))
        }
        None => (content, None),
    };
    let (target, heading) = match target_part.split_once('#') {
        Some((target, heading)) => (target, Some(heading)),
        None => (target_part, None),
    };
    let target = target.trim();
    if target.is_empty() || target.chars().any(char::is_control) {
        return None;
    }
    let non_empty = |text: Option<&str>| {
        text.map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Some(Link {
        target: target.to_owned(),
        heading: non_empty(heading),
        display: non_empty(display),
        embed,
        edge_type,
        line,
    })
}
