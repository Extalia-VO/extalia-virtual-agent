# Master PRD v1.1: gap map and upgrade plan

| | |
| --- | --- |
| Status | Planning; nothing in this document is implemented by it |
| Audited | 2026-10-21, repository v0.4.53 (code, ADRs 0001–0018, [orchestration ledger](native-orchestration-v1-handoff.md), [app-flow tracker](prd-app-flow-and-live-agents.md#11-status-tracker)); refreshed 2026-10-24 (v0.4.94) |
| Specification | [Master PRD v1.1](master-prd-v1.1/README.md): v1.0 baseline FR-01–FR-14 / AC-01–AC-15 plus FR-15–FR-24 / AC-16–AC-30 |
| Patch | [v1.1.1 technical blueprint](master-prd-v1.1/technical-blueprint-v1.1.1.md) and [handoff](master-prd-v1.1/implementation-handoff-v1.1.1.md), mapped in [§5](#5-patch-v111-technical-implementation) |

This map says, per requirement, what the repository actually has today and what is
missing, then orders the remaining work of v1.0 and v1.1 into one upgrade plan. It
replaces neither the [orchestration ledger](native-orchestration-v1-handoff.md) (stage
evidence) nor the app-flow tracker (retained UI/observer work): keep all three current.

Status words: **Delivered** (implemented and tested, acceptance may still need live
evidence), **Partial**, **Contract only** (types and validation in `@extalia/protocol`,
no runtime), **Missing**.

## 1. Functional requirements

### v1.0 baseline (FR-01–FR-14)

| FR | Status | What exists | What is missing |
| --- | --- | --- | --- |
| 01 First-run/shell | Delivered | Splash/boot coordinator, setup-only first run, Office landing, Chat/Office routes, restart (app-flow A1–A6, U6, U7, U9, U10) | Offline/corrupt-config end-to-end proof; packaging beyond the current desktop builds |
| 02 Native lead | Partial | Session lead plans missions (ADR 0010), user edits and launches | Lead-written final reports with verified/unverified split; pause/resume/reassign |
| 03 Heterogeneous subagents | Partial | Read-only DAG kernel, bounded concurrency, two-provider plans through the real host with scripted fetches (ADRs 0008–0012); write-capable native workers in per-task git worktrees, first slice (v0.4.72) | Live-provider certification; third provider |
| 04 Model registry/router | Partial | Provider connections and adapters; provider-reported usage only (ADR 0015) | Capability discovery, fallback routes with logged reasons, circuit breaker/backoff/health, versioned price table |
| 05 Tools/execution | Partial | Workspace-bounded tools, read-only mission tools; worktree isolation with a serial integration queue, test gate and digest-bound apply (v0.4.72); Changes panel and per-workspace test gate setting (v0.4.78, v0.4.81) | Idempotency keys, process-tree cancellation proof, Rust-side worktree leases and integration approvals, live AC-03 proof |
| 06 Durable graph | Partial | SQLite WAL checkpoints, atomic control events, budgets (ADRs 0013–0015); Rust leases/restart quarantine and running commit totals; read-only canonical recovery snapshots and explicitly owned terminal-shadow projection repair (gate 3.3A, v0.4.109, ADR 0030) | Independent heartbeat, live reaper/fencing and physical-settlement reconciliation of uncertain in-flight work (remaining gate 3.3) |
| 07 Observe | Delivered (acceptance open) | Transcript, hook and MCP adapters for Codex, Claude Code, Gemini CLI, Hermes; freshness states; labels-only privacy | Certified app versions; per-adapter capability declaration (observe/read/pause/control); ADR 0018 control bridge only proposed |
| 08 Mission Control/approvals | Partial | Missions page: DAG, task states, cancel, budget/usage; digest-bound skill activation approvals that expire after 10 minutes by default (v0.4.72); worktree apply only against the confirmed diff digest (v0.4.72, v0.4.78) | Digest-bound, expiring approvals enforced at mission task execution (gate 3.4); Rust-side integration approvals; approvals queue; evidence links; audit trail; Emergency Stop |
| 09 3D Office | Delivered (benchmark open) | Campus/floors, popover/modal, semantic bubbles, facility staff, spawn queue, mission worker projection (ADR 0016), Blender building and characters | Stated-hardware 40 FPS benchmark; staggered load-time seating |
| 10 Learning/experience | Contract only | `Experience`, `SkillCandidate`, `MemoryScope` types; Markdown memory notes with credential masking (`packages/host/src/memory.ts`) | Collector, scopes enforced, candidates, review, rollback (superseded in detail by FR-18/20/22) |
| 11 Automation | Missing | — | Triggers, schedules, idempotent runs, headless daemon |
| 12 Replay | Partial | Session event history, deterministic observed event ids | Mission replay with unknown gaps, correlation filters, retention/export |
| 13 Extensions | Missing | — | Versioned SDK, manifests, isolation, signing |
| 14 Theme/accessibility | Partial | Themes incl. Liquid Glass Pro, reduced motion/transparency | Full accessibility pass; theme GPU cost in a regression suite |

### v1.1 additions (FR-15–FR-24)

| FR | Status | What exists | What is missing |
| --- | --- | --- | --- |
| 15 Category skill routing | Missing | Skills load from built-in, user and workspace `SKILL.md` files; the TypeScript core lists the whole catalog in one `read_skill` tool (`packages/host/src/skills.ts`, `service.ts`); with the Rust core only active, verified revisions are offered (v0.4.78); core store has category and intent tables (v0.4.71) | Category/intent routing (router still open, v0.4.78), eligibility filters before ranking, per-subagent selection, `no_safe_skill`, selection rationale |
| 16 Mandatory scanner gate | Partial (W0 containment delivered; scanner missing) | W0: repository skills wait for a per-workspace allow bound to SHA-256, with consent UI and host API (v0.4.57, v0.4.69); Rust core quarantine, immutable revisions, fail-closed inspector, daemon skill operations and Skill Security Center (v0.4.71, v0.4.72, v0.4.78); `skill_read` labels user and workspace skills untrusted (v0.4.57) | Pinned scanner (still unpinned; `skill.scanner` reports the inspector status, v0.4.81), scanner verdicts, attestations, permission enforcement at the tool boundary. On the TypeScript core, user and allowed repository skills still reach the model **unscanned** |
| 17 Wikilinks/knowledge graph | Partial (index, graph and editing delivered; sharing and profiles missing) | Rust-core per-profile `knowledge.sqlite` over Markdown vaults: safe walker, front matter, wikilinks with aliases and resolution, rename-aware incremental sync (v0.4.81); local and whole-vault 3D graph (v0.4.88, v0.4.93); Knowledge page with CAS editing, history/rollback, user-chosen vault root and outside-edit watcher (v0.4.94) | Shared publish-only vault, workspace-visibility nodes, profile management, evidence links (next, v0.4.94) |
| 18 Hybrid learning/activation | Missing | Candidate type says approval is not activation; Rust skill approvals are bound to hash and permission digest and expire after 10 minutes (v0.4.72) | L1/L2/L3 policy, low-risk declarative auto-activation, learning-candidate approval (skill approvals already carry this binding) |
| 19 Agent capability registry | Partial | Runtime/connection capabilities (`packages/platform/src/capabilities.ts`), team roles | Per-agent categories, tools, permissions, health and provenance used for dispatch |
| 20 Memory hierarchy/provenance | Partial (import and provenance delivered; layers missing) | Memory notes import into the vault with provenance front matter, credential masking and a dry-run preview (v0.4.88, v0.4.94); the index shows front matter as declared, never verified (v0.4.88); conflicts become reviewable copies (v0.4.88, v0.4.94) | Working/episodic/semantic/procedural layers and claim-level provenance |
| 21 Dependency/compatibility | Missing | Skill store tables for dependencies, conflicts and compatibility, and `extalia-skill.json` validation (v0.4.71) | Dependency/compatibility resolver (still open, v0.4.78): manifest constraints, deterministic closure, cycle/conflict/escalation detection, pinning |
| 22 Learning sandbox | Missing | — | Disposable isolated evaluation, baseline comparison, `insufficient_evidence` |
| 23 Revalidation/sync | Partial (CAS writes, history and watcher delivered) | Atomic JSON/Markdown writes (`jsonStore.ts`); Rust-core compare-and-swap note writes with conflict copies, revision history and rollback (v0.4.88); watcher indexes outside edits (v0.4.94) | Shared publish-only vault (next, v0.4.94); revalidation triggers beyond the watcher and the 5-minute index refresh (v0.4.93) |
| 24 Learning dashboard | Missing | — | Evolve/Learning Center UI with lifecycle, reports, provenance, metrics |

**Profiles.** v1.1 isolates knowledge per *profile* (separate vaults and ACLs). Today a
"profile" is only UI preferences (`config/profile.json`) and isolation is per workspace.
A profile model that groups workspaces, vaults and skill activations is a prerequisite
for FR-15, FR-17, FR-20 and AC-10/AC-24.

**Scanner.** The PRD names a specific scanner and itself requires validating its CLI and
report format against a pinned official release. Its availability, licence and platform
support are not verified in this repository. Gate 2 must start by confirming them; until
then the adapter is an interface with a fail-closed "scanner unavailable" verdict, which
by AC-16/AC-26 keeps every package in quarantine.

## 2. Acceptance gates

None of AC-01–AC-30 is certified end to end today. Supporting evidence for AC-01–AC-15
is recorded in the [orchestration ledger](native-orchestration-v1-handoff.md#acceptance-ledger-master-prd-ac-01-through-ac-15).

| AC | Depends on | Nearest existing evidence |
| --- | --- | --- |
| 01 Setup | FR-01 | Setup/boot unit tests; headless mock flows |
| 02 Multi-provider | FR-03/04 | Scripted two-provider host test |
| 03 Worktree isolation | FR-05, stage 6 | — |
| 04 Crash recovery | gate 3.3 | Post-commit SIGKILL checkpoint recovery (no in-flight reconciliation) |
| 05 Read-only external | FR-07 | Observer tests; real Codex transcript observed end to end (v0.0.15) |
| 06 Freshness | FR-07 | Stall/no-response states (v0.0.43) |
| 07 Approval binding | gate 3.4 | Contract type with `parametersDigest` only |
| 08 Budget | FR-06/08 | Runtime/host exhaustion tests (ADR 0015) |
| 09 Skill rejection | FR-16/18 | — |
| 10 Memory scope | profiles, FR-20 | — |
| 11 Performance | FR-09 | Headless mock FPS only |
| 12 Mission/Office UX | FR-08/09 | Mock-verified Missions page and Office projection |
| 13 Facility/spawn | FR-09 | Spawn-queue unit test |
| 14 Replay | FR-12 | — |
| 15 Offline | FR-01/12 | — |
| 16, 17, 18, 26 Quarantine/scan/approval/attestation | FR-16 | — |
| 19, 20 Routing/compatibility | FR-15/21 | — |
| 21, 29 Candidates/unverified claims | FR-18 | Observed agent output already treated as untrusted data |
| 22, 23, 25 Vault without Obsidian, renames, concurrent edits | FR-17/23 | — |
| 24 Cross-profile ACL | profiles, FR-17 | — |
| 27 Headless idle | FR-16/18, §11 | Office pauses when hidden; no scanner/learning workers exist yet |
| 28 Regression rollback | FR-22 | — |
| 30 Vault prompt injection | FR-17, §8 | Imported/observed text is data by policy (transcripts, hooks) |

## 3. Upgrade plan

The v1.1 handoff orders its gates 0→5 and the v1.0 ledger leaves gates 3.3, 3.4 and
stages 4–9 open. Merged, with dependencies first. Each wave ends with tests, ledger and
tracker updates, `pnpm version:patch` and `pnpm check`.

| Wave | Scope | Why here | Exit proof |
| --- | --- | --- | --- |
| **W0 Containment** (small, first) — **Delivered** (scanner still missing, see FR-16) | Stop loading repository `.extalia/skills` without the user's consent; mark user/workspace skills as untrusted data in the tool text; record their content hash | FR-16 security gap exists today; this does not wait for the scanner | Test: a cloned repository's skill is not offered until allowed; built-in skills unchanged |
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

Still open:

2. **Profiles:** started with the recommended default (2026-10-22, [ADR 0024](../adr/0024-profiles-acl-and-vault-roots.md)):
   one `default` profile holds every existing workspace; vault under the data directory.
   The owner can name more profiles and move workspaces before W5 ships.
3. **Scanner:** confirm the scanner the PRD names (official source, version, licence,
   macOS/Windows support) before W3 depends on it. Until then the adapter reports the
   scanner as unavailable and every package stays quarantined ([ADR 0023](../adr/0023-skill-scanner-adapter-pinning.md)).
8. **Benchmark gate:** the proposed thresholds in
   [native-core-2026-10-22](../benchmarks/native-core-2026-10-22.md) are adopted as the default-on
   gate (2026-10-22, recommended option); the daemon becomes default only after a re-run on AC
   power on Apple silicon and one x64 Windows machine with the release candidate build.
10. **Built-in skills:** exempt from the scanner gate because they ship signed inside the app
   and change only with an app release (2026-10-22, recommended option); user, workspace,
   imported and generated skills always pass the gate.

## 5. Patch v1.1.1: technical implementation

The [blueprint](master-prd-v1.1/technical-blueprint-v1.1.1.md) adds no requirements. It
fixes the architecture: Rust owns task state, permissions, approvals and skill activation;
Python is a stdio worker started on demand; the codebase is extended, not rewritten; the
first pass is a read-only audit. Its §13 states it was written without the source, so these
are the repository facts it must be adapted to:

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
| `workers/intelligence` | No Python runtime (only Blender asset scripts) | New; created first for the scanner if the pinned scanner needs Python |

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

