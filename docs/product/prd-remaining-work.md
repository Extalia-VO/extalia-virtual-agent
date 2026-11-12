# Remaining PRD work and implementation status

This is a focused execution map of work that is still open or only partly accepted in the product PRDs. The canonical requirements and acceptance plans remain in the linked source documents; this note does not close their gates.

## Checkpoint: 2026-11-12 / v0.4.288

This is the current execution summary. Requirement-level traceability lives in the
[v1.1 gap map](prd-v1.1-gap-map.md) and
[v2 current checkpoint](prd-v2-acceptance-map.md#current-implementation-checkpoint).
“Implemented” below means the named slice exists with scoped supporting evidence;
it does not mean the complete parent PRD or a release milestone is accepted.
This update reviews source and existing evidence, without rerunning live acceptance.

| Module | Implemented slices | Not yet complete |
| --- | --- | --- |
| Shell, setup, Chat/Observe | Shared Web/Desktop UI, optional initial workspace, model-test-first setup, common rich messages/attachments/questions/approvals | Complete offline/corrupt-profile, assistive-technology and certified app-version matrix |
| Native orchestration | API agent, configured teams/delegates, DAG, budgets, durable checkpoints/leases and recovery inspection | Complete child/writer ownership, physical reconciliation, effect-time grants, evidence acceptance, durable dispatch/replay |
| Skills / Grimoire | Built-ins/categories, import/library/security lifecycle, explicit prompt learning, managed auto-loading receipts and live marketplace | Authoritative dependency/compatibility dispatch, general evaluation/quality promotion and full marketplace metadata |
| Scanner / Python | Pinned SkillSpector and bundled Python execution on macOS 14+ ARM64, separate review/approval/activation | Intel macOS/Windows/Linux scanner confinement; general Python executor; scan is not quality evaluation |
| Knowledge / Obsidian | Markdown vault, wikilinks/backlinks, index/search, CAS/history, interactive 2D/3D graph, workspace vault profiles | Complete cross-profile ACL/sharing, claim provenance, conflict reconciliation and V2-17A acceptance |
| Learning / meetings | Profile records, explicit/inactive generated candidates, deferred curation, team knowledge meetings, saved-artifact notices | General isolated evaluation, measured improvement/promotion/rollback; Windows artifact staging unavailable |
| Cross-agent continuity | Durable handover ledger, reviewed packet, exact source archives and supported delivery receipts | Real Codex → Gemini → Claude → Codex chain, compaction/failure/long-duration acceptance and broader external Knowledge context |
| Office | Licensed Blender scene assets, movement/facility interactions, follow/camera and adaptive recovery | Declared-hardware whole-app FPS/RSS, remaining asset reductions and full furnished-scene acceptance |
| Git / files / workspaces | Folder boundaries, nested read-only Git discovery, isolated write-task worktrees and integration inspection/proposals | Production test/apply blocked pending isolated executor; complete Rust writer fencing and live write-worker acceptance |
| Release / ecosystem | v0.4.288 Desktop/Web/npm preview and scoped CI/package evidence | v0.5 gate #60; stable signing/notarization, full restore, general schedules, public SDK/plugin isolation and new workers/engines |

No overall completion percentage is inferred. A complete v0.5 claim still requires
its [release gate](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60),
not simply implementation volume or a successful v0.4 publication.

## Priority 0: continuous work handover

The requested outcome is repeated transfer among Codex, Gemini, Claude and other supported agents while preserving one continuous project history. A transfer must carry forward what has already happened and what remains, rather than reconstructing the task from its opening prompt.

### Existing foundation

- [App-flow PRD, tracker](prd-app-flow-and-live-agents.md#11-status-tracker): Native sessions preserve identity across team changes and reviewed workspace moves; Observe retains source identity/history and supports capability-bound message paths for some integrations.
- Imported and observed transcripts, structured activity, prompt queues, source-bound receipts, workspace/vault profiles, memory, Knowledge and saved meeting notes provide reusable evidence.
- **O-CROSS-AGENT-HANDOVER** now has a durable canonical ledger, exact reviewed destination handover and scoped original-archive retrieval (ADR 0076). Native endpoint identity/history is preserved and observed application IDs remain linked aliases. **O-OBSERVED-KNOWLEDGE-CONTEXT** remains partial: archive grants do not grant workspace Knowledge or active skills access.

### Required behavior

Maintain a canonical Extalia continuity record attached to the project/session. Each handover should update and reference that record, not restart from the original request. It should retain:

- User goal, constraints, accepted decisions, rejected options and unresolved questions.
- Work completed, current state, next concrete steps, blockers and ownership.
- Files/artifacts changed, verified test/build results and their provenance, plus unverified claims clearly marked.
- Source session/runtime identity, latest acknowledged event or checkpoint, workspace/folder boundary and relevant capability limits.
- A compact handover view for the receiving model, with enough source references to retrieve detail when needed.

Returning to a prior runtime must merge its new work into the same continuity record. Updates need versioning and conflict handling so parallel or stale agent context cannot silently overwrite newer decisions. The user should be able to inspect/edit the handover record and choose the destination agent/model.

### Acceptance still required

The v0.4.282 full gate passed with 9,088 TypeScript tests, Rust checks and production builds. Actual-host tests cover repeated transfer, original evidence, cross-provider serialization, idempotence, privacy and scoped MCP reads. The v0.4.284 gate also covers a long controlled chain with 28 large source entries, bounded packets, retained omissions and paged original archives. Synthetic browser tests cover both languages, themes and narrow layouts. These do not replace real third-party app acceptance.

1. Run a real controlled chain **Codex → Gemini → Claude → Codex** on one temporary project. At each hop, the recipient must see the prior decisions, completed work, active constraints and next step without requiring the user to paste the original task again.
2. Verify continuity after enough turns to trigger context-window pressure or compaction; compare an explicit decision/checklist set and ensure no item disappears or changes without a traceable update.
3. Verify source attribution: imported transcript facts, external agent claims, tool-confirmed file changes and test output remain distinguishable.
4. Verify receiver-specific limitations honestly. If an app exposes no supported same-thread send/resume capability, Extalia must say so and continue through an explicitly linked session or exported handover; it must not claim a same-ID session or inject context through a private/unsupported path.
5. Exercise failures: rejected/unknown handoff, stale receiver, duplicate submission, workspace switch, concurrent edits and return to a prior runtime. An unknown send must not be replayed automatically.
6. Show the canonical record, handover history, receiving agent and acknowledged checkpoint in Chat/Observe. Keep existing drafts and queued messages bound to their original source.

**Implementation boundary:** first ship a durable, inspectable continuity packet and handover ledger with provider-neutral source references; then add send/resume adapters only where the runtime exposes verified capabilities. Extalia owns continuity. Provider conversations remain separate records linked to it. Do not promise one native conversation ID across applications that cannot share one.

## Priority 1: Grimoire marketplace independent of app releases

Grimoire now includes a runtime-refreshed public marketplace adapter with explicit search, cached/offline results, immutable GitHub previews and exact-revision imports (ADR 0077). Import source records persist in CoreStore schema 14 and collisions cannot inherit another source’s package identity. The v0.4.283 full gate and actual temporary-host public import/restart/deduplication passed; imports stayed quarantined with the test scanner unavailable. Rich categories/compatibility metadata, authenticated/private catalogs and cross-platform scanner acceptance remain open.

### Required behavior

- Load a signed or otherwise verifiable marketplace catalog at runtime, independently of Desktop/Web app releases. Support refresh, search, categories, source/license and compatibility metadata.
- Resolve an install to an immutable package revision and content digest. Never let a moving “latest” alias silently change an installed skill.
- Import downloads into quarantine, shows exact files, source, license, requested permissions and compatibility, then runs the pinned scanner. Preserve fail-closed behavior when provenance, scanner or dependency data is missing.
- Require explicit review/approval before activation. Installation, scanning, approval and activation are separate states; marketplace content cannot grant itself tools or workspace access.
- Support update comparison, rollback/removal and cache/offline behavior without invalidating existing pinned revisions.
- Keep catalog/network access optional and scoped; built-in skills remain usable without a marketplace connection.

### Acceptance still required

- Browse and refresh a remote catalog on two different Extalia app versions; the catalog and immutable revision identity must be independent of either app bundle.
- Install into a temporary profile, verify the pinned digest and complete file manifest, inspect the license/permissions, scan, approve, activate, update and roll back. No skill is offered to a model before the required scanner and activation gates pass.
- Reject tampered content, unavailable scanner, incompatible manifest, dependency conflict, revoked/removed upstream item and interrupted download without activating partial content.
- Show clear provenance and state in Grimoire; tests use a local fixture market and never modify the real profile.

Relevant foundations and gaps: [v1.1 gap map, skill routing/scanner/dependencies](prd-v1.1-gap-map.md); [v2 FR-023/024](prd-v2-acceptance-map.md#functional-requirements); [built-in and external skills guide](../getting-started/builtin-skills.md).

## Remaining work after Priority 0

The app-flow status tracker is the live list; the main open or partial product slices are:

| Work | Current foundation | Still needed |
| --- | --- | --- |
| Observed Knowledge context | Source identity, explicit project/workspace binding, inbox and handoff reporting ([ADR 0078](../adr/0078-observed-workspace-association.md)) | Capability-scoped Knowledge and skill retrieval for supported external agents, observed completion learning and source-specific acceptance. Keep read/write grants separate. |
| General schedules | Deferred-learning timers and prompt queues | User-created one-off/recurring schedules, session create/continue behavior, assigned lead/team, edit/pause/disable and missed-run policy. Learning timers are not general scheduling. |
| Office experience | Renderer quality recovery, movement and social rendezvous work | Continue current tracker items and verify furnished rooms/floors and real Web/Desktop workload separately; do not infer whole-app low-end performance from resolution scaling alone. |
| Low-resource assets | Adaptive render resolution and staged character arrivals | Optimize inventoried large GLB assets only with visual/geometry review; test representative low-spec hardware and memory/FPS under realistic office load. |
| Native orchestration | Durable checkpoint, lease, queue, approval and mission UI foundations | Complete remaining V1 mission acceptance: live permitted-provider/worker evidence, physical settlement and writer fencing, terminal reconciliation, effect-time approvals, child membership, replay and recovery. |
| Skills and learning | Local Grimoire, pinned SkillSpector preview on supported targets, automatic curator and workspace vaults | Finish cross-platform scanner/package evidence, authoritative dependency/resolver dispatch and canonical mission/external skill-context integration. Managed Chat, ordinary delegates and meetings already have bounded automatic skill loading (ADR 0073). Knowledge meetings and saved notes passed live acceptance. A temporary host with a scripted provider and pinned macOS ARM64 scanner also saved an inactive candidate and note, retained them after restart, and displayed the actual saved-skill receipt in the Office prompt components in EN/ID. Physical room movement remains unverified by that component run. |
| Provider and runtime claims | API/local-first setup and several Observe adapters | Keep catalog discovery distinct from real inference/tool capability. Certify only named provider, app version, OS, account/mode and control route actually tested. |
| Release and ecosystem | Existing updater, Bridge and platform CI | Reconcile pending dependency/review/platform gates; finish stable signing/notarization, complete provenance/Bridge security cases and any additional package smoke required by a broader claim. Existing preview publication does not certify those later gates. |

See [v1.1 gap map](prd-v1.1-gap-map.md) for partial requirements and [V2 acceptance map](prd-v2-acceptance-map.md) for staged contracts, Bridge gates and the distinction between planned acceptance and runnable evidence. V2 is not blanket authorization to enable engine switching, executable plugins, production dispatch or broader grants.

## Recommended execution order

1. Preserve the implemented handover record/ledger and complete real repeated-transfer acceptance before broadening external context access.
2. Add external Knowledge retrieval only behind explicit workspace/project bindings and the verified capabilities of each receiver.
3. Extend the implemented Grimoire marketplace with richer category/compatibility metadata and finish its end-to-end activation/update/rollback acceptance; retain fixture coverage, quarantine and immutable revisions.
4. Continue the app-flow tracker’s active Office and Native acceptance slices; pick general schedules or larger V1/V2 work only after checking their dependencies and acceptance gates.
5. Use the dated current checkpoint and retain historical evidence labels. Select the next V2-03/04/05/06 execution-authority increment only after its dependencies are clear; do not treat a stale status or a passing UI fixture as full acceptance.

## Verification note

The recent live Desktop run on v0.4.278 used an isolated QA workspace and vault. It verified that three scheduled knowledge meetings completed two rounds, wrote notes, and showed Office knowledge-meeting/saved-note notices. A new foreground task stopped the snoozed meeting timer, and a fresh interval began after the task settled. Three automatic curator runs skipped skill-candidate creation; therefore the saved-skill receipt and notification are **not** confirmed by that run. The external test harness ran the fixture's four Python unit tests; Native did not run commands. Physical arrival/seating in the 3D meeting room was not verified; these results are scoped to that isolated run.

A subsequent v0.4.286 source run used a temporary profile, scripted provider and
independently pinned v0.4.284 macOS ARM64 daemon with SkillSpector 2.13.4. It
saved a generated candidate awaiting approval and a vault note, and verified
both after restart. A browser harness mounted the actual Office prompt and
learning notice components, invoked the real scheduler and displayed its receipt
above the prompt in English/light and Indonesian/dark at 390 pixels. Dismissal
survived polling. The browser harness omitted the 3D canvas and installed Desktop.
