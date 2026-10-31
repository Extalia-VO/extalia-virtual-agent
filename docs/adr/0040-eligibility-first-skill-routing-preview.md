# ADR 0040: Eligibility-first skill routing preview

Status: Verified locally in v0.4.139 for read-only Rust core diagnostics, 2026-10-30.
Application diagnostics are added separately in [ADR 0048](0048-skill-routing-application-preview.md).
Tracking: FR-15 and [V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).
Extends [ADR 0039](0039-read-only-skill-dependency-preflight.md), with no new execution authority.

## Scope and inputs

Add pure `routing::preview` and `SkillRegistry::routing_preview` library APIs.
The result is a bounded diagnostic ordering of explicitly supplied immutable
candidates. No daemon/host/UI/runtime consumer is added, no skill content is
offered to a model, and no approval or activation behavior changes. Existing
`resolver_unavailable` and scanner gates stay closed.

Inputs are structured category and intent selectors, at most sixteen exact
candidate revisions with distinct package IDs, explicit dependency pins, complete
ambient active context, runtime-fact claims, a literal permission ceiling and
one-to-sixteen requested results. Empty selectors are invalid, never select-all.
No prompt inference, highest-version lookup, auto-pinning, alias expansion or
related-category traversal is introduced.

Public pure inputs are claims, including active availability. Registry inputs
instead name exact revisions in the registry's existing profile. The adapter
reconstructs manifests from verified staged bytes and actual approval-bound
inspection/pointer observations. Built-in registrations are separate from
revision rows and receive no scanner exemption through this API.

## Eligibility and workspace applicability

Only an active root can enter ranking; inspected but inactive roots are excluded.
Deprecated revisions remain eligible only while their authoritative activation
pointer remains. Each matched candidate must have a consistent exact-pin
dependency preflight over the complete ambient context. Unknown facts, permission
overflow, missing/inactive/unavailable dependencies, cycles and conflicts deny
eligibility. A routing candidate cannot hypothetically replace a different
ambient active revision of the same package, even though dependency preflight
supports that diagnostic use case.

The registry adapter additionally reads each active root/pin's actual approval
workspace scope. A workspace-scoped approval must exactly match the supplied
workspace; absent context never satisfies a scoped approval. An unscoped approval
has profile-wide applicability for this diagnostic check. The input workspace ID
is syntax-checked, not resolved as proof of workspace existence or ownership.
Facts and ceilings likewise remain caller claims, not detected host facts or
permission grants.

Scope filtering changes cloned candidate/pin availability only. Unrelated ambient
packages remain in the global active context, including packages approved for
another workspace: their conflicts and reverse constraints must not disappear.
An ambient pointer whose current inspection is unavailable/stale invalidates
the context and yields no candidates; it is not silently dropped or marked active.

## Matching, ranking and ambiguity

Categories are ORed, intents are ORed, and populated dimensions are ANDed.
Categories match exactly or from a requested parent to a declared descendant
at a dot boundary: `quality` matches `quality.review`, while `quality.reviews`
does not match `quality.review`. A generic declared parent does not satisfy a
more specific requested child. All metadata is bounded and validated before
matching; only eligible matches enter ranking.

Ranking is a deterministic descending integer tuple: exact-intent matches,
exact-category matches, then distinct requested categories with descendant
matches. The last component counts selectors rather than declared leaves, so
adding dozens of leaves below one parent does not inflate the score. Equal
scores sort by package/revision identity for reproducibility only. Top ties
remain `Ambiguous`, even when the caller asks to display one result.

Reports distinguish `Invalid`, `NoSafeSkill`, `Matched` and `Ambiguous`, with
eligible/top-tie counts, exact identities, actual match rationale, dependency
orderings and structured exclusions. None is an executable selection:
`dispatch_eligible()` permanently returns false. `NoSafeSkill` describes this
bounded diagnostic request, not a claim about every installed skill.

## One bounded read view

Extract ADR 0039's private source reader into `registry/snapshot.rs`. Both APIs
use one deferred SQL transaction and share the same revision cache and cumulative
32 MiB read budget across roots, pins and the complete active context. Do not
call independent public preflights per root, which would observe different
transactions and repeatedly hash sources. Existing per-tree limits, 128 distinct
revision cap, safe path construction, canonical metadata comparison and pure
availability checks are preserved. Routing applies scope through a separate
cloned observation; the existing dependency-preflight surface stays unscoped.

Hard bounds include sixteen candidates, 32 selectors per dimension, 128 graph
IDs, 512 relation edges and depth 32. Context and metadata limits precede cloning
or canonicalization. Rationale retains at most 32 descendant pairs per candidate,
with explicit truncation; scores use the full bounded match set. Exclusions
retain at most 32 sanitized diagnostics each and 128 across the report, with
omission counts. No source text, paths, permission scopes, arbitrary parser
messages or runtime fact values enter these diagnostics.

## Verification and remaining work

Pure tests cover permutations, invalid graph bounds, inactive/unsafe high-score
candidates, explicit dependency pins, full ambient constraints, exact hierarchy
boundaries, both selector dimensions, tie/truncation behavior and output bounds.
Temporary-profile adapter tests cover real source/index disagreement, deprecated
pointers, root/dependency scope, foreign-scoped ambient conflicts, stale context,
tampering, foreign/built-in sources and early input refusal. Every adapter call
compares all skill table contents before/after. Existing preflight regressions
verify the shared reader's prior behavior.

These observations are not durable filesystem or execution authority. Future
runtime routing still needs trusted category inference/index lookup, profile/agent
ACL and capability resolution, verified facts/grants, governed aliases, built-in
source observation, effect-time revalidation and selection receipts. Scanner,
sandbox/Python packaging and actual platform certification remain separate gates.
