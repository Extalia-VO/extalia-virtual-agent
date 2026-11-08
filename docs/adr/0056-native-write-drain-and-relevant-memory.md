# ADR 0056: Sealed Native persistence and relevant memory metadata

Status: Implemented and verified locally v0.4.188, 2026-11-08

## Context

A host may stop while a provider ignores cancellation. Previously, shutdown
waited five seconds for runs, drained the then-current event chains and released
the profile lock. A later reply could emit completion and replace history or
session metadata after a new host had opened the same profile. Credential and
history preparation also occurred before Native run ownership was visible.

The initial memory preview selected eight alphabetically early notes. Useful
notes could be omitted even when their filename or summary matched the current
request. Full-body injection and expensive background embedding scans would
violate the existing selective-recall/resource goals.

## Native persistence decision

Add a host-lifetime `HostPersistenceGate`. Admission is synchronous and owns
exactly the returned local-operation promise. Sealing is irreversible; admitted
writes drain before the profile lock is released. No ambient async context or
inherited nested token grants write authority. Event publication acquires
admission before joining its per-session queue and appends with an explicit
admitted operation; late callbacks cannot open a new queue or broadcast success.

A Native turn reserves its session during preflight. Before credentials or model
inference, it strictly checkpoints the accepted prompt event and the composed
text-only model-history prefix. Attachment text follows the existing composition
contract, while image payloads stay out of stored model history. A failed initial
checkpoint prevents provider entry. Returned text/deltas after cancellation do
not become assistant completion or tool execution.

Shutdown closes Native admission, aborts providers and denies pending approvals.
Normal runs have the existing bounded grace period. Unsettled accepted runs get
an explicit interruption record without a physical-settlement claim. The host
then seals persistence and drains admitted local work before unlocking. An
unresolved provider alone cannot keep that grace open indefinitely; a known
local filesystem write must retain the lock until its promise settles. Repeated
close calls share one close operation.

The gate covers the managed session/index/history/event paths and explicitly
wrapped configuration, profile, library, appearance, consent, credential,
attachment, Native file/memory, skill staging/cleanup, mission checkpoint and
preparation writes. User worktree mutations own their complete initialization,
mutation and registry-write lifetime. Separate existing owners still shut down
hooks, observers and Knowledge. Connector apply/disconnect and mutating recovery retain their existing reviewed
journal workflow inside owned admission; no new external configuration authority
is granted. The tracker records review evidence rather than claiming every
possible application effect is fenced.

The session index, display events and model-history file are not one atomic
transaction. An interrupted turn can retain the accepted prompt while lacking
a complete tool-result model history; the interruption is not proof that no
effect occurred. Credential/config writes likewise are not a cross-store
transaction. Session creation now awaits its initial durable event before
acknowledging readiness, rather than reporting idle while it is still pending.

This protects known host-owned persistence. A command's returned promise or a
shell exit does not prove detached-descendant settlement; full executor
membership, writer fencing, physical reconciliation and V2 effect gates remain
open. There is no recovery replay, automatic result fabrication or new permission.

## Relevant metadata decision

Add `MemoryStore.recallCatalog` for the initial model preview. Derive at most
12 normalized literal terms from bounded prompt head/tail windows. Prioritize
matching filenames among at most 4,096 discovered names, then examine at most
128 candidates within the existing 2 MiB aggregate-read ceiling. Rank only safe
names and summaries; return at most eight notes under the unchanged prompt
catalog ceiling. Greetings and empty queries use the inexpensive baseline.
Existing alphabetical catalogs and explicit literal-AND paged search retain
their contracts. Incomplete previews never establish global absence.

A process-local 512-entry LRU retains only cloned, redacted metadata and verified
file signatures. Every hit checks the root and file again, including regular-file,
link-count, size, identity and timestamp constraints. Changes, replacements,
unsafe links and recreation invalidate the entry. Full content reads, paged
revision checks, literal search and write guards remain uncached and fresh. No
user query, raw body, credential or model answer is stored by this cache. These
checks retain the trusted-directory assumption; they are not adversarial atomic
filesystem CAS or a source of policy authority.

Count-only diagnostics support a reproducible
[local benchmark](../benchmarks/native-memory-recall-2026-11-08.md). Synthetic
metadata hit-at-eight and local latency are different from model answer quality,
learning acceptance or actual provider-token/cost savings. Distant summary-only
matches outside the candidate bound remain explicit misses.

## Provider cache and usage controls

Native Anthropic response replay removes block-envelope `cache_control` fields
before constructing the next request. Stored responses, signed thinking and
nested tool input remain unchanged. Only the eligible connection's explicit
top-level cache option can enable caching; opt-out and unsupported gateways
cannot inherit it from a prior response.

Provider usage accepts only nonnegative safe integer counts. A cache subset
larger than known input is omitted. OpenAI streaming distinguishes absent fields
from explicitly invalid reports: an invalid final count clears its provisional
value, while a later explicitly valid report can repair it. Validation happens
after the complete stream merge. Aggregate overflow remains unknown through
later additions; mission token budgets stop on unsafe arithmetic instead of
treating the missing total as zero. Reported zero is retained.

These are reported counters, not a billing ledger. Partial reports can remain
known subtotals, and a failed attempt preceding a successful fallback can have
unreported usage. Historical records are not rewritten and no complete-cost
claim is made.

## Verification

Real temporary-profile tests hold abort-ignoring providers across shutdown,
reopen and newer state writes, then release the old reply and compare files and
broadcasts. Other tests hold local write, credential, skill staging/cleanup and
worktree lifetimes, exercise checkpoint failure, queued event/index writes,
preflight cancellation, transient history and repeated closure. Recall tests
cover relevance, partial scans, Unicode, redaction, cache invalidation, eviction,
workspace separation and fresh revision conflicts. Final repository checks,
independent review and browser evidence are recorded in the PRD tracker.

Full repository gate: `pnpm check` passed with 6,182 TypeScript tests, 23 optional
tests skipped, 474 Rust tests, lint/typechecks and Web/Desktop/CLI builds.
Independent review passed; real temporary-host browser checks cover Native
retrieval traces and EN/ID memory/composer controls. No paid provider was used.
The built UI also preserved a held prompt without new reported usage, then
completed a retry after an explicit connection-limit change without removing
the original history. The temporary connection setting was restored.
The local development Electron smoke also passed with available IPC and no
renderer/model errors; packaged and other-platform certification remain separate.
