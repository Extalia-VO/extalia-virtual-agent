# ADR 0089: Operational work memory and bounded context reuse

Date: 2026-11-15

Status: Implemented locally; release, live-provider quality and platform acceptance remain separate.

Update: [ADR 0091](0091-context-optimization-and-learning-recovery.md) extends
request preparation with continuation recall, per-source admission, structural
tool projection, selective sanitized archives, optional Caveman Engine and a
separate durable curator recovery mechanism in v0.4.330. The text below records
the v0.4.328 implementation and its original measurement scope.

## Context

Workspace Markdown memory, the Knowledge vault, generated skill candidates and
reviewed handover archives already have distinct storage and authority. ADRs
0087–0088 make post-task curation bounded, artifact outcomes independently
confirmed, wikilinks grounded in actual reads, and candidate refinement pinned to
a reviewed revision. They do not make every Native turn available to later work.

The missing operational loop is capture → durable local index → selective recall
→ provider admission → learning reuse. An old note catalog or a successful
artifact write alone does not establish that a later model received that source.
Large repeated tool results also consume request capacity even when their full
bodies are no longer needed for the current step.

The [Claude-Mem project](https://github.com/thedotmack/claude-mem) is a reference
for local activity storage and progressive retrieval. This decision implements
an Extalia-owned loop; it does not install Claude-Mem, claim equivalent hooks in
external applications, or infer total cost savings from smaller previews.

## Decisions

### 1. Keep an attributed operational record separate from curated truth

Rust owns `work-memory.sqlite`, transactions, FTS5 search, record identity,
revision-bound evidence paging and exact source revocation. A scope contains
profile, workspace and a stable workspace-boundary digest. Session and turn IDs
identify source episodes without preventing another session in the same scope
from retrieving them. Workspaces sharing a vault profile do not thereby share
their operational records. Explicitly unbound Observe uses the reserved global
workspace in the default profile; invalid or ambiguous links never fall back.

The host records bounded current-turn user text, the latest steering corrections,
assistant report, successful and failed tool outputs, and an explicit completed,
failed or cancelled outcome. It does not record hidden reasoning or attachment
bytes. A successful tool report remains a source claim. Previous memory,
Knowledge, archive and Skills retrieval results are excluded from direct capture
to limit recursive ingestion. Worker evidence retains the originating route and
requires that worker's frozen and current memory/history settings. Distinct
worker/request occurrences cannot collide merely because providers reuse a tool ID.

Normalization redacts complete source text before clipping, preserves complete
Unicode code points, and admits up to 32 evidence entries of 2,000 characters
within a 96 KiB transport budget. Coverage explicitly reports omissions and
truncation. The store admits at most 1,024 records per scope and 4,096 per profile,
with a 512 MiB file ceiling. Capacity refusal is visible; there is no automatic
deletion, semantic consolidation, embedding service or unlimited-history claim.

Native capture requires a saved session, history retention, the connection's
Extalia memory feature and enabled profile learning. A disabled learning policy
does not silently authorize another automatic persistence path. Observe capture
uses its separate profile opt-in and current watching/privacy/source authority.
Failed and cancelled episodes may be retained as operational evidence without
scheduling completed-task artifact curation.

### 2. Recover exact local writes without replaying inference

Before calling Rust, the host atomically journals a normalized capture in a
private outbox. Exact payload replay is idempotent: a lost acknowledgement cannot
create another record with different evidence. Each pending item carries its
admitted scope, consent revision and origin identity. Restart replay rechecks
current profile/boundary, Native connection/history or Observe source permission.
Invalidated items enter a durable revocation phase before removal; re-enabling
consent cannot revive an already invalidated pending capture.

The outbox allows 64 records and 4 MiB. Ordinary replay attempts up to eight
records and stops after a backend failure; startup admits up to 64. File/directory
identity, regular-file and link checks guard local publication. Entered writes
retain host persistence ownership through shutdown settlement.

This is recovery of local storage only. It does not replay a provider request,
curator job or uncertain Knowledge/Skills publication. Native turns are captured
after their result is available; a process crash before durable outbox admission
can lose that operational capture. Observe keeps at most eight earlier terminal
frames per source persistence batch, so a later prompt does not erase all earlier
completed work. Startup and first-enable still establish a baseline instead of
backfilling the entire transcript. These limits remain explicit.

### 3. Admit relevant context before each Native model request

Every lead/worker request can perform bounded local lexical recall using the
latest user assignment or steering. The host supplies a compact preview with
record IDs, exact revisions, timestamps, outcome and uncertainty. The
`work_memory_search` tool returns bounded metadata/excerpts; `work_memory_read`
retrieves the exact evidence page. No LLM or embedding call is needed to capture,
search or build this preview.

The selected Knowledge vault also contributes up to two freshly read matching
notes, with source hashes and separate amendment/conflict hints. Changed, deleted
or unavailable note bodies are suppressed. Search snippets are discovery only;
the model is told to read the original note before relying on its claim. The
bounded JSON remains structurally valid when paths and text are long. This does
not confer factual authority on a newer note or guarantee semantic recall.

Mandatory skill preparation happens first. Optional operational-memory and
Knowledge blocks are admitted only if the complete request still fits the
connection's configured input estimate and independent character ceiling.
Unavailable optional recall is reported as incomplete and does not break an
otherwise valid request. Source/profile authorization is checked again after
asynchronous skill, Knowledge and reporting work, before returning context to
the provider. A source access change aborts the stale request.

Worker tools, automatic recall and raw evidence capture follow the selected
worker connection. A disabled worker cannot inherit a lead's operational-memory
tools or persistent archive. Meeting read-helper filtering admits these exact
read tools without admitting memory writers. Unknown worker routes fail closed.

### 4. Give curators history without laundering it into current evidence

Native and Observe curator admission accepts a separate bounded `memoryContext`.
It is appended as attributed historical system-context data, not inserted into
the current task's evidence array. Current episode IDs are excluded from recall
when that episode is already supplied directly. Historical IDs cannot satisfy
current-evidence requirements or Knowledge read receipts. The existing aggregate
input/read/model budgets still apply; the wire contract accommodates the combined
system block without weakening the input budgets.

Read-only operational-memory tools join the curator and automatic Knowledge
meeting tools only when the selected connection permits memory. Existing
Knowledge grounding, note dependency revalidation, inactive candidate creation,
revision-pinned refinement and activation policy remain authoritative. Remembering
a failure can inform a later successful review; failure alone is not converted
into a successful task or an automatically activated skill.

### 5. Compact old tool bodies only after recoverable archive publication

Native runtime compaction creates a request projection; the original persisted
history and returned `TurnResult.history` remain complete. It preserves all user
and assistant text, tool names/arguments, IDs, order, failure flags and provider
native blocks. Only large older tool result bodies become exact head/tail excerpts
with an archive reference. Recent tool batches are retained when the budget
allows. A pressure fallback can compact more eligible older bodies.

Each lead and worker has a separate scoped archive reader. Chunks and manifests
are content-addressed, redacted, immutable and paged with hash validation. The
writer acknowledges only after file and directory publication barriers and scope
revalidation succeed. A missing reader, uncertain write, bad reference, changed
scope or archive quota prevents compaction. Unsupported Windows directory
durability disables this archive path before file creation; it is not reported
as working compaction there.

The default trigger is a 24,000-token estimate or 85% of a configured input limit.
The estimator is not a provider tokenizer. Archives are bounded to 256 MiB,
16,384 files, 8,192 messages and 32 MiB per message; there is no silent eviction.
Oversized user instructions, system context, tool arguments or native blocks
cannot be made safe by dropping them. Such requests still stop before inference
with their original history intact. This feature is not a general semantic
conversation compressor or external-runtime context replacement.

## Placement and measured evidence

Rust owns the queryable durable operational store and its atomic index. TypeScript
retains host consent/effect supervision, current-request framing, the recoverable
capture journal and Native request/archive projection beside the existing history
owner. Those are explicitly recorded backend responsibilities, not UI work or a
claim that all backend code migrated to Rust. React only routes and presents
explicit Observe reads; an unbound source uses global scope, while a changed link
invalidates in-flight results.

The [local storage probe](../bench/work-memory.md) tests 2,000 synthetic records
across two workspaces, reopen, old English/Indonesian retrieval and unrelated
queries. It records local timings and response sizes with no paid provider.
It is not a comparative language benchmark, cold-cache measurement, model-quality
evaluation or total-token saving result. The implementation reuses the existing
Rust/SQLite owner rather than creating a second full-text engine in the host.

## Acceptance and remaining work

Focused tests cover transaction/revision/scope boundaries, query escaping,
idempotent replay, source revocation, outbox failure and late settlement,
Observe batches, steering, fresh Knowledge reads, mandatory-skill budget priority,
tool-pair integrity, archive paging/corruption/durability and per-worker authority.
Real temporary-host/Rust integration tests verify restart → fresh-session recall,
profile reassignment, feature/history opt-outs, failed outcomes, worker evidence,
and a second curator publishing an indexed note plus an inactive skill candidate
that informs a later request. Providers in these tests are deterministic fixtures.

Release review must retain the actual repository gate results. No live personal
profile or paid model is used by these fixtures. General external MCP memory
injection, automatic historic backfill, semantic relevance/consolidation, retention
policy, durable paid-job scheduling, measured task-quality promotion, total-cost
comparison and Windows/macOS packaged acceptance remain separate work.
