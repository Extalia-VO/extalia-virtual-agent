# ADR 0048: Read-only skill routing in the application

Status: Verified locally v0.4.154, 2026-10-31
Tracking: FR-15, V2-16 / issue #54; extends ADR 0040

## Context

The registry already provides bounded eligibility-first routing over explicit
revisions, but the application exposes only dependency preflight. Built-in
catalogue categories describe the bundled library; they do not select or execute
registered skills. Runtime activation, scanner verification and permission
resolution remain separate gates.

## Decision

Add optional `skill.routingPreview` to the daemon and optional
`previewSkillRouting` to the host API. The registry report advertises support
only when the connected daemon serves the operation. The frozen hello vocabulary
stays unchanged; older registries retain their existing preflight and lifecycle
features without this preview.

Requests name explicit category/intent selectors, up to sixteen exact candidate
revisions, explicit dependency pins, an optional known host workspace and a
one-to-sixteen result limit. The host verifies workspace membership without
requiring a project folder. The daemon supplies its own policy context with empty
runtime facts and an empty diagnostic permission ceiling. No latest-version
lookup, inferred pins, built-in exemption, scanner run or lifecycle write occurs.

Results echo the validated request and retain all four core outcomes: invalid,
no eligible match in this request, matched and ambiguous. Scores, actual match
rationale, dependency-before-dependent orderings, exclusions and omitted counts
stay bounded and sanitized. Top-tie counts survive result truncation. Every
report has literal `dispatchEligible: false`; no result reaches a model or
authorizes a tool call.

Strict TS/schema/Rust validation bounds the response to 512 KiB, checks requested
identities, score/rationale relationships, ordering and counts, and requires one
consistent full identity per exact revision throughout all roots, exclusions and
dependency plans. Different revisions of one package may legitimately occur in
different diagnostic roles; a shared exact revision cannot contradict itself.

## Application behavior

The Skills Security Center offers explicit category/intent fields, candidate
checkboxes, optional workspace applicability, exact dependency pin selectors and
a result limit. It starts with no candidates or pins selected. One revision per
candidate package is selectable; missing pins remain blockers. Imported scanner
requirements and the separate built-in library remain visible.

Results and errors are discarded on every input change and on host, registry,
scanner/policy, capability or workspace-catalog changes. A keyed host boundary
prevents the old host's catalog and pending actions appearing under its
replacement. English/Indonesian controls show ambiguity even for one displayed
result, partial-catalog notices, omitted diagnostics and the absence of execution
authority. No automatic preview or activation occurs.

## Verification and remaining work

Shared wire fixtures, real temporary registry/daemon/host tests and UI tests cover
inactive candidates, missing pins, workspace applicability, stale/tampered
context, ambiguity and limits. Table snapshots prove that previews do not alter
skill state. Independent review found contradictory identities across plans;
both validators now reject them, with pre-fix reproduction and shared negative
and valid repeated-dependency fixtures.

Browser checks use synthetic data in actual components for EN/light desktop and
ID/dark phone layouts, explicit choices, stale success/error/finally and host
replacement. Backend tests independently exercise real temporary stores. Full
`pnpm check` passes: 343 TypeScript suites/5,173 tests (one suite/five tests
skipped), 452 Rust tests, formatting/strict Clippy, schema/boundary/type checks
and Web/Desktop/CLI builds. The first gate found a test importing fixture JSON
across package boundaries; it now loads fixture data through the filesystem,
without a checker exception, and the full rerun passes. Browser/server and
temporary preview source were closed/removed. No live-provider or cross-platform
release certification is claimed.

This does not activate the Rust router in Native Chat or mission workers. Native
Chat and its normal team workers already have on-demand skill reads through
existing consent/registry rules; mission-worker parity needs its own source,
workspace and local-operation coverage review. Production scanner/Python,
effect-time grants, routing receipts and V2-16 acceptance remain open.
