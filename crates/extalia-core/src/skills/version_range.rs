//! Explicit, bounded range subset for diagnostics, not Cargo's implicit caret syntax.
//! Bare full versions are exact; partial versions match their numeric prefix. OR sets
//! contain AND comparators. Prereleases need an explicit comparator at the same core
//! version. Build metadata is ignored. Unsupported syntax always fails closed.

use super::manifest;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeError {
    InvalidVersion,
    UnsupportedRange,
}

pub fn matches(range: &str, version: &str) -> Result<bool, RangeError> {
    if !manifest::is_semver(version) {
        return Err(RangeError::InvalidVersion);
    }
    let version = semver::Version::parse(version).map_err(|_| RangeError::InvalidVersion)?;
    if !manifest::is_range(range) || range.split("||").count() > 8 {
        return Err(RangeError::UnsupportedRange);
    }
    let mut found = false;
    for set in range.split("||") {
        let parts = set.split_whitespace().collect::<Vec<_>>();
        if parts.len() > 16 {
            return Err(RangeError::UnsupportedRange);
        }
        let mut normalized = Vec::new();
        for part in parts {
            let (op, value) = [">=", "<=", ">", "<", "=", "^", "~"]
                .into_iter()
                .find_map(|op| part.strip_prefix(op).map(|value| (op, value)))
                .unwrap_or(("", part));
            let core = value.split('-').next().unwrap_or_default();
            let mut wildcard_seen = false;
            for component in core.split('.') {
                if matches!(component, "*" | "x" | "X") {
                    wildcard_seen = true;
                } else if wildcard_seen {
                    return Err(RangeError::UnsupportedRange);
                }
            }
            if wildcard_seen && (!matches!(op, "" | "=") || value.contains('-')) {
                return Err(RangeError::UnsupportedRange);
            }
            let value = if wildcard_seen {
                core.split('.')
                    .map(|part| if matches!(part, "x" | "X") { "*" } else { part })
                    .collect::<Vec<_>>()
                    .join(".")
            } else {
                value.to_owned()
            };
            // A standalone wildcard must stay unprefixed for semver::VersionReq.
            let comparator = if value == "*" && matches!(op, "" | "=") {
                value
            } else {
                format!("{}{value}", if op.is_empty() { "=" } else { op })
            };
            normalized.push(comparator);
        }
        let req = semver::VersionReq::parse(&normalized.join(", "))
            .map_err(|_| RangeError::UnsupportedRange)?;
        found |= req.matches(&version);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_partial_caret_tilde_and_build() {
        for (range, version, expected) in [
            ("1.2.3", "1.2.3+build.1", true),
            ("1.2.3", "1.2.4", false),
            ("1.2", "1.2.9", true),
            ("1", "2.0.0", false),
            ("^1.2.3", "1.9.0", true),
            ("^0.2.3", "0.3.0", false),
            ("^0.0.3", "0.0.4", false),
            ("~1.2", "1.3.0", false),
            (">=1.2.0 <2 || 3.x", "3.7.8", true),
            (">=1.2.0 <2 || 3.X", "2.0.0", false),
            ("*", "1.0.0-beta.1", false),
            (">=1.0.0-beta.1 <2", "1.0.0-beta.2", true),
            (">=1.0.0-beta.1 <2", "1.1.0-beta.2", false),
            ("=1.2.*", "1.2.99", true),
            ("1.2.3-exp", "1.2.3-exp", true),
        ] {
            assert_eq!(matches(range, version), Ok(expected), "{range} / {version}");
        }
    }

    #[test]
    fn unsupported_branch_never_short_circuits_and_input_is_bounded() {
        for range in [
            ">=1.x",
            "*.*.1",
            "^1.*",
            "1.2.3 || >x",
            "1,2",
            "1 - 2",
            "1.2.3+meta",
        ] {
            assert!(matches(range, "1.2.3").is_err(), "{range}");
        }
        assert!(matches(&["*"; 9].join(" || "), "1.2.3").is_err());
        assert!(matches(&["1"; 17].join(" "), "1.2.3").is_err());
        assert_eq!(matches("*", "01.2.3"), Err(RangeError::InvalidVersion));
    }
}
