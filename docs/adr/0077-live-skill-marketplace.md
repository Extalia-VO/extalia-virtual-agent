# ADR 0077: Independently refreshed skill marketplace

Status: Accepted — 2026-11-12

## Context

The Grimoire already lists shipped, project and registered skills, but adding a
discoverable community skill should not require a new Extalia application release.
Remote source metadata is untrusted and cannot grant activation or execution.

## Decision

Add an explicitly requested public catalog search and an immutable package review.
Use the anonymous skills.sh search endpoint used by its official CLI as a
best-effort discovery adapter. This legacy endpoint is not a stable API contract;
bounded cached results and direct public GitHub repository selection remain useful
when search is unavailable. Do not claim support for the authenticated API v1.

An isolated Rust daemon mode owns HTTP, response parsing, private search caching,
GitHub commit resolution, bounded regular-file downloads and reviewed staging.
It never launches an upstream installer. The host supervises child lifetimes and
imports receipts; React displays results and explicit actions. This retains the
existing registry and avoids buffering remote file payloads in the renderer.
This placement does not claim a measured end-to-end speed improvement.

Preview resolves one immutable public GitHub commit and records file hashes and
the canonical Extalia tree digest. Import rechecks that digest after the registry
seals its own copy, before registration or inspection. A changed source therefore
cannot inherit approval for previously reviewed bytes. Imported packages use the
existing imported origin and scanner, review, approval and activation lifecycle.
Catalog presence or popularity is not scanner evidence.

Rust resolves the package manifest over the final preview tree, using the same
resolver and non-executable staged modes as registry import. Preview includes
package ID/version, inferred-manifest status, risk class, declared permissions
and unevaluated runtime requirements. Invalid manifests are refused before
saving a review. Up to 32 permission rows and 16 compatibility rows are shown,
with total counts for omitted rows. Older market engines omit these declarations.

Search sends only its explicit query; preview sends the chosen public repository
and revision requests. Workspace files, conversation context, provider credentials
and user home configuration are excluded. Network/body/file counts, time, review
lifetime and cache size stay bounded; redirects and ambient proxy credentials are
disabled. Remote text is displayed as plain text.

## Consequences

Catalog metadata and selected package revisions can change independently of the
application version. Existing installed skill revisions keep their own identities.
Updates are new explicit previews and imports, never automatic activation.
Unsupported scanner platforms continue to quarantine imports. Private repositories,
marketplace authentication and arbitrary installer commands remain outside this
first public-source adapter.

## Bounds and provenance

One-shot requests are at most 16 KiB and metadata replies 128 KiB. Search returns
at most 50 entries and caches 64 queries for five minutes before refresh. A review
expires after ten minutes; at most 32 reviews and 32 stages are retained. An
individual package has at most 128 files, 512 KiB per file and 2 MiB total.
Repository tree responses and all network bytes also have independent limits
(6 MiB and 8 MiB). The 45-second request deadline is supervised by a child-close
owner. Local operations retain ownership through actual close and registry drain.

CoreStore schema 14 records sources in the same transaction as import, including
identical content seen at later pinned commits. Its append-only guards also block
SQLite replacement. No legacy per-revision provenance is fabricated. The source
view returns at most 20 records with total and omission counts; a revision admits
at most 256 distinct sources. Marketplace repository/directory identities cannot
claim an existing package from another source or origin.

The host keeps original review pins in RAM, compares them with Rust staging,
then supplies the expected canonical digest to registry import. A host restart
requires a fresh preview. This prevents a self-consistently changed cache from
replacing user-reviewed bytes. Standard pre-migration backups remain in effect;
older binaries refuse schema 14.

## Verification

The v0.4.283 full check passed with 9,149 TypeScript tests, Rust tests, formatting,
Clippy, type checks, public-safety/ownership checks and Web/Desktop/CLI builds.
Focused cases cover malformed and correlated replies, expiry, cancellation,
physical child close, stale/offline caches, portable paths, symlinks, hard links,
payload drift, exact canonical hashes, source conflicts and durable provenance.

Actual public-source tests used temporary profiles for search, preview, staging,
registry import, restart and duplicate import. The candidate stayed quarantined
with the test scanner unavailable; no approval or activation was inferred.
A separate macOS ARM64 temporary-profile run used the pinned SkillSpector 2.13.4
bundle. A public skill and a benign fixture completed inspection, refused
activation before approval, and persisted explicit activation and provenance
after restart. The scanner inventory matched its manifest after both scans.
Windows, Linux and packaged-release acceptance remain open.
Synthetic React browser tests cover explicit requests, no mount network activity,
exact skill IDs, retained import ownership, cleanup sequencing, English/light
desktop and Indonesian/dark mobile layouts. They do not certify external scanner
platforms or actual Desktop resource use.

See the [user workflow](../getting-started/skill-marketplace.md).

The v0.4.287 combined check passed with 9,198 TypeScript and 576 Rust tests.
Focused manifest cases cover declared capabilities, bounded omission counts,
normalized range display, inferred metadata, and refusal before persistence.
A public immutable package returned its inferred manifest through the actual
Rust supervisor. EN/light and ID/dark browser previews displayed the declaration
fields, with a 390-pixel viewport and no horizontal overflow.

## Discovery references

The [official CLI search implementation](https://github.com/vercel-labs/skills/blob/e781cb4d07433dfe1d19e924ed45cc61738c55ec/src/find.ts) uses the anonymous legacy search route. The [published API documentation](https://www.skills.sh/docs/api) describes a separate authenticated API v1; its credentials and quota are not assumed by this adapter.
