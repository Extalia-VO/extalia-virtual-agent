# ADR 0088: Grounded Knowledge relationships and reviewed skill refinement

Date: 2026-11-14

Status: Implemented locally; release and live-provider acceptance remain separate.

## Context

ADR 0087 bounds the Native/Observe curator and records independent artifact
confirmations. Successful persistence is necessary, but a useful learning loop
also needs to find earlier findings, notice corrections, and improve a procedure
without treating a model's declaration as evidence that it read or verified it.

Three gaps remained. Wikilinks were a prompt convention, not an enforced read
invariant. An ordinary read of an older note did not expose later amendments or
conflicts. The curator's executable skill catalog omitted inactive candidates,
including useful drafts that needed another review. A same-name proposal also
lacked a pinned revision and evidence that the current reviewer inspected it.

The reference implementation is Hermes Agent at commit
`005389f78b750749b58f5a5d066956bc117c58b2`. Relevant primary sources are:

- [Background review](https://github.com/NousResearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/background_review.py): bounded review forks, existing-skill improvement, and tool restrictions.
- [Skill mutation guards](https://github.com/NousResearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/skill_manager_guards.py): background read-before-write and user locks.
- [Skill manager](https://github.com/NousResearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/skill_manager_tool.py): package editing and supporting files.
- [Memory store](https://github.com/NousResearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/memory_tool_store.py): locked reread/mutation and bounded persistent memory.
- [Skill usage](https://github.com/NousResearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/tools/skill_usage.py): distinct usage and revision telemetry.
- [Idle review queue](https://github.com/NousResearch/hermes-agent/blob/005389f78b750749b58f5a5d066956bc117c58b2/agent/review_idle_queue.py): best-effort, in-memory scheduling.

These sources establish mechanisms, not a benchmark of either agent's
intelligence. They do not establish that Hermes has an equivalent Obsidian graph
manager. Extalia's graph validation and correction-aware retrieval address its
own vault architecture.

## Decisions

### 1. Ground generated relationships in actual scoped reads

The Rust learning job observes successful `knowledge_read` results before
accepting a relationship. Search results and correction summaries are discovery
data. They never establish that a referenced source was read. The receipt must
match the admitted workspace, profile, canonical path and full source hash.

Model submissions may contain up to eight `relatedNotes`, each with a path,
`related`, `updates` or `contradicts` relation, a bounded reason, and current-turn
evidence IDs. Rust adds the source hash; the model cannot supply one as proof.
Inline wikilinks are checked as well. Unique basenames among actual reads become
full vault-relative links. Ambiguous basenames, unread paths, traversal and
absolute paths are refused. Display aliases are retained; heading and block
anchors must occur in the content exposed to the reviewer. Code examples do not
become grounded graph relationships.

An invalid submission receives at most one targeted repair opportunity within
the existing model/read budget. A repeated invalid result terminates without an
artifact. Canonical paths and dependency hashes participate in artifact identity.
Changing a relation or its source revision cannot reuse an unrelated receipt.

Before publication, the host performs at most eight narrowly scoped identity
reads, then asks Rust to revalidate them. These checks are separate from the
eight analysis reads: they do not explore additional notes and do not call the
model. The pinned Rust writer also checks raw source bytes during preparation
and immediately before publication using the selected vault's directory handles.
Changed or unavailable dependencies stop publication. This is a snapshot check,
not a lock over external editors or a promise that a source will never change.

### 2. Preserve old notes and expose amendments during later reads

Learning appends an attributed note and canonical typed relationships. It does
not overwrite a human-authored note or erase conflicting evidence. `updates`
records an asserted amendment; `contradicts` records an unresolved disagreement.
Neither establishes factual authority or automatically marks earlier facts false.

The Knowledge index stores both edge types. Schema 3 preserves existing graph
rows and ambiguous-link candidates, and a parser revision causes one reparse of
unchanged Markdown after migration. The index is derived data; vault Markdown
remains the source. An older binary cannot open this newer index schema.

`knowledge.node` and Native `knowledge_read` expose up to eight current incoming
amendments/conflicts separately from the original body and hash. Discovery scans
at most 32 candidates plus a truncation sentinel. It only includes resolved,
visible, same-profile source nodes whose bytes still match the indexed hash.
Edited, deleted, excluded and unavailable sources are suppressed. The response
identifies each source, relation, hash and a bounded excerpt, with explicit
untrusted status. Existing `supersedes` edges also appear as source claims.

The curator's model-facing projection keeps valid bounded JSON and reserves
space for correction hints and identity metadata before body text. Blindly
truncating a large JSON result could otherwise remove exactly the feedback the
next review needs. The 2,000-character projection includes at most three compact
hints, fewer when identity metadata is long, and marks incomplete results. A hint
directs a later explicit read; it is not read proof.

### 3. Separate candidate review from executable skill loading

The normal active skill catalog remains governed by activation and workspace
approval. A separate read-only candidate catalog allows learning to review
generated active, inactive or quarantined drafts in the exact originating
profile and workspace. Built-in, blocked, revoked and unprovenanced packages do
not enter this path. A matching `PROVENANCE.md` claim alone is insufficient:
independent registry import-source evidence must also match.

Review returns untrusted data, never instructions injected as an active skill.
The catalog is bounded and reports incomplete results. Reads permit only
`SKILL.md`, `PROVENANCE.md` and bounded Markdown reference paths. Unicode paging
keeps each model-visible result below the curator's output limit. A host-held
read receipt is eligible for refinement only after contiguous coverage of the
entire current `SKILL.md`; existing references must also be reviewed before
replacement or removal. Very long packages may therefore exceed one review's
budget and remain unmodified.

The registry is physically shared, but automatic draft refinement is deliberately
restricted to exact profile/workspace provenance. Cross-session refinement within
that scope is supported. Automatic cross-workspace candidate sharing, including
between a Native workspace and unbound global Observe, is not introduced here.
Existing explicitly activated reusable skills retain their existing catalog rules.

### 4. Pin refinement to the reviewed immutable revision

A refinement provides the base revision ID, `SKILL.md` hash, exact read receipt,
and an explanation of the change. The Rust curator verifies the successful
current-job read; the host verifies its actual reviewed coverage. At import, the
Rust registry checks scope, package identity, the expected base digest and latest
revision in its mutation transaction. A concurrent newer revision fails closed.
Omitting the base fields cannot bypass this requirement: a generated import under
an existing package name must either replay the exact stored tree or provide its
current reviewed base. Explicit Native skill-learning turns receive the same
scoped review tools, with receipts bound to their unique invocation.

A successful refinement creates an immutable candidate revision. Existing active
revisions remain active until the ordinary scan/review/approval lifecycle selects
another. A no-change proposal returns the existing revision rather than adding
empty revisions just because the source session or read receipt changed.
Ephemeral read receipts do not participate in artifact content hashes or persist
as provenance claims. This makes repeated reviews stable without weakening the
read-before-refine condition.

Generated packages can include up to four `references/<slug>.md` files, each at
most 16 KiB and together at most 48 KiB. The package is staged and scanned as a
unit. Path traversal, hidden files and executable scripts are not accepted by
this proposal format. These limits do not grant execution or activation rights.

### 5. Keep execution and evaluation claims separate

Current user corrections and source-task results can drive the next review.
Observed reports and conversation claims retain their original attribution.
Saving, reading, scanning, approving and successfully using a skill are different
events. A `Verification` section in a skill is a procedure, not a passed test.

This change does not add a production usage-score optimization loop, semantic
paraphrase deduplication, automatic truth arbitration, or durable scheduler/job
recovery. ADR 0087's confirmed-artifact receipts remain durable; an uncertain
publication is not blindly retried. The reference Hermes idle queue is also
in-memory; that limitation should not be misreported as an upstream guarantee.

## Placement and consequences

Rust continues to own curator decisions, read-proof validation, canonicalization,
artifact hashes, directory-safe publication, index relationships and transactional
registry comparison. TypeScript remains effect/presentation glue: current consent,
model/tool dispatch, scoped review adapters, Unicode view coverage and UI labels.
No alternate JavaScript persistence owner or additional LLM reviewer is introduced.

Six model requests, eight unique analysis reads, the existing 12k/32k input
estimates, and separate analysis/publication deadlines remain in place. A linked
finding adds bounded identity checks before publication. Mandatory inspection and
activation policies remain applicable to every new candidate revision.

## Acceptance

Focused Rust and TypeScript tests cover grounding, anchors, ambiguity, malformed
Markdown, source edits, candidate provenance, paging, stale revisions, reference
packages, no-change and scan failures. End-to-end temporary-profile fixtures run
the actual Rust sidecar, writer and index across Native default, Native isolated,
Observe bound and Observe global-default source/destination modes. They assert a
second curator receives correction metadata, and that a source edit between host
revalidation and the writer prevents publication.

An actual Native host fixture also creates and refines a candidate in separate
sessions of its originating isolated workspace, adds another package from a
second workspace to the shared physical library, and refuses an unread same-name
replacement while retaining Knowledge, memory and project-file isolation.

These providers are deterministic fixtures. They prove data/control flow and
failure handling, not live model quality or superiority over Hermes. Final
repository gate results and remaining acceptance limitations accompany the patch
bundle. Linux verification does not certify macOS/Windows packaging or a user's
real vault and provider connection.
