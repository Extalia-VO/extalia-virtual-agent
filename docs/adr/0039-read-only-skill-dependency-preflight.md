# ADR 0039: Read-only exact-pin skill dependency preflight

Status: Verified locally in v0.4.137 (Rust core) and v0.4.138 (application diagnostics),
2026-10-30.
Tracking: [V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54),
FR-21. Activation integration, a verified scanner and Python workers remain open.

## Decision

Add a pure deterministic solver and a read-only `SkillRegistry::dependency_preflight`
adapter. Delivered as a core library in v0.4.137, it gains an optional read-only
daemon/host/Skills UI surface in v0.4.138; routing and runtime consumers remain absent.
It supplements [ADR 0025](0025-skill-manifest-and-immutable-revisions.md);
it does not replace its validation, approval or execution gates. Existing lifecycle
operations still refuse declared relations with `resolver_unavailable`.

The caller supplies one exact immutable revision per dependency. Missing pins never
fall back to the active version or a highest-version search. The solver checks
version constraints, unknown compatibility facts, dependency availability, cycles,
bidirectional conflicts and literal permission-scope containment. Other active
packages participate in conflicts and reverse dependency constraints. A hypothetical
root replacement supersedes that package's old active revision in this diagnostic
context only. Successful output is a dependency-first ordering of exact revisions,
tree hashes and permission digests. Any issue removes the ordering; every report's
`dispatch_eligible()` is permanently false.

Public solver inputs are claims. Reparse bounded manifests before use and do not
echo invalid identifiers, parser messages, source paths or runtime fact values in
diagnostics. Compatibility facts and permission ceilings remain caller claims even
when the registry adapter establishes source identity. Literal scope comparison
does not interpret globs, resolve secrets or grant host permissions.

## Supported range semantics

Pin `semver` 1.0.28 and wrap its comparator parser explicitly: bare `1.2.3` means
exact, bare `1.2`/`1` match numeric prefixes, trailing `*`/`x`/`X` are wildcards,
space-separated comparators are AND and `||` separates OR sets. Numeric `=`, `>`,
`>=`, `<`, `<=`, `^` and `~` use the library's comparator semantics. Build metadata
on candidate versions is ignored. Prerelease candidates require an explicit
prerelease comparator at the same numeric core within the matching AND set.

This is a defined subset, not full npm syntax or implicit Cargo caret behavior.
Operator wildcards other than bare/`=`, nontrailing wildcards, commas, hyphen
ranges, build metadata in ranges and malformed branches fail closed. Even a
matching OR branch cannot hide an unsupported branch. Preserve the existing
manifest syntax validator: accepted syntax alone never promises match support.
Ranges are at most 128 bytes, eight OR sets and sixteen comparators per set.

## Source snapshot and bounded observations

Use a deferred SQLite transaction scoped to the registry's existing profile.
Load the complete active context up to a hard cap, never a silently truncated
subset. Validate lowercase hexadecimal tree/revision identities before building
object paths. Re-hash the staged tree and read `SKILL.md` and the optional manifest
through verified file readers. Resolve the actual manifest and compare canonical
stored metadata, permissions/digest, inferred flag, risk and source hashes. Relations
come from those bytes, deliberately not the separately stored relation indexes.

An active dependency requires the authoritative activation pointer, compatible
lifecycle state, exact approval binding and the approval-bound inspection with
current scanner, normalizer and policy identity. Deprecated revisions can remain
active while their pointer remains. An inactive inspected candidate can be analyzed;
unscanned, stale, blocked, revoked or pending-review roots block consistency.
Pure read helpers never revoke, quarantine, consume approvals or update history.
Source errors are static diagnostic refusals, not claims that a revision was revoked.

Hard bounds are 128 package nodes, 512 dependency/conflict edges, depth 32, 128
runtime facts, and bounded manifest/permission text. The adapter separately caps
distinct observed revisions at 128, normal staging limits per tree, and 32 MiB
across tree hashing and source rereads. Reserve read slack before I/O, including
the extra byte used to detect file growth. Reservations are conservative: near the
limit a smaller package may be refused before every remaining byte is consumed;
a replacement also consumes a snapshot slot for its old revision. SQL bounds
precede materialization of stored manifests and permission rows.

## Verification and remaining gates

### Optional application diagnostics (v0.4.138)

The additive `skill.preflight` capability accepts only a root revision and up to
128 explicit exact package pins. Profile, scanner/policy identity, time, limits,
empty compatibility facts and empty permission ceiling remain daemon-owned.
The host does not call its consent-recording `inspect` method on this path.
Older daemons keep their existing registry support; the optional operation is
never sent without advertisement. Legacy mode still uses existing W0 consent.
The client hello advertises a frozen original-v1 baseline, not the growing local
operation enum: strict old peers would reject an unfamiliar capability before
discovery. The server still returns its implemented capabilities independently;
required-operation validation and per-feature capability checks remain intact.
Strict legacy-peer fixtures test the actual handshake plus registry reads, while
modern-peer fixtures retain discovery of new optional operations.

The bounded result is a strict union: blocked reports carry 1–256 projected
findings and an explicit truncation flag, with no plan; consistent reports carry
no findings and a nonempty exact plan, never truncation. Both have literal
`dispatchEligible: false`. Projection omits raw scopes, paths, parser errors and
runtime fact values. A 256 KiB serialized-byte guard keeps replies below the
daemon frame limit. Shared TS/Rust/JSON Schema fixtures enforce these shapes.

The Skills page offers revision and pin selectors, no inferred active/latest
defaults. It explains the empty facts/ceiling and unchanged scanner/activation
requirements. Findings remain read-only plain text. Input changes invalidate
pending results; changed host, scanner/policy or registry context remounts the
panel so late replies cannot repopulate a stale view. Old hosts show an explicit
unsupported message without losing their existing Security Center controls.
Wire integration tests compare all skill table contents on success, blockers,
truncation and refusal. UI tests and browser fixtures cover localized controls,
literal rendering, exact selections and stale-context replies.

### Core and future authority

Pure tests cover range boundaries/prereleases, exact pins, ordering, cycles,
conflicts, reverse constraints, unavailable facts and permission/graph caps.
Temporary-profile adapter tests use real staged objects and active pointers,
exercise foreign-profile/mismatched pins, stale attestation, source/database
corruption and snapshot caps, and compare every skill table before/after each call.
The existing activation refusal is explicitly retained in tests.

A coherent SQL view and checked file observations do not establish durable
execution authority: files can change after observation. A future authoritative
consumer must reconcile source/index relations, verify actual runtime facts and
grants, revalidate exact revisions at effect time, and integrate scanner,
evaluation, approval and routing rules. No scanner pin, Python installation or
cross-platform execution certification is delivered by this increment.
