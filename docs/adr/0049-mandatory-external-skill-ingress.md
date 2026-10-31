# ADR 0049: Mandatory scanner gate for external skill offerings

Status: Implemented and verified locally v0.4.155, 2026-10-31
Tracking: FR-16 / V2-16 / issue #54; tightens ADR 0023 and legacy skill behavior

## Decision

The owner requires verified scanner evidence as a prerequisite for external
skills. Legacy user directories and hash-consented project files therefore no
longer feed Native agent skill catalogs. Their inventory and exact-hash reviews
remain available as review input; consent is not scanner evidence or activation.
Switching to the TypeScript core cannot bypass this requirement.

Shipped built-ins are the explicitly separate first-party source in ADR 0023.
Native offerings resolve them against a private frozen snapshot of the app's
canonical definitions. An arbitrary name, source flag, modified copy or
same-name external file cannot establish that exemption or shadow shipped text.
This is not a claim that built-ins received an external scan.

## Host boundary

`buildAgentSkillCatalog` builds a host-owned, immutable opaque catalog. Every
external candidate must have an exact registry revision and a successful current
authoritative reader before its metadata enters that catalog. The catalog is
minted in module-private state, not through a transferable `verified: true`
property. Plain inventory arrays, copied handles and forged objects have no
external catalog authority.

Registry catalog construction no longer returns cached external instructions or
descriptions. Each candidate goes through `skill.read`; the host checks the exact
package/revision, `SKILL.md` path, content hash and byte size against the current
revision metadata. The daemon's `read_active_file` revalidates the approval-bound
scan attestation, current scanner identity/policy, active pointer and file bytes.

Each external `skill_read` repeats the authoritative read and verifies the exact
listed identity/content. Missing reader/revision, changed metadata or bytes,
deactivation, scanner-policy change or unavailable daemon refuses without a
fallback to supplied or cached content. Only one listed skill name is accepted;
URL, filesystem-path, unknown-name and extra-property arguments cause no download,
import, filesystem resolution or scan fallback.

The normal Native lead and delegated workers inherit these offerings through
the same host-owned catalog and tools. Mission workers still have their existing
tool set; this change does not add mission skill capability.

## Core policy and scanner readiness

The existing core gate remains authoritative. Missing/unpinned scanner,
incomplete coverage, failure, timeout, malformed output, high/critical findings
and stale hash/scanner/policy evidence deny applicable approval/activation/read.
The default production inspector is still `UnavailableInspector`: external
imports stay quarantined and are not offered as skills. No fake clean result,
ready flag, bypass option, scanner installation or production SkillSpector
adapter is introduced by this update.

The new regression first reads a fixture-authorized active package, then changes
policy, scanner ID/pin/version/normalizer or availability. Its next read refuses,
requarantines the revision, revokes approval and clears activation; even the old
context cannot resurrect it. Controlled `FakeInspector` tests are policy tests,
not evidence that production SkillSpector has run.

## UI and generic documents

English/Indonesian Skills UI now explains the mandatory registered-skill gate.
Legacy actions say Record review / Remove review, and the reviewed list does
not imply scanned, approved or active. Existing data/API names remain compatible.
Source files, earlier reviews and other applications' configuration are unchanged.

Ordinary file/search/web/attachment contents may still reach models as unverified
task data. Do not claim that this skill-specific gate scans every document or
contains all prompt injection. Shared Native lead, delegation and read/write
mission guidance forbids adopting externally obtained skill documents/URLs as
activated skills or as a replacement for the registered scanner-gated workflow;
it permits discussing, auditing and editing those documents as data. This is
model guidance, not deterministic generic-content enforcement.

## Verification and remaining work

Focused host tests cover canonical built-ins, source/name impersonation,
opaque/copy/raw inventory refusal, no-reader/identity mismatch, fresh catalog and
body invalidation, and URL/path/extra-property rejection without I/O fallback.
Actual provider requests from lead/worker/lead under TypeScript and real Rust
with `UnavailableInspector` contain no private user or consented project skill
metadata/body. Runtime tests cover the guidance on actual provider calls without
granting extra tools. UI tests and synthetic browser checks cover the review-only
actions, mandatory notice, EN/light desktop and ID/dark phone layout.

Independent focused review is clear. Full `pnpm check` passed on local v0.4.155:
348 TypeScript suites / 5,248 tests and 453 Rust tests, with one TypeScript suite /
five tests skipped; lint, boundaries, schemas, types, strict Clippy/format and
Web/Desktop/CLI builds passed. Earlier attempts found lint in a concurrent
temporary garment preview and a Node filesystem import in its build test. The
preview retained its imperative animation state without render-time ref access;
the test now loads its fixture as raw data. No checker exception or asset change
was needed. The complete rerun passed after both corrections.

Production pinned SkillSpector artifacts/report normalization, supervised worker
ownership/sandboxing and workspace/agent ACL remain open. In particular, this
change adds no workspace parameter to the current `skill.read` wire contract and
does not certify complete approval-workspace enforcement.
