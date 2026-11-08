# ADR 0057: Bounded Native skill discovery

Status: Implemented and verified locally v0.4.188, 2026-11-08

## Context

Grimoire can grow beyond 500 or 1,000 skills. The agent path previously reused
the 500-row inspection report, reloaded each offered skill through another full
registry listing, and repeated metadata in both the system prompt and the
`skill_read` schema. This can omit later skills, repeat index work and consume
context before the user starts useful work. The UI already has its own paged
catalog; changing its display mode does not solve Native prompt growth.

External skill authority must continue to come from the registered scanner and
active revision. An imported name, matching hash, user consent or generated
candidate alone cannot establish that authority. Production scanner availability
remains a separate open product gate.

## Decision

Use a private, immutable, turn-scoped metadata inventory, separately bounded from
the UI inspection report. Discover up to 2,048 registry rows and report an
incomplete inventory when additional rows remain beyond that bound. Preserve the canonical shipped
built-ins independently of external inventory names.

Offer a small initial preview: canonical built-ins plus at most eight external
skills selected by bounded literal relevance to the current request. Freshly
verify each external preview through the authoritative registry read. Keep the
complete escaped system catalog below 4,000 characters and report omitted items.
Metadata remains untrusted guidance and cannot grant permissions.

Provide constant-size `skill_list`, `skill_search` and `skill_read` schemas.
Discovery returns at most ten metadata entries and 4,000 JSON characters per
response, with an offset and turn snapshot for continuation. Search uses bounded
literal terms; it does not run a regular expression or claim semantic retrieval.
Do not duplicate every description or enumerate every name in a tool schema.

Before returning external metadata or instructions, recheck the active index,
source, revision and bytes through the scanner-gated read. Batch discovery shares
one fresh index scan for its selected entries. A revoked, changed or unverifiable
selection fails closed and requests a new turn; it never falls back to a legacy
file or an unverified description. Newly activated skills become discoverable in
a new turn. Reusing a turn snapshot does not authorize stale content.

The Native catalog stores frozen external metadata references, with body digests
held privately. Its initial authoritative scan reads one body at a time, converts
it to a reference and discards the body. Metadata strings are detached from source
string backing storage. Initial previews and later discovery retain references
rather than instruction bodies; selected reads still obtain fresh complete
instructions. Copies of a reference do not preserve its private expectation.
The separate legacy `activeSkills` method retains its full-body compatibility
contract and is not used by the Native catalog path.

This change adds no persistent skill-content cache, automatic activation,
background skill creation or new permissions. The initial authoritative
inventory still requires linear registry I/O and transient per-file decoding;
it is bounded rather than a claim of constant-time startup or measured process
heap savings. Existing UI pagination and report limits remain
separate contracts.

## Verification

Focused checks must cover a 1,000-skill synthetic inventory, discovery beyond the
first preview and the UI 500-row boundary, bounded prompt/tool output, stable
pagination, canonical built-ins, unsupported scanners, and active/source/revision
changes before metadata or content reads. Final independent review and the full
repository gate are recorded in the PRD tracker. Synthetic scanner fixtures do
not establish production scanner readiness or measured provider-token savings.

The reproducible [resource-contract probe](../benchmarks/native-skill-catalog-2026-11-08.md)
records serialized sizes, registry operation counts and the explicit miss beyond
2,048 raw rows. Its in-process synthetic transport is not an IPC or process-RSS
benchmark.

Full repository gate: `pnpm check` passed with 6,182 TypeScript tests, 23 optional
tests skipped, 474 Rust tests, lint/typechecks and Web/Desktop/CLI builds.
Independent review passed; real temporary-host browser checks cover Native
retrieval traces and EN/ID memory/composer controls. No paid provider was used.
