# ADR 0055: Native memory integrity and explicit context budgets

Status: Implemented and verified locally in v0.4.187, 2026-11-08

## Context

Native already has workspace-scoped Markdown memory, progressive list/search/read
tools, bounded prompt metadata and scanner-gated skill reads. Rebuilding those
features would not address the actual gaps: users cannot inspect the active
memory source from Chat; concurrent memory replacements can overwrite changes;
cache usage is not visible; and long model histories have no aggregate request
pressure gate.

Anthropic reports uncached input, cache reads and cache creation separately.
Its total input is the sum of all three, as documented in
[the provider contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
New Native usage must normalize this total before mission budget accounting,
while retaining cache reads as a reported subset. Historical events are not
rewritten or assigned a derived cache percentage.

## Decision

Expose a compact, keyboard/touch accessible Memory & context disclosure for
Native conversations. Effective connection settings, workspace ownership and
latest-request context stay separate from per-turn expenditure. Absent metrics
remain unknown; explicit zero remains zero. Native workspace memory is distinct
from imported Knowledge-vault copies.

Optional human-facing `nativeMemoryList/Read/Write/Delete` methods use the same
workspace source as agent recall. They validate current-profile workspace
membership before file access. Human inspection remains possible with agent
recall disabled; this does not enable memory or offer it to a model. Reading is
paged after whole-note redaction; catalogs and complete editor loads are bounded.

Opaque revisions bind bounded source bytes and verified file identity. Guarded
writes distinguish explicit create-only null from an exact replacement revision;
deletes and page continuations can also require that revision. Mutations
serialize across store instances in this host. Human APIs require guards, and
new model `memory_write` schemas require a revision guard. Legacy direct store
calls retain compatibility. These are process-local optimistic guards on a
trusted root, not adversarial atomic filesystem CAS against external editors.

Accepted human operations, including workspace deletion, participate in busy
reporting and drain before releasing the host profile lock. Deletion reserves
its workspace before its first await, denying new memory operations while it
removes files and saves configuration.

UI controllers are scoped to the host, profile and workspace. They ignore late
replies, retain drafts after conflict and hide unsupported mutations. Complete
same-revision content must be loaded before editing; a page can never replace a
whole note. Draft retention is bounded and cannot silently evict unsaved text.
Memory remains plain user data, not executable markup, policy or skill activation.

## Cache and request pressure

`features.promptCache` is opt-in and defaults off. Only supported official
Anthropic Messages connections add the SDK's ephemeral automatic cache control.
Compatible gateways and other APIs receive no such field. Cache failures never
authorize request replay. Cache creation can cost extra; actual hits depend on
the provider, model and prefix. Mock transport tests establish request shaping,
not production hit rate or measured financial savings.

An explicit optional `inputTokenLimit` bounds estimated request input. Its range
is 1,024–2,000,000; an unset value does not infer a ceiling from a model name.
Every factory-created provider call and every generic Native loop checks full
system/history/tool-schema/native-replay pressure. The independent text safety
ceiling is 8,000,000 characters. Typed image bytes are excluded from text sizing
and receive an explicitly approximate image-token allowance. Traversal has depth
and work bounds, detects ancestor cycles, accepts shared schema objects and
refuses unsupported structures rather than guessing or allocating a whole-history
JSON string. These estimates are not a tokenizer or a guarantee of model fit.

A local refusal occurs before provider entry, preserves all history and tool
pairs, emits a context reason and exposes recoverable UI guidance. It does not
claim a sent request, consumed tokens or compaction. A typed non-retryable error
prevents model fallback from evading the guard. Mission accounting distinguishes
an initial local refusal from a later refusal after a possibly charged fallback
attempt; only proven no-entry can avoid usage uncertainty.

## Boundaries

This increment does not summarize or discard conversation history, capture
transcripts into memory, automatically activate generated skills, add a production
scanner, complete Rust executor ownership or release uncertain recovery guards.
A reviewed compacted continuation remains separate work. Parent PRD executor,
writer fencing, reconciliation, exact approvals and evidence gates remain open.

## Verification

Focused store, protocol-contract, real-host and runtime tests cover revision
conflicts, Unicode/redaction, complete editor pages, profile scope, queued writes,
workspace deletion/shutdown draining, malformed/unsupported peers, retained drafts,
provider cache shaping, normalized cache budgets, request growth, cancellation,
non-retryable limits and fallback accounting. The product tracker records final
full checks and temporary-profile browser evidence.

Final v0.4.187 evidence: full `pnpm check` passed (6,097 TypeScript tests,
23 optional skips, 474 Rust tests and all builds). Temporary real-host browser
checks pass for same-source notes, 25-note pagination, create/delete, conflicting
edits, draft retention across Settings navigation and restart confirmation away
from Chat. Official-cache controls and the explicit input field render correctly;
no paid provider was called. All three materials in light/dark and Indonesian
390 px layout were checked without horizontal overflow. Closed disclosures make
no memory requests. Mock cache counts are UI transport evidence, not a production
cache-hit measurement.
