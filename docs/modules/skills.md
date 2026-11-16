# Skills and Grimoire

Audit baseline: **v0.4.288, 2026-11-12**. This module covers instructions,
discovery, import, inspection and activation. A skill never grants tool rights.

## Status

| Capability | Status | Scope or remaining acceptance |
| --- | --- | --- |
| Built-in library, Book/List, search and categories | Implemented | Shipped procedures include memory recall, opt-in Caveman, orchestration and reviewed workflow adaptations. No upstream runtime is installed automatically. |
| Native list/search/read and automatic relevant context | Implemented | Bounded inventory and full selected procedures; per-connection ownership, fresh external revision checks and context limits apply. Observed harnesses and canonical mission workers remain separate. |
| Folder/project import and explicit prompt learning | Implemented | `/learn-skill` or **Learn as skill** can save an instructions-only candidate. Ordinary reading does not automatically register every linked document. |
| Marketplace search and immutable public GitHub preview | Implemented preview | Exact previewed bytes import for review. Private repositories, installers, symlinks and automatic upstream updates are unsupported. |
| Mandatory pinned SkillSpector inspection | Implemented on verified macOS 14+ ARM64 | NVIDIA SkillSpector 2.13.4 and bundled Python run under Rust supervision. Other platforms remain unavailable/fail-closed; importing is not activation. |
| Immutable revisions, review, approval, activate/rollback/revoke | Implemented | Approval binds exact digests. Missing, stale, incomplete or blocking scanner evidence prevents use. |
| Dependency/compatibility and category routing | Partial | Read-only preflight and routing diagnostics exist. They do not supply authoritative executable dependency resolution or approval. |
| Measured skill-quality promotion and sandbox evaluation for general code/tool packages | Not complete | A security verdict or generated lesson is not evidence of improved task quality or executable-package acceptance. |

## Trust boundary

External instructions pass quarantine, exact-revision inspection, applicable user
review, approval and activation before Native offers them. Canonical shipped
built-ins are a separate trusted distribution path; a same-name imported file
cannot replace one. A prompt URL, local review record or marketplace listing does
not establish a scan or a license. Scan coverage excludes LLM analysis, source URL
fetching and running skill code. The scanner does not scan every ordinary document
read as task data.

Generated and automatically learned candidates use this same registry boundary.
They enter the shared user library with provenance; they are never activated by
the model. Workspace applicability still controls later use.

## Read by purpose

- Use: [Built-in catalog](../getting-started/builtin-skills.md),
  [Automatic Native loading](../getting-started/native-skill-loading.md),
  [Project skills](../getting-started/project-skills.md),
  [Skill Security Center](../getting-started/skill-security-center.md),
  [Marketplace](../getting-started/skill-marketplace.md).
- Architecture: [ADR 0025: revisions](../adr/0025-skill-manifest-and-immutable-revisions.md),
  [ADR 0049: mandatory ingress](../adr/0049-mandatory-external-skill-ingress.md),
  [ADR 0050: prompt candidates](../adr/0050-explicit-prompt-skill-candidates.md),
  [ADR 0068: scanner](../adr/0068-pinned-skillspector-inspection.md),
  [ADR 0073: automatic context](../adr/0073-automatic-native-skill-context.md),
  [ADR 0077: marketplace](../adr/0077-live-skill-marketplace.md).
- Recorded scanner evidence: [Integration and limitations](../architecture/skill-scanner-evidence.md),
  [bundle/fixture procedure](../../tooling/skillspector/README.md).

## Source and regression evidence

| Area | Source | Regression coverage |
| --- | --- | --- |
| Library and procedure preparation | [builtinSkills.ts](../../packages/host/src/builtinSkills.ts), [nativeSkillPreparation.ts](../../packages/host/src/nativeSkillPreparation.ts) | [Preparation](../../packages/host/test/nativeSkillPreparation.test.ts), [autoload](../../packages/host/test/nativeSkillAutoloadHost.test.ts), [catalog UI](../../apps/web/test/skillLibrary.test.ts) |
| Registry and scanner | [registry](../../crates/extalia-core/src/skills/registry.rs), [scanner](../../crates/extalia-daemon/src/skill_scanner.rs) | [Scanner boundary](../../packages/host/test/skillScannerBoundary.test.ts), [registry](../../packages/host/test/skillRegistry.test.ts), [rescan](../../packages/host/test/skillRescan.test.ts) |
| Prompt proposals and marketplace | [skillLearning.ts](../../packages/host/src/skillLearning.ts), [skillMarketplace.ts](../../packages/host/src/skillMarketplace.ts) | [Learning](../../packages/host/test/skillLearning.test.ts), [marketplace](../../packages/host/test/skillMarketplace.test.ts), [UI](../../apps/web/test/skillMarketplace.test.ts) |

These references identify implementation coverage, not fresh scanner execution
or all-platform certification during the documentation audit. See the
[PRD acceptance map](../product/prd-v2-acceptance-map.md) for remaining gates.
