# Master PRD v1.1: gap map and upgrade plan

| | |
| --- | --- |
| Status | Current implementation/gap reconciliation; acceptance remains scoped, not blanket-certified |
| Audited | Historical baseline 2026-10-21 / v0.4.53 and 2026-10-24 / v0.4.94; source/document reconciliation 2026-11-12 at v0.4.288, ADRs through 0078 |
| Specification | [Master PRD v1.1](master-prd-v1.1/README.md): v1.0 baseline FR-01–FR-14 / AC-01–AC-15 plus FR-15–FR-24 / AC-16–AC-30 |
| Patch | [v1.1.1 technical blueprint](master-prd-v1.1/technical-blueprint-v1.1.1.md) and [handoff](master-prd-v1.1/implementation-handoff-v1.1.1.md), mapped in [§5](#5-patch-v111-technical-implementation) |

This map says, per requirement, what the repository actually has today and what is
missing, then orders the remaining work of v1.0 and v1.1 into one upgrade plan. It
replaces neither the [orchestration ledger](native-orchestration-v1-handoff.md) (stage
evidence) nor the app-flow tracker (retained UI/observer work): keep all three current.

Status words: **Delivered** (implemented and tested, acceptance may still need live
evidence), **Partial**, **Contract only** (types and validation in `@extalia/protocol`,
no runtime), **Missing**.

**Evidence boundary (2026-11-12):** this update reviews the v0.4.288 source,
existing tests and dated evidence; it does not rerun live providers, scanners,
Desktop installers or third-party applications. [Release v0.4.288](../release/v0.4.288.md)
records the distributed scope. The [v2 acceptance map](prd-v2-acceptance-map.md)
retains broader gates. “Delivered” applies only to the named slice; source,
scripted-provider, real-app and packaged-platform evidence are different.

## 1. Functional requirements

### v1.0 baseline (FR-01–FR-14)

| FR | Status | What exists | What is missing |
| --- | --- | --- | --- |
| 01 First-run/shell | Delivered (platform acceptance scoped) | Shared Web/Desktop shell, splash, setup, optional initial workspace and model-test-first flow; Office landing and restart | Complete corrupt-config/offline acceptance and per-platform clean-machine cases for every claimed feature |
| 02 Native lead | Partial | Session lead plans missions (ADR 0010), user edits and launches | Lead-written final reports with verified/unverified split; pause/resume/reassign |
| 03 Heterogeneous subagents | Partial | DAG kernel with read-only defaults, bounded concurrency, two-provider plans through the real host with scripted fetches (ADRs 0008–0012); write-capable native workers in per-task git worktrees, first slice (v0.4.72) | Real acceptance of three parallel tasks across at least two provider implementations, with failure isolation |
| 04 Model registry/router | Partial | Connection catalog, Rust-owned OpenAI-compatible model discovery (ADR 0070), connection-owned model selection/fallback and reported usage | Broad provider/account certification, complete versioned pricing/cost policy and failure accounting; production completion remains TypeScript by measured ADR 0071 decision |
| 05 Tools/execution | Partial | Workspace-bounded file tools; read-only mission defaults and explicit write tasks in isolated Git worktrees; Changes panel, proposals and digest-bound validation contracts. Production test gate is not run (`gate_failed` / `not_run`) and Apply refuses proposals | Verified isolated command/integration executor, idempotency keys, process-tree cancellation proof, Rust-side writer/worktree leases, integration approvals and live AC-03 proof |
| 06 Durable graph | Partial | SQLite WAL checkpoints, atomic control events, budgets (ADRs 0013–0015); Rust leases/restart quarantine and running commit totals; read-only canonical recovery snapshots and explicitly owned terminal-shadow projection repair (gate 3.3A, v0.4.109, ADR 0030); independent exact-claim lease heartbeat, expiry fencing and runtime authority-loss latch (gate 3.3B, v0.4.118, ADR 0031); periodic daemon reaping/quarantine (gate 3.3C, v0.4.119, ADR 0032); immutable execution admissions and weak turn-promise observations (gate 3.3D1, v0.4.120, ADR 0033); sealed local-operation tracking and scoped local-drain proofs (gate 3.3D2, v0.4.121, ADR 0034); atomic canonical recovery review with scoped digest and explicit missing membership (gate 3.3D3 prerequisite, v0.4.122, ADR 0035) | Physical-settlement reconciliation of uncertain in-flight work and Rust-owned writer fencing (remaining gate 3.3) |
| 07 Observe | Delivered slices; acceptance open | Structured transcripts, hooks, shared prompt/approval presentation, capability-bound Codex controls, cooperative inboxes, observed workspace association and handover (ADRs 0060–0064, 0072, 0076, 0078) | Per-app/version/mode certification and real repeated cross-app handover; hook trust or submitted delivery is not execution ownership |
| 08 Mission Control/approvals | Partial | Missions page: DAG, task states, cancel, budget/usage; digest-bound skill activation approvals that expire after 10 minutes by default (v0.4.72); worktree inspection/proposals with digest checks; production test gate is not run and Apply refuses | Digest-bound, expiring approvals enforced at mission task execution (gate 3.4); Rust-side integration approvals; approvals queue; evidence links; audit trail; Emergency Stop |
| 09 3D Office | Delivered (benchmark open) | Campus/floors, popover/modal, semantic bubbles, facility staff, spawn queue, mission worker projection (ADR 0016), Blender building and characters | Declared-hardware >40 FPS and whole-app memory/load acceptance; adaptive resolution and staged arrivals do not certify representative hardware |
| 10 Learning/experience | Partial (production slices implemented) | Rust learning records, explicit prompt-generated candidates, profile-scoped curation, deferred post-task learning and saved notes/candidates (ADRs 0050, 0066–0067, 0074–0075) | Reviewed improvement metrics, isolated evaluation, full memory hierarchy/claim provenance and cross-store reconciliation; Windows artifact staging unavailable |
| 11 Automation | Partial (special-purpose timers only) | Deferred-learning/knowledge-meeting timers and pending prompt queues | General user-created schedules/triggers, missed-run policy, idempotent scheduled sessions and standalone headless service; timers are not general automation |
| 12 Replay | Partial | Session event history, deterministic observed event ids | Mission replay with unknown gaps, correlation filters, retention/export |
| 13 Extensions | Missing | — | Versioned SDK, manifests, isolation, signing |
| 14 Theme/accessibility | Partial | Themes incl. Liquid Glass Pro, reduced motion/transparency | Full accessibility pass; theme GPU cost in a regression suite |

### v1.1 additions (FR-15–FR-24)

| FR | Status | What exists | What is missing |
| --- | --- | --- | --- |
| 15 Category skill routing | Partial (automatic managed context implemented) | Categorized built-in/user/project catalog, bounded discovery, exact registered reads, deterministic EN/ID selection and load receipts for Native Chat, ordinary delegates and meetings (ADRs 0057, 0073); runtime marketplace previews/imports (ADR 0077) | Authoritative dependency/compatibility resolver and full agent-capability dispatch; canonical mission workers and observed apps have separate skill-context contracts. Local matching is not semantic inference |
| 16 Mandatory scanner gate | Partial (mandatory ingress and supported scanner delivered) | No unscanned external fallback (ADR 0049); exact registry revisions and pinned SkillSpector 2.13.4 with bundled CPython 3.13.18, confinement, rescan, separate review/approval/activation on macOS 14+ ARM64 (ADR 0068) | Verified scanner isolation on Intel macOS/Windows/Linux; code/tool evaluation and complete effect-time authority. Missing/incomplete scans stay quarantined |
| 17 Wikilinks/knowledge graph | Partial (usable Knowledge delivered) | Rust index, wikilinks/backlinks, managed-note CAS, history/rollback, external watcher and user vault selection; interactive 2D/3D graph without requiring Obsidian; stable workspace vault profiles (ADRs 0051, 0065, 0074) | Full user-managed profile/ACL sharing, publish-only shared vault, verified claim-level evidence and all V2-17A acceptance |
| 18 Hybrid learning/activation | Partial | Explicit and automatic candidate capture, source/evidence records, user-reviewed decisions and separate digest-bound skill approval/activation; automatic curation does not autoactivate skills (ADRs 0050, 0066–0068) | Reviewed L1/L2/L3 policy, isolated evaluation, quality-based promotion and rollback acceptance; no claim that a security scan proves skill quality |
| 19 Agent capability registry | Partial | Runtime/connection capabilities (`packages/platform/src/capabilities.ts`), team roles | Per-agent categories, tools, permissions, health and provenance used for dispatch |
| 20 Memory hierarchy/provenance | Partial | Progressive metadata/search/paged memory reads, bounded recall, revision-bound editing, context budgets and provenance-bearing vault imports (ADRs 0045, 0055–0056); saved handover archives/notes are distinct (ADR 0076) | Full working/episodic/semantic/procedural hierarchy, claim-level provenance, cross-store conflict handling and reviewed continuation/compaction |
| 21 Dependency/compatibility | Partial (diagnostic preflight; no activation integration) | Skill store relation tables and manifest validation (v0.4.71); [exact-pin preflight](../adr/0039-read-only-skill-dependency-preflight.md) with bounded range/graph diagnostics, actual staged-source snapshot, conflicts/reverse constraints, cycles and literal permission ceilings (v0.4.137); optional daemon/host and localized Skills diagnostics (v0.4.138) | Authoritative activation/runtime integration, verified compatibility facts and grants, effect-time revalidation; existing `resolver_unavailable` gate remains closed. No scanner bypass or automatic version selection |
| 22 Learning sandbox | Missing (general evaluation) | Scanner confinement and Rust-owned artifact staging are specific implemented paths, not general skill evaluation | Disposable evaluation with baseline comparison, complete ownership, measured quality and `insufficient_evidence` refusal before promotion |
| 23 Revalidation/sync | Partial | CAS/history/conflict copies, external vault watcher, lazy profile index, per-request active skill revision verification and explicit rescans (ADRs 0068, 0073–0074) | Shared publish-only vault, comprehensive cross-store revalidation and conflict/ACL acceptance |
| 24 Learning dashboard | Partial (inspection surfaces) | Skill Security Center lifecycle/report summaries, Native memory controls, learning scheduling/status and saved-artifact notices | Unified Evolve quality/provenance dashboard, evaluation comparisons and measured promotion metrics |

**Profiles.** Core profile scoping and stable workspace vault profiles now exist;
the earlier “UI preferences only” description is obsolete. Complete user-managed
profile switching, shared visibility/ACL enforcement and simultaneous-profile
acceptance remain distinct V2-07/V2-17A work.

**Scanner.** The earlier “unpinned/no worker” description is obsolete. ADR 0068
records a real pinned scanner and bundled interpreter on macOS 14+ ARM64.
Other targets fail closed; no scan approves, activates or proves the quality of
a skill. [Security Center](../getting-started/skill-security-center.md) documents
supported flows, including explicit prompt learning. Generic document reading
does not silently create a library skill.

## 2. Acceptance gates

No blanket certification of AC-01–AC-30 is recorded by this reconciliation. Scoped
source, browser and packaged evidence below supports individual assertions; it
does not close the full gates. Supporting evidence for AC-01–AC-15 is recorded in the [orchestration ledger](native-orchestration-v1-handoff.md#acceptance-ledger-master-prd-ac-01-through-ac-15).

| AC | Depends on | Nearest existing evidence |
| --- | --- | --- |
| 01 Setup | FR-01 | Setup/boot unit tests; headless mock flows |
| 02 Multi-provider | FR-03/04 | Scripted two-provider host test |
| 03 Worktree isolation | FR-05, stage 6 | — |
| 04 Crash recovery | gate 3.3 | Post-commit SIGKILL checkpoint recovery (no in-flight reconciliation) |
| 05 Read-only external | FR-07 | Observer tests; real Codex transcript observed end to end (v0.0.15) |
| 06 Freshness | FR-07 | Stall/no-response states (v0.0.43) |
| 07 Approval binding | gate 3.4 | Exact skill activation/apply digests and pending admission-bound action intents (ADR 0038); durable general effect-time grant acceptance remains open |
| 08 Budget | FR-06/08 | Runtime/host exhaustion tests (ADR 0015) |
| 09 Skill rejection | FR-16/18 | ADRs 0049/0068: mandatory ingress, malicious/incomplete scan refusal and explicit activation checks; supported platform scope only |
| 10 Memory scope | profiles, FR-20 | ADRs 0045/0055/0074: workspace/profile-bound reads and revisions; full ACL acceptance remains open |
| 11 Performance | FR-09 | Headless mock FPS only |
| 12 Mission/Office UX | FR-08/09 | Mock-verified Missions page and Office projection |
| 13 Facility/spawn | FR-09 | Spawn-queue unit test |
| 14 Replay | FR-12 | — |
| 15 Offline | FR-01/12 | — |
| 16, 17, 18, 26 Quarantine/scan/approval/attestation | FR-16 | ADR 0068 native, host/UI and actual ARM64 preview-package evidence; other scanner platforms and full evaluation remain open |
| 19, 20 Routing/compatibility | FR-15/21 | ADRs 0039/0040 diagnostic preflight/routing; ADR 0073 managed context loading. Authoritative resolver/dispatch acceptance remains open |
| 21, 29 Candidates/unverified claims | FR-18 | ADRs 0050/0066–0068 and deferred-learning evidence: saved inactive candidates and notes; quality promotion not established |
| 22, 23, 25 Vault without Obsidian, renames, concurrent edits | FR-17/23 | Rust Knowledge tests, host edit/watcher tests and graph review; no Obsidian dependency. Full V2-17A acceptance remains open |
| 24 Cross-profile ACL | profiles, FR-17 | — |
| 27 Headless idle | FR-16/18, §11 | Lazy daemon/scanner and bounded deferred-learning ownership; complete headless long-duration acceptance not established |
| 28 Regression rollback | FR-22 | — |
| 30 Vault prompt injection | FR-17, §8 | Imported/observed text is data by policy (transcripts, hooks) |

## 3. Upgrade plan

The v1.1 handoff orders its gates 0→5 and the v1.0 ledger leaves gates 3.3, 3.4 and
stages 4–9 open. Merged, with dependencies first. Each wave ends with tests, ledger and
tracker updates, `pnpm version:patch` and `pnpm check`.

| Wave | Scope | Why here | Exit proof |
| --- | --- | --- | --- |
| **W0 Containment** (small, first) — **Delivered containment** (real scanner now supported on macOS 14+ ARM64; see FR-16) | Stop loading repository `.extalia/skills` without the user's consent; mark user/workspace skills as untrusted data in the tool text; record their content hash | FR-16 security gap exists today; this does not wait for the scanner | Test: a cloned repository's skill is not offered until allowed; built-in skills unchanged |
| **W1 Contracts & ADRs** (v1.1 gate 1) | ADRs: profile model and ACL, vault roots, skill manifest, immutable skill revisions, scanner adapter, permission enforcement point, evidence model, schema migrations | The v1.1 handoff asks for audit + ADRs + contracts before code | Typed contracts with denial tests (ACL, permission, hash mismatch) |
| **W2 Durable control** (v1.0 gates 3.3, 3.4) | Leases/heartbeat/reaper/reconciliation; digest-bound expiring approvals enforced in the executor; approvals queue | Skills, learning and write workers all reuse approval and recovery | AC-04, AC-07 |
| **W3 Secure skill registry** (v1.1 gate 2) | Quarantine store, revisions, scanner adapter (fail closed), manifest/permission diff, dependency/compatibility resolver, category index and router, audited activation/rollback | Needs W1 contracts and W2 approvals | AC-16–AC-20, AC-26, AC-28 (scanner-dependent parts only after the release is verified) |
| **W4 Workspace isolation** (v1.0 stage 6) | Write-capable workers in git worktrees, ownership, integration queue, conflict review, test gates | PRD: stages 2/3/6 matter most for a useful product; needed by W6 sandboxing | AC-03 |
| **W5 Knowledge foundation** (v1.1 gate 3) | Profiles, per-profile vaults, frontmatter ids, wikilinks, SQLite graph index, watcher, conflict copies, provenance; memory notes migrate into the vault model | Independent of W3/W4 after W1 | AC-22–AC-25, AC-30 |
| **W6 Evolve** (v1.1 gate 4, v1.0 stage 7) | Experience capture, L1/L2 updates, candidates, sandbox evaluation in worktrees, hybrid activation, Learning Center | Needs W3 (gate), W4 (sandbox), W5 (knowledge) | AC-09, AC-10, AC-21, AC-29 |
| **W7 Live acceptance** | Real providers (AC-02, AC-08), certified observed app versions (AC-05, AC-06), Mission Control evidence, replay (AC-14), offline (AC-15) | Runs alongside W3–W6 when credentials and app versions are available | AC-01, 02, 05, 06, 08, 12–15 |
| **W8 Automation & ecosystem** (v1.0 stages 8–9) | Triggers/schedules/headless daemon; SDK, signing, packaging, hardening | After the core is durable and governed | AC-11, AC-27 and release gates |

Patch v1.1.1 settles PRD §16 item 2: Rust becomes the control-plane authority, introduced
behind contracts without a rewrite; Python stays an on-demand worker. How that changes the
waves is in [§5](#5-patch-v111-technical-implementation).

## 4. Owner decisions

Decided 2026-10-21 (the owner accepted the recommended option for each):

1. **Repository skills (W0):** blocked until the user allows each skill for that workspace,
   bound to its SHA-256; shipped in W0.
4. **Order:** W2 (durable control) before W3 (skills).
5. **Rust toolchain:** pinned with `rust-toolchain.toml`; `pnpm check` and CI run
   `cargo fmt`, `clippy` and `test` once the first crate exists ([ADR 0021](../adr/0021-rust-integration-strategy.md)).
6. **Daemon process model:** sidecar started by Desktop over stdio; a separately installed
   service waits for W8 ([ADR 0020](../adr/0020-daemon-ipc-transport.md)).
7. **Python distribution:** bundled in the installer (pinned relocatable Python and a locked
   worker environment built in CI); nothing is downloaded on the user's machine; never
   required for chat or orchestration ([ADR 0022](../adr/0022-python-worker-distribution.md)).
9. **Self-contained installers:** whoever installs Extalia needs nothing else. Desktop
   bundles Node (Electron), the Rust daemon binary and the Python worker; the CLI brings the
   daemon through per-platform npm packages. Only contributors install Rust/Python/Node.
   Release gate: the packaged app runs on a clean machine without any of them.

Current follow-up to the historical decisions:

2. **Profiles:** started with the recommended default (2026-10-22, [ADR 0024](../adr/0024-profiles-acl-and-vault-roots.md)):
   one `default` profile holds every existing workspace; vault under the data directory.
   The owner can name more profiles and move workspaces before W5 ships.
3. **Scanner:** source/version/license pin and macOS 14+ ARM64 implementation are
   recorded in [ADR 0068](../adr/0068-pinned-skillspector-inspection.md). Intel macOS,
   Windows and Linux confinement/packaging acceptance remains open; unavailable
   targets retain quarantine. ADR 0023 is the original design history.
8. **Benchmark gate:** the proposed thresholds in
   [native-core-2026-10-22](../benchmarks/native-core-2026-10-22.md) are adopted as the default-on
   gate (2026-10-22, recommended option); the daemon becomes default only after a re-run on AC
   power on Apple silicon and one x64 Windows machine with the release candidate build.
10. **Built-in skills:** canonical shipped procedures remain separate from external
   scanner results and change with the app release; source flags and names cannot
   impersonate them (ADRs 0049/0073). User, workspace, imported and generated skills
   always pass the external gate. Ad-hoc preview signing is not Apple notarization.

## 5. Patch v1.1.1: technical implementation

The tables in this section preserve the original audit/progress sequence through
v0.4.118. “Today”, “Missing” and “next” inside them describe that historical
checkpoint, not v0.4.288. Use §§1–2 above and the current
[v2 acceptance map](prd-v2-acceptance-map.md#current-implementation-checkpoint)
for current status. ADR 0071 supersedes a mandatory language-only migration
target: production completion remains TypeScript after measured native prototypes.
The supported scanner/Python worker in ADR 0068 is implemented; a general Python
executor remains planned.

The [blueprint](master-prd-v1.1/technical-blueprint-v1.1.1.md) adds no requirements. It
fixes the architecture: Rust owns task state, permissions, approvals and skill activation;
Python is a stdio worker started on demand; the codebase is extended, not rewritten; the
first pass is a read-only audit. Its §13 states it was written without the source, so these
are the repository facts it must be adapted to:

The following table records the original blueprint assumptions and the current
reconciliation; dated wave entries below retain their historical scope. In
particular, later workspace isolation refuses production integration test/apply
until a verified isolated executor exists.

| Blueprint assumes | Repository today | Consequence |
| --- | --- | --- |
| New `packages/contracts` | `@extalia/protocol` already holds versioned wire contracts with validation and tests (ADR 0007) | Extend `@extalia/protocol` and generate JSON Schema for Rust/Python from it instead of a second contracts package (audit decides) |
| Rust owns SQLite | `@extalia/host` owns the mission database through `node:sqlite` (`DatabaseSync`, WAL, schema v2, ADRs 0013–0014) | **The main migration.** Ownership moves to the daemon by a tested migration; the TS host becomes its client. Strangler order: daemon behind the existing `AgentHostApi`, parity tests on ADR 0013/0014 semantics, feature flag, rollback |
| IPC to be chosen | Desktop: context isolation + `contextBridge` preload. Web: CLI Bridge, HTTP + SSE on 127.0.0.1 with a per-launch token and Host allow-list | Already authenticated loopback. The daemon can sit behind host/bridge over a local socket; Axum only if the daemon exposes its own API |
| Kernel to build (phases 2–3) | TypeScript DAG kernel (`@extalia/runtime`) and host missions with checkpoints, atomic events and budgets (ADRs 0008–0015) | Rust phase 2 ports proven semantics and their tests, it does not invent new ones |
| Providers | TypeScript providers (ADR 0005), keychain secrets | May stay TypeScript adapters behind a `ModelProvider` port at first; moving them is a separate ADR |
| `docs/adr/0001-*` | ADRs 0001–0018 exist (0017 unused) | New ADRs start at 0019 |
| `apps/web/src/features/*` | No `features/` folder; features are flat folders under `apps/web/src/` (`missions`, `office`, `chat`, `approvals`, …) | Keep; no move |
| Top-level `tests/` | Per-package `test/` with Vitest, one `pnpm check` | Keep; add cargo/pytest to the check only when a crate/worker exists |
| `workers/intelligence` | No Python runtime or bundled worker (only Blender asset scripts; re-audited v0.4.118) | New; created first for the scanner if the pinned scanner needs Python |

### Phase ↔ wave map

| Blueprint phase | Wave | State |
| --- | --- | --- |
| 0 Audit (read only) | **new, after W0** | Accepted 2026-10-21: [REPO_AUDIT.md](../implementation/REPO_AUDIT.md) and ADRs [0019](../adr/0019-sqlite-driver-and-database-ownership.md)–[0023](../adr/0023-skill-scanner-adapter-pinning.md) (Accepted) |
| 1 Contracts | W1 | **Delivered for the daemon path** (v0.4.58): JSON Schema generation with drift check and golden fixtures, daemon wire contract v1, async acknowledgement port (ADR 0014 amendment); ADRs 0024–0027 proposed. Skill/profile/evidence typed contracts follow their ADRs in W3/W5 |
| 2 Minimal Rust kernel | W2 | TypeScript equivalent delivered (Stages 2, 3.1, 3.2); Rust none. W2 becomes: daemon slice A (one durable task, restart, permissions) with leases and approvals built there, not in TypeScript. **Progress (v0.4.59):** audit PRs 4–5 delivered — Cargo workspace, `extalia-daemon` stdio handshake (`hello`, `health`) with fixture parity, `extalia-core` `core.sqlite` schema 1 with fail-closed migrator; **v0.4.69:** PR 6 (durable task, lease, restart recovery, single-writer lock) and PR 7 (`permission.check`, 2,560-case parity) delivered; **v0.4.70:** PR 8 (host client behind `nativeCore` flag, deny when unavailable) and PR 9 (self-contained packaging, clean-machine gate) delivered, plus shared transition tables; **v0.4.71:** PR 10 benchmark delivered (thresholds proposed, owner decides default-on) |
| 3 Multi-model + concurrency | W2 → W7 | Scripted two-provider proof in TypeScript; ≥3 subagents on ≥2 live providers missing |
| 4 Secure skills | W3 | Missing (W0 closes the current gap first, in TypeScript). **v0.4.71:** slice 1 in the Rust core (quarantine, immutable revisions, manifest, lifecycle, fail-closed inspector, audited activation); wire ops, resolver, router and UI next. **v0.4.72:** slice 2 daemon operations (import, list, inspect, approve, activate, deactivate, rollback, revoke, read); review storage (migration 0004), host client and Skill Security Center UI next. **v0.4.78:** schema 4 + `skill.review`; host skill service and Skill Security Center UI; agents get user/project skills only from active verified revisions when the Rust core is on. Open: real scanner pin, dependency resolver, evaluation sandbox, category router, workspace ids in the skill contract (UUID vs host `w_…`), scanner-pin reporting op. **v0.4.81:** host workspace ids accepted (schema 5), consent shown as review input, `skill.scanner` status |
| 5 Obsidian/graph | W5 | Missing. **v0.4.81:** slice 1 in the Rust core: per-profile rebuildable `knowledge.sqlite`, vault walker, front matter, wikilinks, resolution, incremental sync, scoped queries; daemon ops, watcher/sync writes, host/UI and memory import next. **v0.4.88:** daemon knowledge ops (read + sync), safe CAS writes with conflict copies + history + rollback, memory import (core), Knowledge page UI (mock); next: host knowledge service, write/import ops on the wire, watcher, user-chosen vault root, shared vault. **v0.4.93:** host knowledge service (real data with the Rust core), `knowledge.overview`, whole-vault 3D graph (worker layout, instanced, 60 fps at 2,000 notes); next: write/import ops on the wire with a conflict UI, watcher, user-chosen vault root, shared vault. **v0.4.94:** editing with CAS + conflict UI, history/rollback, memory import, user-chosen vault root, host watcher; next: shared publish-only vault, workspace-visibility nodes, profile management, evidence links (W6 prep) |
| 6 Learning | W6 | Missing. **v0.4.95:** slice 1 in the Rust core (ADR 0029 proposed, schema 6): experiences, evidence trust by kind, candidates with `insufficient_evidence`, user-only digest-bound decisions; daemon ops and Learning Center UI next |
| 7 UX/observe | W7 | Missions page and Office projection exist; Skill Security Center and Knowledge Graph missing |
| 8 Hardening/release | W8 | Missing |
| — (not in the blueprint) | W4 workspace isolation | Kept: PRD stage 6, required by sandbox evaluation. **v0.4.72:** slice 1 in the TS host (ADR 0028 proposed): worktrees per write task, integration queue with test gate and digest-bound apply, orphan detection; UI, journal edit activity and Rust-side leases next. **v0.4.78:** Changes panel UI, worktree host API, journal edit activity (shared admission table); open: workspace gate setting, Rust-side worktree leases/approvals, live AC-03. **v0.4.81:** workspace gate setting (no ungated apply) |

Order after the patch: **W0** (TypeScript, closes today's skill gap) → **phase 0 audit**
(documents only) → **W1** contracts + ADRs → **W2** as the first Rust slice behind the
contracts with TypeScript parity → W3–W8 as in §3. No production code changes before the
audit is accepted.

