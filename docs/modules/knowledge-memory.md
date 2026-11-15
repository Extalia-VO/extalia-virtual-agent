# Knowledge, memory and learning

Review baseline: **v0.4.328 local review, 2026-11-15**. Knowledge vault notes, workspace
memory and Skills are related features with distinct stores and authority.
Installing Extalia does not install Obsidian or Claude-Mem.

## Status

| Capability | Status | Scope or remaining acceptance |
| --- | --- | --- |
| Markdown/Obsidian-compatible vault indexing | Implemented | Rust indexes selected profile folders, links, aliases, backlinks and search. Extalia leaves `.obsidian` configuration untouched. |
| Whole-vault 2D/3D graph and local graph | Implemented | WebGL/Three.js and worker-based `d3-force-3d`; elastic drag/return, restore, filters, focus, Explore and list fallback. View changes do not rewrite links or notes. |
| Workspace/profile selection and guarded note editing | Implemented bounded scope | Folder checks, profile filtering and managed-note edit boundaries exist. Broader shared-vault ACL/CAS/provenance acceptance remains open. |
| Progressive Native workspace memory | Implemented | Relevant metadata, paged redacted reads and revision-bound writes. Lead can write; workers receive read tools. Connection can turn memory off. |
| Operational Native/Observe memory and automatic recall | Implemented locally | Rust SQLite/FTS5, scoped current-turn evidence, durable capture outbox, per-request Native lead/worker recall and curator reuse. Bounded evidence and source coverage; no automatic historical backfill. |
| Context inspection and explicit request budget | Implemented | Mandatory skills retain budget priority; optional recall is omitted when it does not fit. Reported cache usage is distinct from estimated context. |
| Recoverable Native tool-context compaction | Implemented locally on supported Unix filesystems | Durable scoped archives permit older tool-body request projections; original history and instructions stay intact. Windows archive publication is disabled. Non-reducible requests still stop before inference. |
| Deferred post-task learning and team knowledge review | Implemented on macOS/Linux | Eligible saved Native Chat schedules bounded idle maintenance. Rust owns artifact publication; generated skills still require inspection and approval. Windows artifact staging is unavailable. |
| Universal runtime compaction and cross-store conflict resolution | Not complete | Native tool-body projection is bounded. External runtimes, semantic consolidation and automatic truth arbitration remain separate acceptance. |
| Measured learning-quality promotion | Not complete | A saved note or clean scan does not prove a lesson is correct, reusable or an improvement. |

## Boundaries and limits

The whole-vault overview bounds its display to 2,000 notes and 8,000 links;
local graphs show at most 60 notes. Truncation remains visible. Layout positions
are temporary, not saved pins. The graph follows actual indexed links rather
than inventing relationships. An Obsidian-compatible vault is a folder integration,
not a dependency on the Obsidian application or its plugin runtime.

Workspace memory remains advisory and separate from vault imports. Operational
records use a persistent lexical index; Knowledge excerpts are freshly read from
the selected profile. Matching is bounded and lexical, with explicit incomplete
coverage. It does not establish that an omitted fact is absent. A local synthetic
storage probe exists; no universal token-saving percentage is measured.

Learning retains a bounded evidence sample, uses the approved provider and waits
for idle/settlement. Countdown state does not survive host restart, and uncertain
effects are not automatically retried. Opted-in Observe has its own attributed
capture/curation path; it does not inject context into an external application's
next prompt. Hermes-managed sessions and Missions do not inherit Native Chat
capture through this feature. Indexed Knowledge
operations are separate from Windows-unavailable learning artifact staging.

## Read by purpose

- Use: [Knowledge and graph controls](../getting-started/knowledge.md),
  [Workspace memory](../getting-started/workspace-memory.md),
  [Automatic learning](../getting-started/automatic-learning.md),
  [Team meetings](../getting-started/team-meetings.md).
- Architecture/design: [Graph interaction](../design/knowledge-graph-interaction.md),
  [ADR 0024: profile vaults](../adr/0024-profiles-acl-and-vault-roots.md),
  [ADR 0045: progressive memory](../adr/0045-progressive-workspace-memory.md),
  [ADR 0055: integrity/context](../adr/0055-native-memory-integrity-and-context-budgets.md),
  [ADR 0067: Rust learning artifacts](../adr/0067-rust-owned-learning-and-profile-artifacts.md),
  [ADR 0074: deferred learning](../adr/0074-deferred-learning-and-workspace-knowledge.md),
  [ADR 0075: idle team knowledge](../adr/0075-idle-team-knowledge-and-office-context.md),
  [ADR 0089: operational memory](../adr/0089-operational-work-memory-and-context-reuse.md).
- Scope: [PRD acceptance map](../product/prd-v2-acceptance-map.md),
  [Knowledge graph review](../product/knowledge-graph-review.md).

## Source and regression evidence

| Area | Source | Regression coverage |
| --- | --- | --- |
| Vault index and host boundary | [Rust Knowledge](../../crates/extalia-core/src/knowledge/mod.rs), [knowledgeVault.ts](../../packages/host/src/knowledgeVault.ts) | [Vault](../../packages/host/test/knowledgeVault.test.ts), [daemon](../../packages/host/test/knowledgeDaemon.test.ts), [editing](../../packages/host/test/knowledgeEdit.test.ts) |
| 3D graph interactions | [Graph renderer](../../apps/web/src/knowledge/vault/vaultGraphRenderer.ts), [simulation](../../apps/web/src/knowledge/vault/simCore.ts) | [Elastic drag](../../apps/web/test/knowledgeGraphElastic.test.ts), [Explore](../../apps/web/test/knowledgeGraphExplore.test.ts), [focus](../../apps/web/test/knowledgeGraphFocus.test.ts) |
| Memory and deferred learning | [nativeMemory.ts](../../packages/host/src/nativeMemory.ts), [learningSchedule.ts](../../packages/host/src/learningSchedule.ts), [Rust jobs](../../crates/extalia-daemon/src/learning/jobs.rs) | [Recall](../../packages/host/test/memoryRecall.test.ts), [learning schedule](../../packages/host/test/learningSchedule.test.ts), [countdown lifecycle](../../apps/web/test/learningCountdownLifecycle.test.ts) |
| Operational capture, context and learning reuse | [Rust work memory](../../crates/extalia-core/src/work_memory/mod.rs), [workMemory.ts](../../packages/host/src/workMemory.ts), [Native preparation](../../packages/host/src/nativeMemoryPreparation.ts) | [Actual host/Rust cycles](../../packages/host/test/workMemoryService.test.ts), [outbox and recall](../../packages/host/test/workMemory.test.ts), [request admission](../../packages/host/test/nativeMemoryPreparation.test.ts), [local probe](../bench/work-memory.md) |
| Recoverable request compaction | [runtime projection](../../packages/runtime/src/contextCompaction.ts), [scoped archive](../../packages/host/src/nativeContextArchive.ts) | [projection integrity](../../packages/runtime/test/contextCompaction.test.ts), [archive durability](../../packages/host/test/nativeContextArchive.test.ts) |

These tests and local probe do not certify live-provider quality, real-vault
behavior, whole-task cost savings or Windows learning publication.
