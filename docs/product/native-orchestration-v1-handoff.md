# Native orchestration v1: implementation ledger and continuation handoff

Updated: 2026-10-18. Scope: baseline audit, Stage 1 contracts, Stage 2 kernel/host, lead planning, Missions UI, reliability hardening, transactional checkpoints, atomic events (3.1) and runtime budgets (3.2).
This ledger records current implementation evidence, not a claim that the v1 PRD
is complete. Continue updating it after each stage.

## Planning sources and precedence

**Update 2026-10-21:** the master PRD is now v1.1 and lives in the repository as
[master-prd-v1.1](master-prd-v1.1/README.md) (private names neutralised). It keeps
the v1.0 baseline below and adds FR-15–FR-24 / AC-16–AC-30 (secure skills,
knowledge vaults, learning). The merged status and upgrade order are in the
[v1.1 gap map](prd-v1.1-gap-map.md); this ledger keeps recording stage evidence.
Patch v1.1.1 (same day) makes Rust the control-plane authority behind contracts and
requires a read-only repository audit before runtime changes ([gap map §5](prd-v1.1-gap-map.md#5-patch-v111-technical-implementation)).

**W0 (2026-10-21):** repository skills are contained. `loadSkills` offers a workspace's
`.extalia/skills/*/SKILL.md` only when the user allowed that skill for that workspace,
bound to the file's SHA-256 (`<data>/workspaces/<id>/skill-consent.json`, tied to the
project folder); new or edited skills come back as `pending` (`not-allowed` / `changed`)
and never reach the model. Host API: `workspaceSkills`, `allowWorkspaceSkills`,
`revokeWorkspaceSkills`. `skill_read` labels user and workspace skills untrusted and
wraps their text with a notice. Evidence: `packages/host/test/skillConsent.test.ts`. No
scanner and no UI for pending skills yet (gap map FR-16, W3).

**W1 (2026-10-21):** phase 0 audit ([REPO_AUDIT.md](../implementation/REPO_AUDIT.md)) and
ADRs 0019–0023 accepted, 0024–0027 proposed. `@extalia/protocol` emits JSON Schema for
Mission/Task/AgentEvent/Approval/Permission and the daemon wire contract v1
(`daemon.ts`, `daemonValidate.ts`, `daemonFrame.ts`), checked by `tooling/generate-schemas.mjs
--check` in `pnpm lint`; fixture parity in `packages/protocol/test/jsonSchema.test.ts` and
`daemon.test.ts`. The runtime kernel accepts an opt-in `commitEventAsync` with the same
ADR 0014 guarantees (`packages/runtime/test/missionAsyncAcknowledgement.test.ts`); the host
still uses the synchronous sink.

**W2 start (2026-10-21):** audit PRs 4–5. `crates/extalia-daemon` answers `hello`/`health`
over length-prefixed stdio frames and rejects other operations per the contract
(`crates/extalia-daemon/tests/{contract,daemon}.rs` read the shared protocol fixtures);
`crates/extalia-core` owns `state/core.sqlite` (schema 1, `migrations/0001_core.sql`,
exact-schema check, backup before upgrade; tests in `src/adapters/sqlite/tests.rs`).
`tooling/check-rust.mjs` runs in `pnpm check` and CI. Not yet: durable task slice A,
`permission.check`, host client and flag, packaging, file lock on `core.sqlite`.

**W2 slice A (2026-10-22):** audit PRs 6–7. The daemon serves `mission.create`,
`task.transition` and `event.commit` with one transaction each, per-mission sequences,
digest idempotency, ADR 0014 caps and admission rules, leases, and restart recovery to
`unknown`/`recovering` without replay (`crates/extalia-core/src/adapters/sqlite/mission_tests.rs`,
`crates/extalia-daemon/tests/missions.rs` incl. a SIGKILL mid-burst test); a sibling
`core.sqlite.lock` admits one daemon (exit 4 otherwise). `permission.check` ports
`decide()` with a 2,560-case shared matrix (`packages/runtime/test/permissionMatrix.test.ts`,
`crates/extalia-daemon/tests/permissions.rs`). Open: a shared `TASK_TRANSITIONS` table in
`@extalia/protocol` (the daemon derived its own), daemon-side latch after
`storage_failure`, a read operation, `deadlineMs` enforcement, host client (PR 8).

**W2 host wiring and packaging (2026-10-22):** shared `TASK_TRANSITIONS`/`MISSION_TRANSITIONS`
(`packages/protocol/src/transitions.ts`, `schemas/transitions.json`) now drive the Rust rules
(closes the table item above). Audit PR 8: `packages/host/src/daemon/` sidecar client behind
`nativeCore: 'rust'` (default `typescript`); tool calls denied with `policy_unavailable` when the
daemon is unavailable, no TS fallback; host mission suites parameterized over both backends
(`missions.test.ts`, `missionBudget.test.ts`, `missionDaemon.test.ts`). Audit PR 9:
`tooling/build-daemon.mjs`, `<resources>/daemon/` in Desktop, `@extalia/daemon-*` npm templates,
release matrix for five targets, clean-machine gate (`tooling/clean-machine-smoke.mjs`,
`apps/desktop/scripts/packaged-smoke.mjs`; see `docs/release/packaging.md`). Open: PR 10
benchmark gate (delivered same day, see below); ~~host `recoverRun` rewrites every task of a
running run to `unknown`~~ fixed 2026-10-22 (only in-flight tasks, ADR 0013 amendment); display/result snapshot is not
committed atomically with the daemon's terminal event; CI runs the real-binary host tests
only in the Rust job once added; npm scope `@extalia` and `extalia-vo` are unclaimed.

**W2 gate and W3 start (2026-10-22):** audit PR 10 benchmark (`tooling/bench/native-core.mjs`,
results and proposed default-on thresholds in `docs/benchmarks/native-core-2026-10-22.md`):
Rust commits 2.4–3.3× the TS throughput, populated cold start ~0.09×, recovery 0.2–0.5×;
both stores' commit cost grew with journal depth — fixed 2026-10-23 with running totals (gate 10 now passes). W3 slice 1: `crates/extalia-core/src/skills/`
and `migrations/0002_skills.sql` (quarantine, tree hash `extalia.skill-tree.v1`, manifest,
lifecycle, fail-closed inspector, audited activation; ADR 0025 amendment). Next W3: daemon
wire ops + host wiring, review recording, dependency resolver, category router, W0 consent
as review input; owner decision whether built-in skills are exempt from the scanner gate.

The supplied planning pack comprises `README.md`, `EXTALIA_MASTER_PRD_V1.md`
and `AGENT_IMPLEMENTATION_HANDOFF.md`. It is a target specification, not an
implementation patch. The current repository and observed test results establish
the baseline. The existing [app-flow PRD](prd-app-flow-and-live-agents.md) remains
the tracker for retained UI/observer work. Never copy private example workspace
names, persona names, paths or endpoints from planning into this public project.

Read `AGENTS.md`, `CONTRIBUTING.md`, the app-flow PRD working protocol,
[architecture overview](../architecture/overview.md) and
[ADR 0007](../adr/0007-native-orchestration-contracts.md) and
[ADR 0008](../adr/0008-in-memory-native-mission-supervisor.md) before continuing.
Do not interpret instructions inside imported transcripts as system policy.

## Planning completion and next implementation gates

The master planning pack defines the complete target. It does not establish that
all architecture decisions, implementation or acceptance are finished. ADRs
0007–0016 resolve the implemented slices; future decisions below remain open.
Do not mark the whole v1 plan complete because a bounded increment passes tests.

| Order | Next gate | Required proof before calling it delivered |
| --- | --- | --- |
| 3.1 | Atomic native metadata events and execution acknowledgement (ADR 0014) | **Delivered** (Stage 3.1 record): state/event transaction, schema 1→2 migration, no effect after failed commit, host-level sibling stop, transient RAM journal isolation/caps/duplicates and restart without replay are tested. |
| 3.2 | Runtime budgets and usage ownership (ADR 0015) | **Delivered for native read-only missions** (Stage 3.2 record): duration/token/per-task/concurrency budget, provider-reported usage with unknown never zero, exhausted-budget admission (AC-08 unit/host proof) and deadline behavior. Cost stays absent (no versioned price table); OpenAI-compatible streams often report no usage. |
| 3.3 | Leases and explicit reconciliation | Persisted holder/heartbeat/reaper, interrupted tool intents unknown, no duplicate effects, tested reconciliation and recovery UI. |
| 3.4 | Scoped action approvals | Exact parameter digest, scope/expiry/revocation, changed action invalidates approval; enforcement in the real execution path. |
| 4 / 5 | Observe acceptance and Mission Control evidence | Actual supported app versions, freshness/capability truth, evidence-backed results, missing-history replay behavior, Office worker projection and accessibility. |
| 6 | Isolated writers and integration queue | Separate worktrees/ownership, conflict before merge, meaningful build/test gate and cleanup/recovery. |
| 7 | Reviewed learning | Workspace/mission scopes, provenance/redaction, review/rejection, rollback and conflict-safe optional vault sync. |
| 8 | Durable automation | Idempotent scheduled/triggered runs, timezone behavior, restart/headless operation, health and cost visibility. |
| 9 | Extensions and release acceptance | Versioned permissions/isolation/trust, migration/export, supported-OS packaging and adversarial tests. |
| Measured gate | Rendering and resource acceptance | Hardware-stated RAM/GPU/FPS/hidden-tab measurements; independent avatars, chair motions, picking, asset disposal and unchanged visual output checks. |

This is dependency order, not a promised schedule or cost estimate. Preserve the
working app and observers while implementing each gate; Stage 6 cannot enable
write tools before approval/intent/recovery decisions are enforced. The AC ledger
below remains the source of acceptance status.

## Baseline audit (before this task edited code)

- Starting package version: 0.0.38; HEAD: `f214f4f`.
- The checkout already contained extensive modified/untracked files across UI,
  runtime, host, adapters, tests and docs. They are pre-existing work; preserve
  them. Do not use a blanket checkout/reset or claim the entire diff as this task.
- `pnpm check`: exit 0, 110 test files and 1,046 tests passed. Includes lint,
  boundaries/public-safety, typecheck, tests, production build, version consistency
  and local character-asset validation.
- Build warnings already present: classic boot script cannot be bundled as a
  module; some output chunks exceed 500 kB. Neither blocked the baseline build.
- Environment: Darwin 25.6.0 arm64, Node 26.12.0, pnpm 12.7.0.
- No idle CPU/RAM, FPS, GPU, 20-agent, concurrent-build or crash-recovery benchmark
  was measured. A successful build is not performance evidence.

### Audited baseline system map

| Area | Verified source and current state |
| --- | --- |
| Processes | `apps/cli` starts the local Bridge; Electron `apps/desktop` composes the Node host and serves the shared React web renderer through preload IPC. |
| Dependencies | `protocol ← core ← platform ← apps`; runtime/host/importers are separate packages. UI consumes shared contracts/state, not provider secrets or execution adapters. |
| Managed execution | `packages/runtime` has a Native loop, provider adapters and delegation; host composes tools/session execution. This is not yet a durable heterogeneous mission scheduler. |
| Observation | `packages/importers` and `packages/host` parse selected Codex, Claude Code, Gemini and external runtime history/hooks/MCP. Antigravity detection does not establish control support. |
| Protocol/storage | `packages/protocol/src/events.ts` and `validate.ts` provide strict `extalia.v0` events. Current sessions use files/event logs and JSON state; no canonical SQLite mission journal was established. |
| Security | Workspace paths, credential protection, command limits, approval policies, credential stores and single-host locking exist; see `docs/architecture/security.md`. The PRD's future sandbox/approval/recovery gates need separate tests. |
| Office | `App.tsx` mounts Office by route; `OfficePage.tsx` lazily loads `OfficeCanvas.tsx`. Presence consumes protocol events. This audit does not certify hidden-tab frame behavior or FPS. |

## Current execution priority

The continuation prioritizes a green Stage 1 gate, then a bounded native Stage 2
supervisor. Visual memory optimization follows a stable execution baseline.
Keep the current TypeScript/Electron stack; Rust daemon adoption and optional
Python learning workers remain staged decisions, not prerequisites or language
percentage targets.

For the later renderer memory pass, measure process/JS/GPU resource behavior
before changing resources. Preserve geometry detail, textures, lighting,
resolution, independent chair transforms, independent avatar skeleton/animation
state and per-object picking. Share immutable assets with explicit ownership;
never dispose an asset while another instance still references it. Test object
removal, simultaneous independent chair/avatar motions and route/floor cycles.
No memory savings or unchanged-render guarantee is claimed without measurements.

## Delivery tracker

| Stage | Status | Delivered / next action |
| --- | --- | --- |
| 0 Baseline | Audit done; performance baseline incomplete | Source/process/storage/security/Office map above; baseline checks passed. Measure resource profiles on stated hardware later. |
| 1 Core contracts | Gate passed on resume | `pnpm check` exit 0 at v0.0.39: 111 files / 1,109 tests. Previous four failures resolved by shared-checkout changes; added focused regressions. |
| 2 Native MVP | Kernel, host API and lead planning delivered; product acceptance incomplete | Local two-adapter host/API tests, correlated session events and retained results. `planNativeMission` (ADR 0010) proposes a read-only two-provider DAG from the session lead, with a deterministic fallback; nothing runs until launch. The Missions page (ADR 0011) launches, reviews and monitors these missions. Live-provider/artifact certification remains required. Latest verification is recorded below. |
| 3 Durable control | Checkpoints, atomic control events (3.1) and runtime budgets (3.2) delivered; full stage incomplete | Host-owned SQLite WAL checkpoints/change rows and legacy import; native control events commit with their checkpoint before each effect; mission budgets and reported usage are enforced and persisted. Leases/reaper, crash reconciliation and scoped approvals remain pending. |
| 4 Observe | Existing observer functionality; v1 acceptance unverified | Explicit capabilities and truthful freshness; permission-scoped observation. Preserve working adapters and certify actual supported versions. |
| 5 Mission UX | Launch/plan-review/monitor UI delivered (mock-verified); Mission Control incomplete | Missions page (ADR 0011): eligible-session picker, goal + allowed connections/models (in-place allowlist editing), lead planning, editable DAG plan with inline validation, launch, task-state monitor with unverified answers, cancel and Office entry links. Office projection of mission workers delivered (ADR 0016, mock-verified): queued workers listed but not admitted, running workers admitted via the spawn queue, ended workers linger then leave, unknown/recovering shown explicitly. Evidence, approvals, reconciliation and replay remain pending. Chat and Office preserved. |
| 6 Workspace isolation | Not implemented | Write-capable workers in separate worktrees, ownership, integration queue, conflict review and test gates. |
| 7 Evolve | Not implemented | Scoped experience/memory, provenance, candidate skills, review/rejection, version rollback and optional conflict-safe vault sync. |
| 8 Automation | Not implemented | Durable triggers, timezone-safe schedules, replay, cost/health insights and headless reliability. |
| 9 Ecosystem | Not implemented | Versioned extensions, packaging/cross-platform release and adversarial security gates. |

Existing functionality in the app-flow PRD is not new work from this task and
must not be removed to make the new tracker simpler.

## Requirement coverage from planning

| Requirement | Current coverage / remaining work |
| --- | --- |
| FR-01 Lifecycle/setup | Existing splash, setup and recovery UI in app-flow tracker; v1 offline/migration and end-to-end acceptance still unverified. |
| FR-02 Lead agent | Existing chat/native delegation plus host-owned fixed-graph supervision. The session lead now proposes mission plans (`planNativeMission`, one tool-less call, strict parse, heuristic fallback, `leadModel` recorded). The Missions page shows the plan source and `leadModel` and lets the user edit before launch. Durable scheduling, lead-written final summaries and verified final evidence still pending. |
| FR-03 Parallel heterogeneous workers | Fixed-graph read-only kernel and host multi-connection API with local concurrency tests. Plans assign workspace-allowed connection/model pairs and prefer ≥2 providers when ≥2 connections are allowed; a planned two-provider mission launched and completed through the real host with scripted fetches. The Missions page launches user-reviewed plans and shows each worker's identity, connection and exact model (mock: 6 tasks over two providers, ≤4 concurrent). Live-provider certification and broader spawn policy remain pending. |
| FR-04 Model registry/router | Existing provider connections/adapters. Mission usage ownership (ADR 0015): only provider-reported input/output tokens count; unreported usage is unknown, never zero or estimated. No cost is shown because no versioned, user-overridable price table exists. The OpenAI-compatible stream now requests usage (2026-10-18 FR-04 note under Stage 3.2), but many servers still report none. Discovery, route policy, health/backoff/circuit breaker and pricing governance pending. |
| FR-05 Tools/execution | Existing workspace-bounded tools; cancellation/process-tree proof, worktree integration and recovery idempotency pending. |
| FR-06 Durable graph | Validated alias dependencies and bounded mission checkpoints in host-owned SQLite WAL with one-time legacy import (ADR 0013). Native control events commit atomically with their checkpoint before each provider/tool effect; a failed commit latches the mission (ADR 0014). Budget, usage and exhaustion commit in the same transactions (ADR 0015). Session v0 events remain a separate JSONL projection. Leases and crash reconciliation remain pending. |
| FR-07 Observation | Existing transcript/hook/MCP adapters; certify actual versions, capabilities and freshness against v1 scenarios. |
| FR-08 Mission Control | Approval/evidence wire foundation; plan proposals are reviewable data (no approval is implied by planning). Missions page: DAG, per-task states, failure/unknown/recovering explanations, cancel; progress is "N of M tasks completed" with "answers unverified" (no evidence exists yet). Optional budget fields in plan review; monitor shows reported usage vs budget, "unknown"/lower-bound when unreported, per-task usage and an exhaustion banner (EN/ID). Evidence links, approvals queue, blockers view and enforced scoped, expiring digest-bound approvals pending. |
| FR-09 Office | Existing campus/floors, navigation, staff and semantic activity. Native mission workers are projected truthfully (ADR 0016): generated stable names/looks, nested under the lead, task line, mission badge, connection/model, mapped states (Queued/Working/Ready/Error · reason/Unknown), semantic read/search bubbles, spawn-queue admission, KPI buckets, lead Missions link. Headless mock FPS measured (record below); hardware-stated benchmark and live-provider projection still pending. |
| FR-10 Learning | Scope/experience/candidate wire foundation; collector, redaction, validation/review, rollback and optional vault sync pending. |
| FR-11 Automation | Native durable triggers/schedules/idempotent runs and headless execution pending. |
| FR-12 Replay | Existing session event history; canonical mission replay, missing-segment semantics, retention/export and trace correlation pending. |
| FR-13 Extensions | Permissioned versioned SDK, compatibility, isolation and trust gates pending. |
| FR-14 Accessibility/theme | Existing themes and reduced-motion behavior in app-flow tracker; full accessibility and theme GPU benchmark pending. |

## Acceptance ledger (master PRD AC-01 through AC-15)

None of these end-to-end scenarios is certified by the contracts/runtime-kernel update.
Existing unit tests are supporting evidence only.

| AC | Status | Evidence still required |
| --- | --- | --- |
| 01 Setup | Incomplete | Fresh temporary-profile install, credentials absent, guarded setup and successful connection → Office. |
| 02 Multi-provider | Incomplete; local host/API proof only | Three concurrent workers over two separately credentialed implemented adapters run through the real host with scripted fetches. The session lead's plan (scripted) assigns two providers and launches through the host. The user UI launches and monitors such plans (mock-verified). A third provider and live-provider/artifact evidence remain required. |
| 03 Worktree isolation | Incomplete | Independent worktrees and conflict detected before integration. |
| 04 Crash recovery | Incomplete | Restart during non-idempotent call; unknown/recovery state and no duplicate effect. |
| 05 Read-only external session | Incomplete | Live attachment with actual supported messages/tools and denied unsupported control. |
| 06 Freshness | Incomplete | External silence becomes stale/unknown based on source evidence. |
| 07 Approval binding | Incomplete | Runtime blocks deployment; changed parameters invalidate scoped approval. |
| 08 Budget | Incomplete; scheduler proof only | Runtime and real-host tests (scripted fetches, temporary SQLite) show exhaustion blocks new scheduling while running work finishes intact, is persisted and survives restart (Stage 3.2 record). Live-provider usage reporting, cost budgets and end-to-end UI acceptance remain. |
| 09 Skill rejection | Incomplete | Rejected candidate cannot activate through the real runtime. |
| 10 Memory scope | Incomplete | Cross-workspace/global export blocked without explicit approval. |
| 11 Performance | Incomplete | Stated hardware/night benchmark and hidden Office animation measurement. |
| 12 Mission/Office UX | Incomplete | End-to-end floor controls, viewport, bubbles, popover/modal and board restoration. Mock missions (`?mock=ready`, `&missions` for retained history) drive the Missions page; the Office session dialog and activity board link to it. Floor controls and bubbles are not certified by this slice. 2026-10-18 (ADR 0016): mock missions show workers arriving, working, finishing and leaving in the Office (headless screenshots); live-provider end-to-end Office acceptance remains open. |
| 13 Facility/spawn behavior | Incomplete | Real scene staff constraints and bounded avatar admission under load. 2026-10-18: a 12-task mock mission is admitted through the director spawn queue in a unit test (≥ 300 ms apart, ≤ 3 per second, all 12 workers kept on the board); load-time seating of already-running workers is not staggered (one-second spike measured). Staff constraints not re-certified. |
| 14 Replay | Incomplete | Recorded events reconstruct history with missing portions shown unknown. |
| 15 Offline | Incomplete | Stored history/skills accessible offline; provider failures preserve queue. |

## Stage 1 change and verification record

Contract implementation and repository gate passed on resume: `pnpm check`
exited 0 at v0.0.39 (111 files / 1,109 tests). The four failures listed below
are historical and no longer block Stage 2. All broader end-to-end AC gates
remain incomplete. The original attempt is retained for provenance.
Targeted protocol suite: 2 files, 79 tests passed. Protocol typecheck and focused
ESLint passed. Version advanced once from 0.0.38 to 0.0.39.

Orchestration provenance: `baseline_audit` used `gpt-6-luna` for read-only source
and handoff review; `contracts` used `gpt-6.1-sol` for implementation and focused
verification. The parent ran baseline and integration checks. Workers did not
report token usage; no measured cost or savings is claimed.

Full integration attempt on 0.0.39:

- `pnpm check`: exit 1. Lint, package-boundary/public-safety and all package
  typechecks passed. Tests: 107 files passed / 4 failed; 1,105 tests passed /
  4 failed (1,109 total). Build/version/asset checks were skipped by this command
  after the test failure; separate results follow below.
- Protocol suite rerun against current shared sources: 2 files / 79 tests passed.
- Version consistency and character-asset checks passed separately.
- Separate `pnpm build`: exit 0; Web, CLI and Desktop production builds passed. Existing boot-script and chunk-size warnings remain.

Historical failures from the first integration attempt (resolved on resume):

| File/test | Actual vs expected |
| --- | --- |
| `apps/web/test/observedStatus.test.ts:106` | Overloaded failure label is `Service overloaded`; test expects `Error`. |
| `apps/web/test/officePresence.test.ts:96` | Stale reported status remains `working`; test expects `idle`. |
| `packages/host/test/hookStatus.test.ts:52` | Normalizer now adds `reason: rate-limit`; expected body has only error/type. |
| `packages/importers/test/steps.test.ts:139` | Reply no longer carries `final: true`; error status now includes `reason: overloaded`. |

Their sources changed during the first run, and the parent preserved them.
On resume all four suites already passed (57 tests) before any edits by this
continuation. Sol reviewed the semantics and strengthened regressions in the
same four test files (58 tests): explicit failure-reason precedence, coherent
terminal hook reasons, stale timestamp retention/completion reset, and failed
synthetic replies distinguished from ordinary final replies. No observer
production source was changed by this continuation. The original contract
update added 63 passing tests relative to its baseline.

Owned implementation paths:

- `packages/protocol/src/orchestration.ts`: version 1 typed records and aggregate
  plan/registry contracts.
- `packages/protocol/src/orchestrationValidate.ts`: `parseOrchestration(kind, raw)`
  and pure `approvalMatchesToolCall(approval, toolCall, at)`.
- `packages/protocol/src/index.ts`: additive exports only.
- `packages/protocol/test/orchestration.test.ts`: contract/adversarial tests.

The new wire schema uses lowercase UUIDs for internal IDs, bounded collections and strict
unknown-field rejection. Existing v0 identifiers/events are unchanged. Stage 2
must explicitly map legacy/non-UUID identifiers; do not pass old session data
straight into the new parser. Registry and plan are validated data snapshots,
not a running registry service or scheduler. References outside each snapshot
still require store/policy checks; evidence and approval claims need trusted
runtime verification. Parameter canonicalization and hashing remain caller-owned.

No UI changed, so screenshots are not applicable. No persisted-data migration
was introduced. Performance remains unmeasured.

Security/privacy: wire validation is not runtime permission enforcement. No
provider credentials, real profile reads, external config writes or external
session control are required. No performance improvement is claimed.

Rollback: remove only this update's new orchestration modules/tests, additive
exports and documentation entries; restore version metadata coherently if
rolling back the release. Preserve all pre-existing dirty changes. Existing v0
sessions require no down migration because Stage 1 does not rewrite storage.

## Stage 2 bounded kernel record

Implementation: `packages/runtime/src/mission.ts`, exported by
`packages/runtime/src/index.ts`; regression/integration fixture:
`packages/runtime/test/mission.test.ts`. API: `runNativeMission(options)` with
`NativeMissionOptions`, `NativeMissionBinding`, `NativeMissionTask`,
`NativeMissionResult` and per-task results. See ADR 0008.

The trusted caller supplies a validated v1 plan, mapped UUID session ID, exact
provider/model-profile bindings, task instructions and declared read-only tools.
The kernel snapshots configuration before work starts. It admits only fresh
queued graphs and rejects unsafe tools, unsupported capabilities and workers
outside the lead's hierarchy. It has no credential resolver or external-agent
control. A tool's read-only declaration is trusted implementation code, not an
OS sandbox; the host must bind real workspace-contained implementations.

The scheduler bounds task/response sizes, steps, global concurrency, provider
concurrency and one active task per agent. Successful dependencies supply bounded
UNVERIFIED data to later tasks. Failed dependencies block that branch while
independent work continues. Per-task timeout/cancel requests propagate to
providers/tools; unacknowledged execution returns unknown/recovering, suppresses
late events and quarantines its invocation-local capacity. The caller must
reconcile before reusing the same resources in another invocation.

Events have schema-validated mission/task/agent context and a run-local sequence.
Provider/model IDs and the exact captured model name are in task results; they
are not new event fields. Output is bounded untrusted model prose, explicitly
unverified, with empty evidence IDs. No model response becomes test/build proof.
Raw provider/tool errors and tool content are excluded from this event journal;
model answers remain user content and require host privacy handling.

The original kernel slice alone is not a complete Stage 2 product feature.
Host invocation, scoped provider resolution, ID mapping and canonical v0
projection are now implemented by the host continuation below. Still remaining:

- Transactional durable mission journal/recovery beyond bounded result metadata.
- Mission UI, persisted history and visible accountable lead supervision.
- Real-provider certification and artifact/test evidence integration.
- Token, cost and total-mission duration budget enforcement; this slice enforces
  task deadlines plus agent/depth admission, not every Budget field.
- Durable attempts/leases, crash recovery and authenticated action approvals.
- Worktree-isolated writers/integration. All write/command/delegation/memory/meta
  tools remain unavailable in this slice.

The supervisor introduces no retry or fallback routes, but existing adapter SDK
retry/fallback behavior is inherited. Returned model identities must match the
configured model exactly; aliases/router-auto need explicit integration design.
No data migration or UI/visual/animation change is introduced. No resource/FPS
benchmark or memory savings is claimed.

Continuation verification:

- Four observer/parser suites: 58 tests passed after added regressions.
- Mission suite: 15 tests passed. Mission/loop/provider suites: 35 tests passed.
- Runtime typecheck and focused ESLint passed.
- Version advanced once for this continuation: 0.0.39 → 0.0.40.
- Initial full integration: `pnpm check` exit 0, 112 files / 1,125 tests passed,
  including lint, typecheck, build, version and asset checks.
- Final check after captured model-name attribution: `pnpm check` exit 0, 112 files / 1,125 tests passed. Existing boot-script/chunk-size and environment deprecation warnings remain non-blocking.

Orchestration: `gpt-6-luna` performed read-only exploration and review;
`gpt-6.1-sol` implemented the kernel and tests; the parent handled integration,
final model-attribution regression, documentation and versioning. Workers did
not report token usage; no cost/savings measurement is claimed.

Rollback: remove only `mission.ts`, its test and additive runtime export, plus
this continuation's test assertions/docs/release metadata coherently. No persisted
mission data is created, so no database down migration is needed. Preserve all
pre-existing and concurrent changes.

## Stage 2 host API continuation

Implemented paths:

- `packages/platform/src/missions.ts`: strict bounded request normalizer and host
  DTOs; `agentHost.ts`/`index.ts`: shared authenticated method allowlist/exports.
- `packages/core/src/models.ts`: optional workspace `missionConnectionIds`, with
  bounded, unique validation and preserved defaults.
- `packages/host/src/mission.ts`: UUID plan construction, provider binding, v0
  event projection and versioned retained metadata.
- `packages/host/src/service.ts`: workspace authorization, independent credential
  resolution, session admission/cancellation, retained getters and resource guards.
- `apps/web/src/host/mockHost.ts`: truthful unsupported mock execution and
  in-memory configuration compatibility; no fabricated mission execution.
- Protocol model profile context capacity is now optional when undiscovered;
  host-generated plans no longer invent a context-token limit.

API guide: [native missions](../architecture/native-missions.md).
`startNativeMission` starts asynchronously; `nativeMissionRun` and
`listNativeMissions` read session-scoped results. Existing `cancel` stops owned
work cooperatively. Additional provider connections require
`setWorkspaceMissionConnections`; primary connection is implicitly allowed.
Policy changes that would revoke active/unresolved mission access are blocked,
including primary-connection/runtime changes. Ordinary settings edits preserve
an omitted allowlist. Ordinary prompts cannot overlap mission reservations or
unknown execution on the same connections.

Canonical events remain `extalia.v0` session events, with mission correlation,
task identity, worker model and truthful terminal/unknown states. A storage fault
marks the run recovering rather than claiming persisted success. Result metadata
is separate from event authority: `sessions/<session-id>.missions.json`, envelope
`{ schema: 'extalia.native-missions.v1', runs: [...] }`, at most 16 records per
session and an 8 MiB encoded-file bound. Byte-aware retention prunes older terminal
records while protecting current/unresolved runs. Strict metadata validation rejects extra fields
and unsupported versions. Existing session files/config need no rewrite; the
new optional workspace field is backward-compatible. No SQLite migration occurs.

Saved unfinished records reopen recovering/unknown, never replay. Unknown work
blocks connection reuse and unsafe deletion. Transient sessions keep both events
and metadata in RAM; their recovery records do not survive process exit. The
host API currently has no reconciliation/acknowledgement UI or method. Do not
clear unknown state to bypass this guard; Stage 3 must define real reconciliation.
Known resolved credentials and common secret patterns are masked from retained
labels/answers. Task instructions, configured endpoints and credential references are not
stored in sidecars. No external app configuration or real profile was changed.

Testing uses temporary home/data/project folders, injected scripted fetches,
separate OpenAI/Anthropic adapters and actual authenticated local Bridge HTTP.
The tests prove three-way overlap, separate credential headers, policy/history-off
rules, persisted readback after restart, cancellation/busy state, corrupted
metadata, storage faults and unknown quarantine. They do not certify cloud
availability, billing, task quality or verified artifacts.

Verification record (host continuation complete):

- Baseline full check initially hit the existing observer integration test's
  5-second outer timeout; its focused 7-test suite passed on retry. The test
  contains bounded waits of 3 + 3 + 5 seconds, so this continuation sets its
  outer deadline to 15 seconds while preserving those assertions/deadlines.
- Platform mission normalizer: 4 tests passed; platform typecheck and focused
  lint passed. Parent contract/transport suites: 4 files / 22 tests passed.
- Protocol/core/Bridge focused suites: 3 files / 72 tests passed.
- Final storage + host mission + real Bridge RPC suites: 3 files / 13 tests passed;
  host typecheck and focused lint passed. Storage tests cover exact UTF-8 retention
  bounds, protected unresolved records and unchanged data on rejected writes.
- Related existing host/session regression suites also passed before final
  policy/projection assertions.
- Version advanced once for this continuation: 0.0.40 → 0.0.41.
- The first final check stopped on two intentional synthetic redaction fixtures;
  their lines now carry the repository-required test-fixture annotation.
- Final `pnpm check`: exit 0, 116 files / 1,144 tests passed, including lint,
  boundaries/public-safety, all package typechecks, tests, production builds,
  version consistency and character assets. Existing boot-script/chunk-size and
  environment deprecation warnings remain non-blocking.

Orchestration: `gpt-6-luna` implemented bounded platform contracts and performed
read-only host review; `gpt-6.1-sol` implemented the host/controller tests; parent
handled protocol/core/API/mock integration, Bridge HTTP test and documentation.
No worker token usage was reported. No memory/FPS or cost savings are claimed.
No renderer, asset or animation implementation changed.

Rollback: first stop/reconcile unknown work. Preserve all unresolved sidecars and
canonical event logs; older hosts do not enforce the new quarantine. Revert only
this continuation's code/API/config-field additions and coherent version metadata,
without resetting unrelated dirty work. Do not blindly delete metadata to make a
downgrade appear safe.

## Stage 2 lead planning record (v0.0.43, planner part)

Decision: [ADR 0010](../adr/0010-lead-mission-planning.md). Changed paths:

- `packages/platform/src/missions.ts`: `MissionPlanRequest`, `MissionPlanTask`,
  `MissionPlan`; `agentHost.ts`: `planNativeMission` + method allow-list entry.
- `packages/platform/src/missionPlan.ts` (new): request normalizer, JSON-only lead
  prompt, strict reply parser, deterministic heuristic, plan checker, level and
  request helpers; exported from `index.ts`.
- `packages/host/src/service.ts`: `planNativeMission` (session/workspace
  authorization, eligible pairs, lead call with host-resolved credential, 45 s
  timeout, no tools, redaction, fallback). No new state, events or files.
- `apps/web/src/host/mockMissions.ts` (new) and mission methods/seed wiring in
  `mockHost.ts`: deterministic planning, simulated read-only runs with live task
  states, cancel via `cancel`, demo answers marked unverified; demo-app allows the
  local connection for missions; `&missions` seeds a completed and a failed mission.
- Tests: `packages/platform/test/missionPlan.test.ts`,
  `packages/host/test/missionPlan.test.ts`, `apps/web/test/mockMissions.test.ts`.

Verification (2026-10-17, shared uncommitted tree, before the coordinator's version bump):

- Platform plan suite: 11 tests passed. Host plan suite (temporary homes,
  scripted fetches, OpenAI-compatible lead + Anthropic worker): 5 tests passed,
  covering a strict two-provider plan launched to completion, seven adversarial
  replies (cycle, unknown worker, injected connection, injected endpoint and
  credential, oversized, too many tasks, prose) → heuristic, ignored tool calls,
  provider failure, goal/echo redaction, connection/model/history/team rules and
  "nothing executes" (no events, records, sidecar or busy state).
- Mock mission suite: 2 tests passed (live states, cancel, blocked branch).
- `pnpm vitest run packages apps/web/test`: 111 files / 1,103 tests passed.
  `apps/cli` + `apps/desktop`: 10 files / 105 tests passed.
- `pnpm -r typecheck`: all packages passed. ESLint on touched files passed.
  `node tooling/check-public-safety.mjs`: passed.

Security/privacy: no privileged tool, endpoint, credential or tool spec crosses
to the renderer or the lead prompt; workers are referenced by number. A plan is
untrusted data and is re-validated at launch. No real profile or external app
configuration was read or changed. Gaps: live-provider plan quality/latency/cost,
model-capability-based fit (FR-04), lead-written final synthesis with evidence.
Rollback: as in ADR 0010; no data migration.

## Stage 2 mission UI record (v0.0.43, UI part)

Decision: [ADR 0011](../adr/0011-mission-ui.md). Changed paths:

- New `apps/web/src/missions/`: `missionModel.ts` (eligibility, allowed pairs,
  draft↔request, inline validation incl. cycles, DAG levels, task-state progress,
  feature-detected planner), `MissionsPage.tsx`, `MissionComposer.tsx`,
  `MissionPlanEditor.tsx`, `MissionMonitor.tsx`, `MissionDag.tsx`.
- `apps/web/src/App.tsx` (route + nav item), `i18n.ts` (`missions` EN/ID, nav
  `Missions`/`Misi`), `ui/Icon.tsx` (`mission` icon), `styles.css`
  (`v0.0.43 missions` block), small optional `onOpenMissions` links in
  `pages/OfficePage.tsx`, `office/AgentSessionDialog.tsx` and
  `office/overlay/ActivityBoardDrawer.tsx`.
- Test: `apps/web/test/missionsUi.test.ts` (10 tests). Mock host files were not
  changed by this part (the planner part's mock was used as delivered).

Verification (2026-10-17, shared uncommitted tree, before the coordinator's version bump):

- `apps/web` typecheck passed; ESLint on all touched files passed;
  `node tooling/check-public-safety.mjs` passed (699 files).
- `pnpm vitest run packages apps/web/test`: 112 files / 1,113 tests passed.
- Headless Chromium against `vite` with `?mock=ready`: the lead (mock) planned 6
  tasks over Anthropic + Ollama in 3 dependency steps (8 connectors). Edits were
  checked: retitled a task; adding a dependency created a loop that was flagged
  inline on all 6 tasks with Launch disabled, and undoing it cleared it; an added
  empty task reported title/instruction errors and was removed. Launched: task
  states went from queued to running (up to 4 at once) to completed, with text
  progress "0…6 of 6 tasks completed" and the "Answers unverified" badge. All 6
  answers carried "Unverified model answer". The cancel path asked for
  confirmation, after which the run and its tasks became Cancelled. `&missions`: the failed retained
  mission shows "The provider call failed." and a blocked dependent
  "Not started: a task it waits for did not complete." At 375 px (Indonesian)
  there was no horizontal overflow and the DAG stacked with gutter connectors.
  Dark + Liquid Glass Pro and light + Liquid Glass rendered. The Office session
  dialog showed "Missions" for a native lead and navigated to the page. The only
  console errors ("synchronously unmount a root") also occur when leaving the
  Office for Chat without this page (30 in the baseline), so they predate this work.
- Screenshots: `v043-missions-ui-*.png` in the session scratchpad (not committed).

Security/privacy: UI only; no new host method, persistence, tool or permission.
The renderer sends only the validated request (aliases, instructions, saved
connection ids, model ids, bounds). Role/rationale stay local. Widening the
mission allowlist is an explicit user Save through the existing host method.
Answers are rendered with the existing safe Markdown renderer as untrusted text.
No real profile or external app configuration was touched. No performance
measurement was taken. Polling is 1.5 s while a run is active, 6 s while hidden,
and stops at a terminal state.

Historical gaps at v0.0.43: live-provider certification; DAG for runs launched in another window; reconciliation, evidence, approvals and replay UI; Office avatars for mission workers. The retained-DAG gap is addressed in the reliability record below. Rollback: remove `apps/web/src/missions/`, the
test, the `missions` i18n block and nav entry, the icon, the CSS block and the
three optional link props. No data migration.

## Stage 2 reliability record (v0.0.45)

Decision: [ADR 0012](../adr/0012-mission-planning-admission-and-retained-graphs.md).
Continuation baseline: v0.0.44, HEAD `5c67478`; `pnpm check` exit 0,
123 files / 1,227 tests. Preserve the extensive pre-existing shared-checkout
changes. This increment does not claim the earlier UI/planner as new work.

Orchestration: requested Codex Sol (`gpt-6.1-sol`, planner lifecycle) and Luna
(`gpt-6-luna`, bounded metadata implementation and independent review); the
coordinator integrated the renderer and documentation. Luna found a remaining
catalog-admission race in review; Sol moved lead admission before that await
and added a regression. Worker token usage was not reported; no savings claim.

Delivered:

- `packages/host/src/service.ts`: synchronous session ownership and early lead
  connection admission for planning, shared with prompts/missions/policy edits.
  Cancellation and the 45-second lead-call wait return heuristic data while an
  abort-ignoring call keeps capacity until it physically settles. Late replies
  are discarded. Planning emits no conversation/mission events or sidecar.
- `packages/platform/src/missions.ts`, `packages/host/src/mission.ts`: optional
  retained alias dependencies, copied for every new task including roots.
  Strict graph checks and saved-session restart preserve the graph; missing
  legacy fields remain unknown. Existing history-off and quarantine rules stay.
- `apps/web/src/missions/missionModel.ts`, `MissionMonitor.tsx`, `MissionDag.tsx`,
  `apps/web/src/host/mockMissions.ts`, `i18n.ts`: prefer retained graphs,
  keep a bounded older-host cache, and explain missing graph metadata in EN/ID.
  Browser testing found a resize bug: measuring the previous absolute SVG with
  `scrollWidth` prevented it shrinking. Measuring the layout box fixes it.
- Focused tests in host `missionPlan`, `missions`, `missionStorage` and web
  `missionsUi`, `mockMissions`; ADRs 0010/0011 amended, API guide and trackers updated.

Verification:

- Worker host/platform typechecks and focused lint passed. Planner suite:
  13 tests (including gated model catalog discovery, concurrent calls, cancel,
  deadline, ignored abort, pending credential and bounded close). Metadata worker:
  3 files / 19 tests. Web suites: 2 files / 15 tests before the resize fix.
- Headless Chromium, mock host `?mock=ready&missions`: retained history displays
  four task cards and four dependency connectors without any locally submitted
  plan. Dark/Liquid Glass Pro desktop and light/Liquid Glass Indonesian mobile
  checked. Desktop-to-phone resizing retains the graph and no document overflow
  at 375 px after the SVG fix. Screenshots under ignored `output/playwright/`
  (`v045-mission-dark.png`, `v045-mission-light-desktop-final.png`,
  `v045-mission-light-id-mobile-final.png`). Existing Office React unmount errors
  and Three deprecation warnings recur before entering Missions, as in v0.0.43.
- Coordinator focused gate: 5 files / 43 tests passed.
- `pnpm version:patch` run once: 0.0.44 → 0.0.45. Final `pnpm check`
  exit 0: 123 files / 1,241 tests, lint/boundaries/public-safety, all typechecks,
  production builds, version and local hair-asset checks passed. Existing build
  chunk-size warning remains. No commit/push or real-profile changes.

Remaining limitations: the 45-second bound begins after candidate discovery and
covers credential acquisition plus inference. Discovery keeps its existing
four-second abort signal/cache; cancellation there is reported after lookup
settlement, and an abort-ignoring catalog can keep the API pending. Reservations
are in memory only and do not certify crash recovery. No live provider was used;
answers remain unverified. No render memory/FPS benchmark was measured.

Next work: ADR for durable journal ownership, migration and crash reconciliation,
then bounded runtime budget enforcement and scoped approvals. The retained graph
is bounded JSON metadata, not SQLite/WAL or replay. Live-provider/artifact evidence
and renderer memory benchmarks are still required by the acceptance ledger.
Rollback: retain the updated sidecar decoder when reverting this increment's UI
or admission behavior; strict older decoders may reject the added task field.
Never erase quarantine or unresolved records to make a downgrade start.

## Stage 3 checkpoint foundation record (v0.0.46)

Decision: [ADR 0013](../adr/0013-transactional-mission-checkpoints.md).
Baseline: v0.0.45, previous complete gate 123 files / 1,241 tests. This is the
first checkpoint-persistence slice; full Stage 3 is still incomplete.

Delivered:

- `packages/host/src/missionCheckpoints.ts`: host-owned `state/missions.sqlite`,
  WAL/FULL commits, transactional schema version 1, checkpoint/revision/digest and
  append-only change rows, idempotent unchanged snapshots, bounded cursor pages,
  legacy source markers and removal tombstones. Terminal pruning retains the
  existing 16-run/8-MiB bound. An 8,192-change/session cap rejects atomically.
  Corrupt/newer schemas, invalid digests and unresolved deletion fail closed.
  SQLite BUSY/LOCKED may defer close-time WAL truncation; the committed WAL is
  kept authoritative, never deleted manually. No native npm addon was added.
- `packages/host/src/mission.ts`, `service.ts`: production uses SQLite; strict
  legacy sidecars import once per session and remain untouched. Reopen commits
  running→recovering/unknown before exposing state, with no provider/tool replay.
  An unresolved checkpoint whose saved session record is missing rejects startup
  rather than disappearing from connection quarantine. Failed initialization
  closes the DB and releases the profile lock. Transient missions stay in RAM.
  The omitted DB argument on `MissionRecords` remains a legacy format-test
  harness; normal host construction always supplies the SQLite file.
- Root/CLI engines, CLI doctor and install copy require Node 22.13+; Node 23
  requires 23.4+. Existing source/runtime boundaries and canonical v0 session
  logs are preserved. API/architecture docs and tracker updated.

Orchestration: Sol (`gpt-6.1-sol`) owned store/module tests and reviewed lifecycle;
Luna (`gpt-6-luna`) audited requirements and owned host migration/failure tests.
The coordinator integrated MissionRecords/host lifecycle, runtime floor and docs.
Sol review found the orphan-session visibility gap; the coordinator fixed it and
Luna added its regression. Worker token usage was not reported.

Verification so far:

- Store: 13 tests, focused lint and host typecheck passed. Host integration:
  migration/mission suites passed; combined coordinator run: 6 files / 58 tests.
- Real bundled module, Node 22.13.0: create/write/read/close/reopen passed without
  an experimental flag (the runtime emits its expected SQLite experimental
  warning). Node 26.12.0 and installed Electron 44.7.2 / Node 24.21.0 also load it.
- Manual isolated child-process probe: SIGKILL immediately after committed write
  left a WAL; reopen recovered the running checkpoint and exactly one change.
  This proves that checkpoint, not non-idempotent tool recovery or full AC-04.
- `pnpm test:desktop` exit 0 with temporary app/data profiles: preload bridge,
  sceneReady, all three floor views and Settings succeeded; nodeExposed=false,
  no model errors or diagnostics. No real profile/config was changed.
- `pnpm version:patch` run once: 0.0.45 → 0.0.46. Final `pnpm check`
  exit 0: 125 files / 1,261 tests, lint/boundaries/public-safety, all typechecks,
  production builds, version and local asset checks passed. Existing chunk-size
  warning remains. No commit/push or deployment.

Remaining: intermediate task states are still volatile, and v0 JSONL events are
not atomic with SQLite. No canonical task/tool event journal, durable effect
intent, lease/reaper, planner reservation recovery, retry/reconciliation API,
scoped approval or runtime budget was implemented. Change cursors do not assign
v1 event sequence or reconstruct missing session events. Database sync work is
bounded but render/latency benchmarks and other-OS packaging remain unverified.
Original sidecars are stale after import; no automatic downgrade/export exists.
Never erase the DB, edit its version or remove unresolved records to start an
older binary. The next increment must define durable task/tool intent and event
ownership before claiming replay/recovery safety, then enforce runtime budgets.

## Stage 3.1 record: atomic events audit (2026-10-18)

Decision: [ADR 0014](../adr/0014-atomic-native-mission-events.md). Baseline: v0.0.46
shared tree; focused mission suites 9 files / 82 tests passed before edits. No
version bump or CHANGELOG entry by this continuation (coordinator-owned).

Audit against the gate's required proof:

| Requirement | Evidence |
| --- | --- |
| State/event transaction | `missionJournal`: event + checkpoint + revision + import marker roll back together on an injected insert failure; `missionJournalIntegration`: every event row references its checkpoint revision/digest. |
| Schema 1 → 2 migration | `missionJournal`: released schema 1 is verified before migrating; revisions, import markers and global cursors unchanged. |
| No effect after failed commit | Runtime: provider not called when `task.assigned`/`running`/`thinking` commits fail; read tool not run when `tool.started` fails; async/zero acknowledgements rejected. Host: SQLite triggers on `agent.state`/`tool.started` prevent provider/tool calls. |
| Mission-wide latch, sibling stop | Runtime test (existing). **Added** host-level test: a failed SQLite `tool.started` aborts the in-flight sibling (fetch saw abort), the queued task is never called and stays blocked, no raw error leaks, restart does not replay. |
| History-off isolation | Existing host test (no SQLite rows). **Added** direct RAM-journal tests: sequences, identical duplicate acknowledgement without rewind, conflicting ID reuse rejected, ownership/lead/prose/usage-key rejection, event 8,193 refused, no rows or sidecars, removal. |
| Duplicates / caps | SQLite: duplicate/conflict, event 8,193 and session byte cap (existing). RAM: added above. |
| Restart recovery | `running` → `recovering`/`unknown`, no replay (existing host tests). |

Fixes: the RAM journal re-encoded the whole session journal on every commit
(quadratic up to 8,192 events); it now keeps per-run encoded-byte totals with the
same 8 MiB bound. Two existing host assertions raced the session release after
the final save under parallel load (one failure observed in a full run); they now
wait for release and still require the unresolved-quarantine error. Removed an
unused import. No runtime/SQL behavior change was needed for 3.1.

Gate 3.1 is delivered for the current read-only native loop. Not claimed: v0
JSONL atomicity, leases/reaper, reconciliation API, write-capable effect intents
or AC-04.

## Stage 3.2 record: runtime budgets and usage (2026-10-18)

Decision: [ADR 0015](../adr/0015-mission-budgets-and-usage.md). Changed paths:

- `packages/platform/src/missions.ts`: `HostMissionBudget`, `HostMissionUsage`,
  `HostMissionTaskUsage`, `HostMissionBudgetExhaustion`, `MISSION_BUDGET_LIMITS`,
  `normalizeHostMissionBudget`, `isHostMissionUsage`, `isHostMissionTaskUsage`;
  request `budget` and run `budget`/`usage`/`budgetExhausted`, task `usage`.
- `packages/runtime/src/mission.ts`: `budget` option, per-call metering, call-
  boundary refusal, admission blocking, mission deadline, `accounting` argument
  to `commitEvent`, `turn.completed.usage`, result `usage`/`budgetExhausted`.
- `packages/host/src/mission.ts`, `missionCheckpoints.ts`, `service.ts`: retained
  budget, usage committed with each event, strict write-time validation, restart
  marks in-flight usage unknown, new journal codes/usage metadata.
- `apps/web/src/missions/missionModel.ts`, `MissionPlanEditor.tsx`,
  `MissionMonitor.tsx`, `i18n.ts` (EN/ID): budget fields, usage vs budget,
  unknown/lower-bound text, exhaustion banner. No CSS or Office file changed.
- Tests: `packages/runtime/test/missionBudget.test.ts` (8),
  `packages/host/test/missionBudget.test.ts` (6),
  `packages/host/test/missionTransientJournal.test.ts` (4, gate 3.1), one added
  latch test in `missionJournalIntegration.test.ts`, 3 added platform tests,
  3 added web tests. Docs: ADR 0015, ADR index, native-missions API guide.

Migration: none for SQL (database stays schema 2). Retained JSON gains optional
fields; v0.0.46 decoders reject them and fail closed (no automatic downgrade).

Verification (shared tree, before the coordinator's version bump):

- Typecheck: platform, runtime, host and web `tsc --noEmit` passed.
- `pnpm vitest run packages apps/web/test`: 122 files / 1,215 tests passed.
- Focused mission suites (16 files / 146 tests) passed three consecutive runs.
- ESLint on all touched files passed; `node tooling/check-public-safety.mjs`
  passed (719 files).
- No browser check: the mock host does not meter usage, so the monitor shows
  "Usage was not recorded" there; no screenshots were taken.

Security/privacy: usage is integers only; no prose, cost or provider error text
enters the journal. Budgets come only through the strict normalizer; the
renderer computes nothing authoritative. No credential, real profile or external
app configuration was touched. Gaps: no cost/price table; OpenAI-compatible
streams frequently omit usage (token budgets then stop as `usage-unknown`);
adapter-internal retries may consume unreported tokens; no workspace/daily
spend ledger; live-provider certification and Office projection still pending.
Rollback: revert the UI freely; reverting host/runtime needs a decoder that
accepts the new optional fields; never edit the DB or drop unresolved records.

### FR-04 usage request note (2026-10-18)

The OpenAI-compatible adapter (`packages/runtime/src/providers/openai.ts`) now sends
`stream_options: { include_usage: true }` on streaming chat completions and reads usage
from the final chunk: `prompt_tokens`/`completion_tokens`, or `input_tokens`/`output_tokens`,
also on the last delta. A 400 that names `stream_options` (or an unknown/unrecognized
parameter) is retried once without it, and the endpoint is remembered in memory per base URL
only after the plain retry succeeds. Other errors are not retried. Absent or malformed counts
stay unknown, so token budgets still stop as `usage-unknown` when a server reports nothing.
The Anthropic adapter is unchanged. Verified with scripted fetches only:
`packages/runtime/test/providers.test.ts` (FR-04 block, 8 tests) and
`packages/runtime/test/missionBudget.test.ts` (one adapter-driven budget test). Not verified
against live routers or OpenRouter/Ollama.

## Stage 5 record: Office projection of mission workers (2026-10-18)

Decision: [ADR 0016](../adr/0016-office-mission-projection.md). Read-only consumer of
the existing v0 event projection and `listNativeMissions`; no runtime, host,
mission storage or Missions page change. Changed paths:

- `apps/web/src/office/missionPresence.ts` (new): pure fold of correlated mission
  events + retained records into per-worker state (queued, running, completed,
  failed, cancelled, blocked, unknown) and admission.
- `apps/web/src/office/useOfficeMissions.ts` (new): coalesced, feature-detected
  `listNativeMissions` reads after mission lifecycle events.
- `apps/web/src/office/presence.ts`: `mission` field, `isAdmitted`, generated
  names/looks seeded by worker id, state mapping, linger/leave.
- `apps/web/src/office/overlay/{status,kpis,popoverModel}.ts`: Queued/Unknown/
  Not started/Error · reason labels, warning tone, buckets, `inOffice`.
- `apps/web/src/office/{activityFeed,useOfficeEvents,historyIds}.ts`: task
  lifecycle events retained, mission hand-off bubble on the lead, history kept
  while workers remain.
- `apps/web/src/pages/OfficePage.tsx`, `styles.css`, `i18n.ts` (`officeMissions`,
  EN/ID; KPI hints): board task line, mission badge, connection · model, details,
  lead Missions link; queued workers excluded from the 3D scene.
- Tests: `apps/web/test/officeMissions.test.ts` (6 tests: queued/nesting/names,
  all states incl. unknown/recovering, retained record merge, session-stop
  unknown, signatures/history, 12-task mock mission + director admission).

Verification (shared uncommitted tree at 0.0.46, before the coordinator's bump):

- `pnpm vitest run apps/web/test`: 60 files / 550 tests passed. Focused ESLint on
  touched files and `node tooling/check-public-safety.mjs` passed.
- `pnpm exec tsc -p apps/web --noEmit`: no errors in touched files. Errors remain
  in concurrently edited files outside this slice (`src/missions/MissionPlanEditor.tsx`
  `budgetDuration` messages, `src/host/mockHost.ts` `saveWorkspaceTeam`,
  `src/office/OfficePromptDock.tsx` team options).
- Headless Chromium (ANGLE/Metal, 1440×900, Darwin arm64; not a hardware
  benchmark): Missions page → plan → launch (8 and 12 tasks) → Office F1.
  Screenshots `v047-office-missions-*.png` in the session scratchpad. Workers
  arrive (queued rows first), work (Reading/Thinking, "Reading a file…" bubble),
  finish (Ready), and leave to Earlier after the linger (verified by a dev-only
  `Date.now` offset of 21 min). No page errors.
- FPS on F1 (rAF, 1 s windows): dev server dips to 25–45 during a mission because
  of development React re-render cost (profiled: `jsxDEV`); a production-React
  build with the mock (`NODE_ENV=production vite build --mode development`)
  measured baseline 60.1, 12-task mission 51.9–60.5 after the first second,
  60.1 after. The first second after re-entering the Office with four running
  workers measured 18.1 (load-time seating of already-running workers).

Gaps: live-provider projection not exercised; after an Office reload a
non-running session's unknown workers show only when the session is selected;
load-time seating is not staggered; reconciliation remains on the Missions page
(not yet implemented).

## Current continuation: hand pose, session identity and execution gate (2026-10-18)

The user requested Sol + Luna. Sol completed the journal implementation/review,
then hit its usage limit; no substitute model was silently selected. The current
Codex continued integration with Luna owning only avatar/seating fixes. Preserve
other changes already present in the shared v0.0.48 tree.

- Runtime durability: capture the acknowledgement callback once so mutation of
  the caller's options cannot bypass it. Caller-owned read-tool prechecks now
  run only after the `tool.started` acknowledgement. Regression tests exercise
  both the real precheck and callback mutation.
- Transient journal: terminal-run retention removes its RAM events, byte totals
  and event-ID index together. Conflicting event IDs across retained transient
  missions are rejected consistently with SQLite, without scanning other journals.
- Observe: manual selection matches `(sourceId, nativeSessionId)` just like hook
  ingest. A hook-only record adopts its validated transcript reference and keeps
  the Extalia session ID, name and gender; a regression covers end/restart/resume.
  Existing Claude continuation/branch separation is preserved. This does not yet
  restore the old character after automatic LRU retirement or explicit deletion;
  retired identity restoration needs a bounded durable design and History dedup.
- Avatar: corrected chair-local seated roots, forward finger goals and source
  palm pronation. Actual nail normals establish local +Z as the back of the hand,
  so the palm normal is −Z. A zero-weight movement reach does not suppress desk
  pronation; active chair/door reaches retain control. `sourceArmBasis.ts` removes
  authored upper/lower limb tilts before applying the ideal IK chain. Goals use
  the actual posed chest matrix, including separate spine/chest pivots, instead
  of an approximate rotation around the hips. Mouse wrists sit above the device.
  Pure FK regressions cover both sides and zero IK weight; render checks cover
  source male/female, procedural typing, mouse, light/dark backgrounds and narrow
  reduced-motion rendering. Temporary render fixtures must be removed before the
  release gate; local model assets must never be committed.

Final verification for this continuation:

- `pnpm version:patch` run once: 0.0.48 → 0.0.49.
- `pnpm check`: exit 0, 156 test files / 1,533 tests. Includes lint, boundaries,
  public safety, all workspace typechecks, production builds, version consistency
  and local hair/skeleton validation. Existing chunk-size/boot-script build
  warnings remain; no measured memory or FPS improvement is claimed.
- `pnpm test:desktop`: exit 0; scene ready, no model errors, three floor views,
  Settings and Diagnostics passed with a temporary profile.
- Visual artifacts (local, ignored `output/playwright/`):
  `v049-typing-source-final.png`, `v049-mouse-source-final.png`,
  `v049-typing-source-female.png`, `v049-typing-procedural-light.png`, and
  `v049-typing-source-phone-reduced.png`. Final source views have zero browser
  errors; Three.Clock deprecation remains. These are isolated render checks of
  production components, not claims of full Office interaction acceptance.
- Temporary `pose-review` HTML/TSX fixtures removed. No source model assets added,
  no real agent-app configuration changed, no commit or push.

Planning remains incomplete as shown above: durable leases/reconciliation,
digest-bound action approvals and the later v1 stages are still open. Preserve
this distinction when handing off to Claude Code.

## Furniture scale and seated contact continuation (2026-10-18)

User finding: chair/desk proportions looked wrong and legs passed through office
chairs/sofas. Measured diagnosis: office cushion 58 × 55 cm, top 54.75 cm; outer
arm width 78.5 cm and arm-pad top 89 cm (above the 78.5 cm desktop). Sofas were
54 cm and armchairs 56.5 cm high. The procedural renderer also ignored the
resource’s seat height, and relaxed clip offsets could lower thighs into cushions.

Delivered implementation (current Codex + Luna; Sol remained unavailable):

- Shared furniture/semantic dimensions: office cushion 50 × 46 cm, top 46 cm;
  outer arms 64 cm, pad top 71 cm, base diameter 72 cm. Task/executive back tops
  112/130 cm. Guest and meeting seats also use 46 cm tops; sofa/armchair tops are
  43/45 cm, including the custom executive sofa mesh. Barstools keep their height.
- Single and pod chairs move under the avatar. The avatar roots stay at the
  prior world coordinates, preserving v0.0.49 keyboard/mouse targets.
- `ResourceInteraction.seatFront` reaches both renderers via `SeatApproach`,
  occupants and facility staff. Front edges account for actual cushion depth and
  root offset; they differ for desk, meeting, guest and custom sofa geometry.
- `seatedPose.ts` constrains thigh contact, including lounge offsets, and calf
  flexion prevents floor penetration. The procedural renderer now honors the
  resource height. Source legs use actual rest lengths/offsets and calibrated
  two-bone rotations; standing/walking behavior retains its previous basis.
- Stand-up arm-pad, scoot seat-edge and backrest grip targets follow the shared
  chair dimensions. No global body/room/prop scale multiplier was introduced;
  desktop height stays 78.5 cm. No visual detail or texture quality was reduced.

Limits: this is contact-aware posing, not arbitrary mesh collision/cloth physics.
Short/stylized legs can hang when they cannot reach the floor from a supported
pose. Source-model assets remain local-only. No memory/FPS improvement is claimed.

Focused verification: 6 suites / 42 tests passed before the final guest and
seat-front propagation assertions. Visual checks used production components and
semantic blueprint anchors: office, sofa, armchair, guest, source male/female,
procedural fallback, 145/170/195 cm examples, light/dark backgrounds and a narrow
reduced-motion view. Local artifacts are under ignored `output/playwright/` with
`v050-` names. Temporary `fit-review` entry files were removed before the gate.
Release verification:

- `pnpm version:patch` run once: 0.0.49 → 0.0.50.
- Final `pnpm check`: exit 0, 158 test files / 1,544 tests. Includes lint,
  public safety/boundaries, all typechecks, production builds, consistent versions
  and local hair/skeleton checks. The final rerun includes the procedural pelvis
  roll fix: leg height follows pelvis sway, not the arm’s abduction angle.
- `pnpm test:desktop`: exit 0; scene ready, no model errors, all three floor
  views and Settings/Diagnostics passed with a temporary profile. Existing
  build-size and dependency deprecation warnings remain.
- Source male/female and fallback fit screenshots are isolated scene checks, not
  full arbitrary asset/collision certification. No source assets, temporary
  review entry files, real user profile changes, commit or push were added.

## Monitor/laptop fit continuation (2026-10-18)

User finding: desktop displays looked too large and too high relative to the
new seated pose. Audit found 78 × 46 cm single all-in-one glass, a 55 × 38 cm
laptop chassis, and centre-based monitor placements that embedded or floated
stands. Reception passed the work-surface height as the panel centre. Laptop
decks floated about 3.75 cm above single/pod supports.

Delivered by current Codex with gpt-6-luna audit/regressions. gpt-6.1-sol remains
unavailable due to its reported usage limit; no substitute model was dispatched.

- `props/deviceGeometry.ts`, `Monitor.tsx`, `Laptop.tsx`: metres, base-on-surface
  placement. Monitors have 10.5 cm housing clearance, 2.5 cm total bezel allowance
  and smaller stands. Laptop deck is 36 × 25 × 1.8 cm; lid hinge, screen and glow
  frame agree geometrically. Panel content/slots and rendering policies remain.
- Single all-in-one glass: 56 × 31.5 cm; housing top 123 cm from the floor
  (previously 150.75 cm). Dual/touchdown screens are 54 cm wide; pod screens
  50–56 cm; executive 54/58/54 cm; reception 50 cm. All glass uses 16:9.
- All five direct-caller families updated. Feet rest on 78.5 cm single desks,
  80.2 cm pod caps, 84.55 cm executive blotter and 76 cm reception shelf.
  The reception shelf and screens move behind the solid transaction counter body.
  Narrower multi-monitor layouts retain their slots. External keyboards, mouse,
  chairs, avatar roots, seated poses and movement/interaction ownership stay fixed.
- `apps/web/test/deviceGeometry.test.ts`: six tests cover actual component
  feet/clearance, lid hinge and screen-shell fit, inverse glow transform, all
  single/pod modes, touchdown/executive placement and reception stand support.
- Production-component isolated scenes inspected for single monitor, laptop,
  dual fallback, pod and executive, plus reception and narrow reduced motion.
  Local artifacts: ignored `output/playwright/v051-*.png`. No source assets added.

Release verification:

- `pnpm version:patch` run once: 0.0.50 → 0.0.51.
- Final `pnpm check`: exit 0, 159 test files / 1,550 tests. Lint, boundaries,
  public safety, workspace typechecks, production builds, version and hair checks
  passed. An unused test import caught on the first attempt was removed.
- `pnpm test:desktop`: exit 0, scene ready, no model errors, all three floor
  views and Settings/Diagnostics passed with a temporary profile. The existing
  non-fatal `net::ERR_FILE_NOT_FOUND` log and build-size/deprecation warnings also
  occur in the prior v0.0.49/v0.0.50 smoke logs.
- Temporary review entry files removed and owned preview/browser processes closed.
  No real profile or external app configuration changes, source assets, commit or
  push were added. Final Luna review found no actionable placement/frame errors.

Limits: fixed device proportions; no per-avatar automatic monitor adjustment,
arbitrary mesh collision or measured memory/FPS improvement claimed.
The native scheduler gates 3.3/3.4 and observe LRU identity gap remain open.

## Avatar spawn appearance continuation (2026-10-18)

User finding: newly spawned characters first looked like the older procedural
style, then changed to the detailed local model. Cause: `CharacterBody` used the
procedural body as both its loading placeholder and source-error fallback.

Implemented by current Codex with gpt-6-luna audit/regression. gpt-6.1-sol remains
unavailable due to its reported usage limit; no model substitution was dispatched.

- `OfficeCharacter.tsx`: selected-source Suspense fallback is empty; the body
  appears after both selected source assets are ready. Missing/failed source
  fallback remains procedural, so public builds still work without local assets.
- Only the selected body and hair URLs are preloaded together with the same
  Draco/Meshopt settings and separate per-URL cache keys as `SourceHumanoid`.
  No whole-library preload, pair-key duplicate body cache, new LOD, or source
  model files. Existing skeleton/material clones and movement state are retained.
- `apps/web/test/avatarSourceLoading.test.ts` renders the real CharacterBody
  boundary with independently deferred source reads: no procedural meshes during
  body/hair waits, selected source only after both resolve. Together with the
  existing source-availability suite, focused verification passed (2 suites / 5 tests).
- Actual browser proof used production CharacterBody/Sofa with a temporary scene
  probe. Artificial delays of 1.8 s body and 4.2 s hair yielded no procedural body
  frames; both selected requests started together. Warm unmount/remount made zero
  additional asset requests. A deliberate body 404 rendered the procedural body
  without losing the scene. Procedural-only narrow/dark/reduced-motion path passed.
  These are loading-behavior checks, not real-world latency or memory benchmarks.
  Local screenshots: ignored `output/playwright/v052-*.png`.

User also suggested a fast lightweight look matching the detailed character.
Current decision: fix selected-asset loading and the style flash first. A future
LOD should derive from the same proportions, skeleton and appearance; no claim
that the current procedural character is a matching LOD. Under slow loading the
visual body waits, while presence, selection and movement state continue.

Release verification:

- `pnpm version:patch` once: 0.0.51 → 0.0.52.
- `pnpm check` exit 0: 160 test files / 1,551 tests, lint/public safety/boundaries,
  workspace typechecks, production builds, versions and local hair checks passed.
- `pnpm test:desktop` exit 0: scene ready, no model errors, all three floor views,
  Settings/Diagnostics passed using a temporary profile. Previously recorded
  non-fatal file-not-found, chunk-size and deprecation logs remain unchanged.
- Final Luna review found no cache-key, load-fallback or clone-isolation issues.
  Temporary review entry files removed; owned browser/Vite processes stopped.
  No source assets, real-profile changes, external configuration, commit or push.

Native scheduler gates 3.3/3.4 and observe LRU identity restoration remain open;
this visual slice does not complete the v1 plan.

## Desk fit integration review (2026-10-19)

The shared checkout has advanced through v0.0.56. Preserve its subsequent work:
procedural proportions/pose LOD (v0.0.53), real keyboard/mouse dimensions and stable
per-seat desktop furnishings (v0.0.54), detailed hair (v0.0.55) and exterior work
(v0.0.56). Do not replace these with earlier isolated-preview constants.

Earlier elbow work is integrated: executive office/studio chairs sit at z=-0.85,
with the avatar root and hand targets following the same blueprint; single and
pod keyboards use shared anchors. The later `deskLayout` also supplies actual
keyboard dimensions, alpha-block offsets, mouse handedness and accessory layouts
to both rendered props and hand targets. The general arm solver is unchanged.

Focused current-checkout verification: desk typing, arm IK, device geometry and
furniture anchors passed (4 suites / 28 tests); desk layout passed (1 / 5).
Current source/procedural desk and executive screenshots were visually inspected
under ignored `output/playwright/v056-*-current.png`. The fallback head/body
proportions now visibly approach the detailed body's proportions. Earlier elbow
angle measurements apply to their recorded model/pose, not every later asset.
Full integration `pnpm check` passed on v0.0.56: 164 test files / 1,571 tests,
including lint, public safety, typechecks, builds, versions and hair checks.
Desktop smoke passed (exit 0): scene ready, no model errors, all three floors
and Settings/Diagnostics passed with a temporary profile. Previously recorded
non-fatal file-not-found and build/deprecation logs remain.
This was verification/documentation of the already-versioned
shared checkout; no additional implementation/version bump was introduced here.
Both requested worker models subsequently reported
usage limits; further work uses the current Codex, without silent substitution.

Blender connectivity: read-only local MCP initialization, tool discovery and scene
query succeeded. The add-on responds on loopback. The available server reports
an older add-on protocol and uses compatibility fallbacks. No persistent Codex
MCP configuration or Blender scene/assets were changed. Do not auto-upgrade the
add-on/configuration; the repository's external-configuration workflow applies.

## Reference-led building skin (2026-10-19)

User requested a campus exterior resembling the supplied architectural reference.
Delivered silver perforated ribbon frames with connected diagonal jambs, long
window slots, a wider glass corner, slim mullions, aligned entrance canopy and
warm accent edges. Six visual courses still wrap three actual interior levels;
no floor, furniture, avatar, runtime or session identity migration is included.

Implementation: `facadeElevation.ts` owns pure front-frame geometry;
`CampusBuildingShell.tsx` merges it with rounded side/rear sweeps. Old separate
floating diagonal strips are removed. Non-indexed extrusions are normalized
before merging with indexed sweeps. Solar-driven cladding/glazing use live
material references under static batching. The cladding texture remains small
and shared; alpha glass uses no transmission render, and no shadow light is
added. Transparent front-curtain overdraw is not benchmarked.

Orchestration: Codex implemented the shell; GPT-6 Luna supplied five geometry
regressions; GPT-6.1 Sol reviewed the assembled envelope and supplied two portal
regressions. The latter tests 81 clearance rays and four closed-wall controls
with the renderer's mirrored world transform. They cover the envelope and its
generated mullions, not every separate scene fixture or navigation physics.
Focused facade/signage verification passed: four suites / 16 tests. Day, night
and front renders use actual production components in an isolated local preview;
artifacts remain ignored under `output/playwright/v057-facade-*.png`.
Release verification: `pnpm version:patch` once, 0.0.56 → 0.0.57.
`pnpm check` exit 0: 166 suites / 1,578 tests, lint, boundaries, public safety,
workspace typechecks, production builds, version consistency and local hair
checks passed. Final Sol review found no critical material lifetime/batching or
portal regression. Temporary review entry files were removed and owned browser
and Vite processes stopped.

Preview caveat: an isolated day-to-night QA transition emitted WebGL sampler
mismatch warnings; fresh forced-day/night renders remained valid. The unchanged
shadow-map budget/reallocation path is a possible cause, not an established
finding. Do not claim a clean transition console or measured FPS/memory gains.
`pnpm test:desktop` exit 0 on v0.0.57: scene ready, no model errors, all three
floor views and Settings passed with a throwaway profile. Existing non-fatal
file-not-found, chunk-size and deprecation logs remain. No real-profile or
external-configuration changes, commit or push.

Open v1 work remains scheduler gates 3.3/3.4, provider certification and observed
LRU session identity restoration. Do not infer that this exterior slice
completes the application plan.

## Next session checklist for Claude Code

1. Inspect current `git status` and this ledger; read the required repository
   documents. The four historical failures are resolved; use the most recent
   verification result rather than treating the first attempt as current.
2. Review the exported contract API and adversarial validation tests. A parsed
   record is data, not authority to execute or proof of completion.
3. Stage 1 contracts, Stage 2 kernel/host, lead planning and Missions UI are delivered. Do not rebuild the UI. Read ADRs 0008–0016 and the latest verification. Live-provider and actual artifact evidence are still needed for full acceptance. Planning admission, retained DAG metadata and bounded native runtime budgets are in place; durable leases and reconciliation remain incomplete. Keep rendering optimization and durable scheduler migration separate.
4. Explicit model selection must be preserved. Plan provider failures,
   cancellation/depth/concurrency limits and evidence collection before running
   parallel tools. Use isolated writers; no fabricated capability/progress.
5. Stage 3 checkpoints (ADR 0013), atomic control events (ADR 0014, gate 3.1)
   and runtime budgets (ADR 0015, gate 3.2) are delivered. Next: gate 3.3
   leases/reaper and explicit reconciliation, then 3.4 digest-bound approvals.
   OpenAI-compatible streams already request usage (FR-04); certify actual
   provider responses before claiming token-budget coverage for a server. Checkpoint change cursors are not v1/session
   event sequences. No destructive replay.
6. Test with temporary data/profile directories, never the real user profile.
   Update this ledger and the app-flow tracker. Add Unreleased notes, run
   `pnpm version:patch` once for the completed implementation and `pnpm check`.
   Do not commit, push, deploy or edit another app's config without authorization.

**W3 slice 2, W4 start, constant commits (2026-10-23):** daemon skill operations
(`crates/extalia-daemon/src/skills.rs`, `packages/protocol/src/daemonSkills.ts`, 91 shared
fixtures; `crates/extalia-daemon/tests/skills.rs`); `skill.review`, stored consent input and
persisted built-ins wait for core migration 0004. W4 slice 1 (ADR 0028 proposed):
`packages/host/src/worktrees/` with write-capable tasks (`access: 'write'`), serial
integration queue, test gate evidence, digest-bound apply, orphan detection
(`packages/host/test/{worktrees,missionWorktrees}.test.ts`); no UI, worker edits not yet in
the journal, Rust-side worktree leases pending. Running totals: core.sqlite migration 0003,
missions.sqlite schema 3 (`docs/benchmarks/native-core-2026-10-22-totals.md`).

**W3 host/UI and W4 UI (2026-10-23):** core schema 4 (`migrations/0004_skill_reviews.sql`,
`skills/review.rs`) serves `skill.review`; host `packages/host/src/skillRegistry.ts` +
Settings "Skill Security Center" (`apps/web/src/pages/settings/SkillSecurityCenter.tsx`);
with `nativeCore: 'rust'` the `skill_read` catalog is built-ins + active daemon revisions
(read through `skill.read` on every call). W4: shared journal admission
(`packages/protocol/src/missionJournal.ts` → `schemas/journal-admission.json`, used by
`missionCheckpoints.ts` and `crates/extalia-core/src/mission/policy.rs`), `Task.access: 'write'`,
worktree methods on AgentHostApi (`packages/host/src/worktrees/hostMethods.ts`) and the
Missions Changes panel (`apps/web/src/missions/MissionChanges.tsx`). Open: skill contract
`workspaceId` is a UUID but host workspace ids are `w_…` (consent inputs cannot be shown in
the UI yet); no operation reports the scanner pin; workspace test-gate setting; Rust-side
worktree leases and integration approvals.

**W3/W4 follow-ups and W5 start (2026-10-23):** core schema 5 (`0005_workspace_ids.sql`) lets
skill operations take host workspace ids (`HOST_WORKSPACE_ID_PATTERN`); `skill.scanner`
reports the inspector; consent inputs show in the Skill Security Center. Workspace
`integrationGate` setting (ADR 0028 note: no ungated apply). W5 slice 1:
`crates/extalia-core/src/knowledge/` with its own `knowledge.sqlite` (ADR 0024 amendment);
not yet on the wire. Note: native mission contracts use a fresh random `workspaceId` UUID per
mission (`packages/host/src/mission.ts`), so `missions.workspace_id` in core.sqlite is not the
host workspace id — map it explicitly before core-side queries join missions to workspaces.

**W5 slice 2 (2026-10-23/24):** daemon knowledge operations
(`packages/protocol/src/daemonKnowledge.ts`, `crates/extalia-daemon/src/knowledge.rs`,
`tests/knowledge.rs`); core `knowledge/write.rs` (CAS writes, conflict copies, journal and
rollback under `<data>/profiles/<profile>/knowledge-history/`, `managed_by: extalia`) and
`knowledge/import.rs` (memory notes → `Projects/<ws>/Memory/`, masking parity with the host
`redact`); Knowledge page `apps/web/src/knowledge/` against platform types
(`packages/platform/src/knowledge.ts`) and a mock vault. Open: host knowledge service over the
daemon, write/import ops on the wire, watcher, walker should report control-character names
as `invalid_name`, user-chosen vault root, shared vault, workspace-visibility nodes.

**W5 graph (2026-10-24):** `knowledge.overview` (core `query.rs` overview_nodes/edges, daemon
byte budget), host `packages/host/src/knowledge.ts` (8 methods, serialized sync, auto
incremental sync after 5 min), whole-vault 3D view `apps/web/src/knowledge/vault/`
(`d3-force-3d` 3.0.6 in a worker, 3 draw calls, demand frameloop). Open: missions share the
daemon connection with a 5 s deadline, so a long vault sync can delay a mission request
(consider a separate connection or priority queue); the daemon now starts at app launch when
the Rust core is on (Knowledge status check).

**W5 editing, vault root, watcher (2026-10-24):** daemon `knowledge.read/write/history/rollback/
importMemory` and `--vault-root` (`crates/extalia-daemon/tests/knowledge_write.rs`); host
`packages/host/src/{knowledgeEdit.ts,knowledgeVault.ts,vaultWatcher.ts}`; UI
`apps/web/src/knowledge/KnowledgeEdit.tsx`, Settings `KnowledgeVaultSection.tsx`. Known flake:
`an_unusable_index_never_stops_the_daemon` (`crates/extalia-daemon/tests/knowledge.rs`) failed
with `index_locked` in 2 of 4 loaded full runs — likely a lock-release race with the
binary-spawning test in the same file; not yet fixed. Vitest timeouts raised to 15 s.

**Daemon concurrency, flake fix, W6 start (2026-10-24):** knowledge requests run on a daemon
worker thread with a single mutex-guarded frame writer (ADR 0020 note) — resolves the
"missions share the daemon connection" item above. The `index_locked` flake was fd
inheritance of `flock` lock descriptors into a spawned child between fork and exec; fixed by
test isolation (`crates/extalia-daemon/tests/support/mod.rs`) — resolves the "Known flake"
item. **Production follow-up:** once the daemon spawns workers (ADR 0022 scanner/Python
worker, W3), the same fork→exec window can transiently hold store locks in the child; spawn
workers before taking store locks or from a lock-free helper process. W6 slice 1: ADR 0029
(proposed), core schema 6 (`0006_learning.sql`), `crates/extalia-core/src/learning/`; not on the
wire. Open owner questions in ADR 0029 (min verified count, revalidation windows, retention,
failure counterexamples).
