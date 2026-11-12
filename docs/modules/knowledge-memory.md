# Knowledge, memory and learning

Audit baseline: **v0.4.288, 2026-11-12**. Knowledge vault notes, workspace
memory and Skills are related features with distinct stores and authority.
Installing Extalia does not install Obsidian or Claude-Mem.

## Status

| Capability | Status | Scope or remaining acceptance |
| --- | --- | --- |
| Markdown/Obsidian-compatible vault indexing | Implemented | Rust indexes selected profile folders, links, aliases, backlinks and search. Extalia leaves `.obsidian` configuration untouched. |
| Whole-vault 2D/3D graph and local graph | Implemented | WebGL/Three.js and worker-based `d3-force-3d`; elastic drag/return, restore, filters, focus, Explore and list fallback. View changes do not rewrite links or notes. |
| Workspace/profile selection and guarded note editing | Implemented bounded scope | Folder checks, profile filtering and managed-note edit boundaries exist. Broader shared-vault ACL/CAS/provenance acceptance remains open. |
| Progressive Native workspace memory | Implemented | Relevant metadata, paged redacted reads and revision-bound writes. Lead can write; workers receive read tools. Connection can turn memory off. |
| Context inspection and explicit request budget | Implemented | Holding an oversized request preserves history; it is not compaction. Reported cache usage is distinct from estimated context. |
| Deferred post-task learning and team knowledge review | Implemented on macOS/Linux | Eligible saved Native Chat schedules bounded idle maintenance. Rust owns artifact publication; generated skills still require inspection and approval. Windows artifact staging is unavailable. |
| Reviewed continuation/compaction and cross-store conflict resolution | Not complete | Memory, Knowledge copies and canonical task evidence are not one automatically reconciled authority. |
| Measured learning-quality promotion | Not complete | A saved note or clean scan does not prove a lesson is correct, reusable or an improvement. |

## Boundaries and limits

The whole-vault overview bounds its display to 2,000 notes and 8,000 links;
local graphs show at most 60 notes. Truncation remains visible. Layout positions
are temporary, not saved pins. The graph follows actual indexed links rather
than inventing relationships. An Obsidian-compatible vault is a folder integration,
not a dependency on the Obsidian application or its plugin runtime.

Workspace memory remains advisory and separate from vault imports. The current
initial recall uses bounded literal relevance; it does not inspect every distant
summary or establish that an omitted fact is absent. No universal token-saving
percentage is measured.

Learning retains a bounded evidence sample, uses the approved provider and waits
for idle/settlement. Countdown state does not survive host restart, and uncertain
effects are not automatically retried. Observed apps, Hermes-managed sessions and
Missions do not gain Native Chat learning through this feature. Indexed Knowledge
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
  [ADR 0075: idle team knowledge](../adr/0075-idle-team-knowledge-and-office-context.md).
- Scope: [PRD acceptance map](../product/prd-v2-acceptance-map.md),
  [Knowledge graph review](../product/knowledge-graph-review.md).

## Source and regression evidence

| Area | Source | Regression coverage |
| --- | --- | --- |
| Vault index and host boundary | [Rust Knowledge](../../crates/extalia-core/src/knowledge/mod.rs), [knowledgeVault.ts](../../packages/host/src/knowledgeVault.ts) | [Vault](../../packages/host/test/knowledgeVault.test.ts), [daemon](../../packages/host/test/knowledgeDaemon.test.ts), [editing](../../packages/host/test/knowledgeEdit.test.ts) |
| 3D graph interactions | [Graph renderer](../../apps/web/src/knowledge/vault/vaultGraphRenderer.ts), [simulation](../../apps/web/src/knowledge/vault/simCore.ts) | [Elastic drag](../../apps/web/test/knowledgeGraphElastic.test.ts), [Explore](../../apps/web/test/knowledgeGraphExplore.test.ts), [focus](../../apps/web/test/knowledgeGraphFocus.test.ts) |
| Memory and deferred learning | [nativeMemory.ts](../../packages/host/src/nativeMemory.ts), [learningSchedule.ts](../../packages/host/src/learningSchedule.ts), [Rust jobs](../../crates/extalia-daemon/src/learning/jobs.rs) | [Recall](../../packages/host/test/memoryRecall.test.ts), [learning schedule](../../packages/host/test/learningSchedule.test.ts), [countdown lifecycle](../../apps/web/test/learningCountdownLifecycle.test.ts) |

This audit links existing regression and recorded evidence; it does not claim a
fresh vault benchmark, provider run or Windows learning certification.
