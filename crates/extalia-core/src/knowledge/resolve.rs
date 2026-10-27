//! Link resolution inside one profile (ADR 0024 §4 and its 2026-10-23 amendment).
//!
//! # Target normalization (at parse time)
//!
//! The written target (without `#heading` and `|display`) is split on `/`; empty and `.`
//! segments are dropped and `..` removes the previous segment. A target starting with
//! `./` or `../` is relative to the source note's folder, one starting with `/` is
//! relative to the vault root; both are *path-only*. A trailing `.md` (any case) is
//! removed. A relative target that climbs above the root cannot match any note. The key
//! is the Unicode lowercase of the normalized target (no Unicode normalization: names
//! compare as stored on disk).
//!
//! # Tiers, first match wins
//!
//! 1. **path**: the note's vault-relative path without `.md` equals the key.
//! 2. **path_suffix** (keys containing `/`, not path-only): the path ends with `/<key>`
//!    (Obsidian's shortest-unique-path form `[[folder/Note]]`).
//! 3. **title** (not path-only): the file name without `.md` equals the key (a note's
//!    title for linking is its file name, as in Obsidian; the first `# Heading` is only
//!    the display title, add it to `aliases` to link by it).
//! 4. **alias** (not path-only): one of the note's front matter `aliases` equals the key.
//!
//! Within the first tier that has any candidate: one candidate resolves; several
//! candidates resolve only if exactly one of them matches the written target with its
//! exact case; otherwise the link is **ambiguous** and stays unresolved with its candidates
//! (sorted by path). A lower tier is never consulted once a higher tier has candidates.
//! No candidate in any tier: **missing**. Only notes indexed for the same profile are
//! candidates, so a note of another profile (or one refused for a profile mismatch) is
//! indistinguishable from a note that does not exist. Self-links and cycles are allowed.

use std::collections::HashMap;

/// How a link was resolved, or why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Resolution {
    Path,
    PathSuffix,
    Title,
    Alias,
    Missing,
    Ambiguous,
}

impl Resolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Path => "path",
            Self::PathSuffix => "path_suffix",
            Self::Title => "title",
            Self::Alias => "alias",
            Self::Missing => "missing",
            Self::Ambiguous => "ambiguous",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "path" => Self::Path,
            "path_suffix" => Self::PathSuffix,
            "title" => Self::Title,
            "alias" => Self::Alias,
            "missing" => Self::Missing,
            "ambiguous" => Self::Ambiguous,
            _ => return None,
        })
    }
}

/// Candidates kept for an ambiguous link.
pub const MAX_CANDIDATES: usize = 16;

/// Result of resolving one link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Resolved(Resolution, String),
    Missing,
    Ambiguous(Vec<String>),
}

impl Outcome {
    pub fn resolution(&self) -> Resolution {
        match self {
            Self::Resolved(resolution, _) => *resolution,
            Self::Missing => Resolution::Missing,
            Self::Ambiguous(_) => Resolution::Ambiguous,
        }
    }
}

/// A normalized link target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub target: String,
    pub key: String,
    pub path_only: bool,
}

/// Normalize `raw` written in the note at vault-relative `source_path`.
pub fn normalize(source_path: &str, raw: &str) -> Target {
    let raw = raw.trim();
    let relative = raw == "." || raw == ".." || raw.starts_with("./") || raw.starts_with("../");
    let absolute = raw.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    if relative && let Some((dir, _)) = source_path.rsplit_once('/') {
        segments.extend(dir.split('/'));
    }
    let mut escaped = false;
    for segment in raw.split('/') {
        match segment {
            "" | "." => {}
            ".." => escaped |= segments.pop().is_none(),
            other => segments.push(other),
        }
    }
    let mut target = if escaped {
        // Starts with '.', which no indexed path segment does (hidden names are ignored).
        raw.to_owned()
    } else {
        segments.join("/")
    };
    if target.len() > 3
        && target.is_char_boundary(target.len() - 3)
        && target[target.len() - 3..].eq_ignore_ascii_case(".md")
    {
        target.truncate(target.len() - 3);
    }
    Target {
        key: target.to_lowercase(),
        target,
        path_only: relative || absolute,
    }
}

/// The lookup keys of a note: its path key, every path suffix of two or more segments,
/// its title key and its alias keys. A link whose key is in this set may resolve to it.
pub fn note_keys(path_key: &str, stem_key: &str, alias_keys: &[String]) -> Vec<String> {
    let mut keys = vec![path_key.to_owned(), stem_key.to_owned()];
    keys.extend(suffixes(path_key).map(str::to_owned));
    keys.extend(alias_keys.iter().cloned());
    keys.sort();
    keys.dedup();
    keys
}

/// Proper suffixes of `path` with at least two segments.
fn suffixes(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/')
        .map(move |(index, _)| &path[index + 1..])
        .filter(|suffix| suffix.contains('/'))
}

#[derive(Debug, Clone)]
struct Candidate {
    node_id: String,
    path: String,
    /// The matched name with its original case.
    exact: String,
}

/// An indexed note as the resolver sees it.
#[derive(Debug, Clone)]
pub struct NoteRef {
    pub node_id: String,
    /// Vault-relative path, with `.md`.
    pub path: String,
    pub aliases: Vec<String>,
}

/// Lookup tables over every indexed note of one profile.
#[derive(Debug, Default)]
pub struct Resolver {
    path: HashMap<String, Vec<Candidate>>,
    suffix: HashMap<String, Vec<Candidate>>,
    title: HashMap<String, Vec<Candidate>>,
    alias: HashMap<String, Vec<Candidate>>,
}

impl Resolver {
    pub fn new(notes: impl IntoIterator<Item = NoteRef>) -> Self {
        let mut out = Self::default();
        for note in notes {
            let exact_path = strip_md(&note.path).to_owned();
            let candidate = |exact: &str| Candidate {
                node_id: note.node_id.clone(),
                path: note.path.clone(),
                exact: exact.to_owned(),
            };
            out.path
                .entry(exact_path.to_lowercase())
                .or_default()
                .push(candidate(&exact_path));
            for suffix in suffixes(&exact_path) {
                out.suffix
                    .entry(suffix.to_lowercase())
                    .or_default()
                    .push(candidate(suffix));
            }
            let stem = exact_path.rsplit('/').next().unwrap_or(&exact_path);
            out.title
                .entry(stem.to_lowercase())
                .or_default()
                .push(candidate(stem));
            let mut seen = Vec::new();
            for alias in &note.aliases {
                let key = alias.to_lowercase();
                if !seen.contains(&key) {
                    out.alias
                        .entry(key.clone())
                        .or_default()
                        .push(candidate(alias));
                    seen.push(key);
                }
            }
        }
        out
    }

    pub fn resolve(&self, target: &Target) -> Outcome {
        let mut tiers: Vec<(Resolution, &HashMap<String, Vec<Candidate>>)> =
            vec![(Resolution::Path, &self.path)];
        if !target.path_only {
            if target.key.contains('/') {
                tiers.push((Resolution::PathSuffix, &self.suffix));
            }
            tiers.push((Resolution::Title, &self.title));
            tiers.push((Resolution::Alias, &self.alias));
        }
        for (resolution, table) in tiers {
            let Some(candidates) = table.get(&target.key).filter(|list| !list.is_empty()) else {
                continue;
            };
            if let [only] = candidates.as_slice() {
                return Outcome::Resolved(resolution, only.node_id.clone());
            }
            let exact: Vec<&Candidate> = candidates
                .iter()
                .filter(|candidate| candidate.exact == target.target)
                .collect();
            if let [only] = exact.as_slice() {
                return Outcome::Resolved(resolution, only.node_id.clone());
            }
            let mut sorted: Vec<&Candidate> = candidates.iter().collect();
            sorted.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
            return Outcome::Ambiguous(
                sorted
                    .into_iter()
                    .take(MAX_CANDIDATES)
                    .map(|candidate| candidate.node_id.clone())
                    .collect(),
            );
        }
        Outcome::Missing
    }
}

/// `path` without its `.md` extension (notes always have one).
pub fn strip_md(path: &str) -> &str {
    if path.len() > 3
        && path.is_char_boundary(path.len() - 3)
        && path[path.len() - 3..].eq_ignore_ascii_case(".md")
    {
        &path[..path.len() - 3]
    } else {
        path
    }
}
