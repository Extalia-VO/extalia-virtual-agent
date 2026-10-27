# EXTALIA — Autonomous AI Workforce, Unified
## Product Requirements Document (PRD) v1.1 — Orchestrate · Observe · Evolve

**Status:** Consolidated implementation specification; not implemented. **Update:** 2026-10-21. **Baseline:** v1.0 plus approved design decisions FR-15–FR-24.  
**Baseline:** the repository as of October 2026; existing UX v0.0.20 proposal and exterior/solar specifications are companion documents.  
**Product:** Extalia Virtual Agent + Virtual Office  
**Platforms:** macOS / Windows / Linux desktop, web client  
**Primary language:** English UI by default; Indonesian localization optional  
**Product principle:** **Lightweight by default, powerful when activated.**  
**Competitive positioning:** Independent alternative/complement to Hermes Agent; no Hermes runtime dependency.

---

# 1. Executive summary

Extalia is a **local-first, multi-model, multi-agent operating environment** with three first-class capabilities:

1. **Orchestrate:** native lead-agent supervision, parallel heterogeneous-model subagents, persistent task graphs, tool execution, budgets, approvals, and validated deliverables.
2. **Observe:** read-only-first observation of external Codex, Claude Code, Hermes, Gemini/Antigravity, and extensible third-party agent sessions, all in one truthful event model and 3D office.
3. **Evolve:** permissioned memory, Obsidian-compatible knowledge, experience capture, candidate skill generation, evaluation, versioning, rollback and opt-in activation.

Extalia is NOT merely a Three.js visualization, an LLM chat wrapper, or a fork of Hermes. Its primary value is a **single accountable lead agent**, observable multi-agent work, reproducible outputs, and learning across workflows.

## 1.1 Product promise
- One conversation with the lead agent .
- Multiple specialized agents with **different models/providers concurrently**.
- Real task evidence, not invented progress.
- External agent sessions visible without taking them over.
- Durable, restart-safe missions.
- Small idle footprint; 3D view never required for the orchestration daemon to work.
- Trust boundaries that keep private separate work, personal and client workspaces isolated.

## 1.2 What “compete with Hermes” means
Functional competitiveness must be evaluated by user outcomes rather than unsupported feature-parity claims:
- fast setup and reliable standalone agent operation;
- provider/model flexibility;
- effective tools and skill reuse;
- long-running missions and recoverability;
- cross-model parallel delegation;
- external-session observability;
- cost, latency and quality transparency;
- local-first portability and openness.

No claim that Hermes categorically limits model delegation without reproducing and documenting the exact version/configuration under test.

---

# 2. Users, jobs-to-be-done and scope

## 2.1 Personas
- **Solo developer:** delegate backend/frontend/test/review work across models without manually coordinating terminals.
- **Technical lead:** assign missions, enforce approvals and inspect verified results.
- **AI power user:** observe external CLI agents in one place, replay sessions, tune models/budgets.
- **Open-source contributor:** build model, engine, tool and knowledge adapters.
- **Privacy-sensitive workspace owner:** maintain local data and strict profile isolation.

## 2.2 Jobs to be done
1. “Give the lead agent a complex development task; let her split and supervise it.”
2. “Show me which agents are actually working, what they did, and what needs me.”
3. “Recover an interrupted mission without repeating destructive actions.”
4. “Find the most appropriate available model without overspending.”
5. “Learn reusable workflows from validated experience without silently changing permissions.”
6. “Observe my independently running CLI agents without hijacking their sessions.”

## 2.3 In scope
Native orchestration, multi-provider routing, task graph, agent lifecycle, adapters, event store, mission control, approvals, replay, knowledge/skills, Obsidian bridge, 3D truthful projection, performance, desktop/web UI, plugin contracts, observability, onboarding and security.

## 2.4 Out of scope for first stable release
- Training foundation models.
- Unbounded self-modifying code or self-granted permissions.
- Fully autonomous production deployment without explicit scoped authorization.
- Remote multi-tenant SaaS, marketplace billing and arbitrary plugin execution.
- Perfect introspection into closed external agent tools.
- Guaranteed FPS or cost on untested hardware.
- Mandatory cloud services or always-on Python.

---

# 3. Success metrics and service objectives

All targets are **acceptance goals to measure**, not achieved benchmarks.

| Dimension | Target / measurement |
|---|---|
| First-run | Setup to first successful native model response in ≤ 5 minutes on documented happy path |
| Idle | No continuous 3D rendering when Office hidden; background service baseline memory/CPU measured per OS |
| Office | ≥ 40 FPS p95 observed during defined target-hardware benchmark (Campus, F1/F2/F3, Stack, night) |
| Mission | 100% task state transitions journaled before external side effects |
| Recovery | Restart restores nonterminal missions; in-flight tools reconciled before retry |
| Delegation | ≥ 3 simultaneous subagents using ≥ 2 distinct model providers in integration tests |
| Integrity | No observed session presented as controlled without explicit adapter capability |
| Approvals | 100% destructive/high-risk operations blocked pending policy decision |
| Learning | 0 skills automatically promoted to privileged execution without review |
| Transparency | Every claimed “completed” task links to deliverable/evidence or is explicitly unverified |
| Security | Secrets redacted in UI/log/knowledge by default, with regression tests |
| Resource | Configurable agent, provider, process, token, cost and delegation-depth ceilings |

Use p50/p95 latency, CPU/RAM/GPU and token cost measurements under repeatable test scenarios. Establish baselines before choosing numeric memory budgets.

---

# 4. Architecture decision: hybrid but incremental

## 4.1 Recommended runtime
- **TypeScript / React / R3F:** UI, web client, Office 3D, themes, interactions.
- **Rust (Tokio, Axum, Serde, SQLx):** *target* independent orchestration daemon, process supervisor, event ingestion, durable scheduler, policy enforcement, IPC and SQLite transaction ownership.
- **Python:** *optional* isolated learning/embedding/evaluation worker, started on demand; NOT a required dependency for first-run chat/orchestration.
- **SQLite WAL:** canonical local task/event/approval/agent registry state.
- **Markdown + Git:** skills, knowledge artifacts and reviewable changes.
- **Obsidian:** optional Markdown vault front end, not operational database.
- **Electron:** preserve existing desktop runtime until an explicit measured migration decision; do not migrate to Tauri as a prerequisite.

**Important:** Do not rewrite the current working TypeScript stack in one release. First define protocol/contracts and implement an adapter-backed kernel. Rust may be introduced behind those contracts milestone by milestone. Compare complexity, process overhead and reliability against a TypeScript baseline.

## 4.2 Processes
```text
React UI / Three.js Office (can close)
               │ local authenticated IPC / WebSocket
               ▼
Extalia Core Service (Rust target; TS transitional adapter)
  ├─ Mission Scheduler + Task DAG
  ├─ Lead Agent Supervisor
  ├─ Agent/Model/Skill Registries
  ├─ Provider Router + Cost Governor
  ├─ Permission Engine + Approval Queue
  ├─ Tool/Process Supervisor + Workspace Isolation
  ├─ Observability Adapter Host
  ├─ Durable Event Store + Replay
  └─ Knowledge Job Queue
               │
         ┌─────┴─────────────┐
         ▼                   ▼
 Native Agent Workers   External Observers
 (multi-model)          (read-only default)
         │                   │
         └──────┬────────────┘
                ▼
      Normalized Events / SQLite
                │
        Python Learning Worker (optional)
                │
        Markdown/Obsidian + Skill Candidates
```

## 4.3 Core boundaries
- **Core owns:** mission/task transitions, permissions, model/provider quotas, process control, durable events.
- **Workers own:** model interactions and task-local reasoning; may propose tools but cannot grant themselves permissions.
- **Adapters own:** translating external sessions/events; capability-scoped.
- **UI owns:** presentation only; no scheduler truth in React state.
- **Knowledge owns:** derived, attributable documents; never authority over live task state.

---

# 5. Canonical domain model

Define stable UUIDs and explicit schema versions.

```ts
type AgentOrigin = 'native' | 'observed';
type MissionState = 'draft'|'planning'|'queued'|'running'|'waiting'|
                    'awaiting_approval'|'reviewing'|'completed'|'failed'|
                    'cancelled'|'recovering';
type TaskState = 'queued'|'blocked'|'assigned'|'running'|'waiting'|
                 'awaiting_approval'|'verifying'|'completed'|'failed'|
                 'cancelled'|'unknown';
type EvidenceKind = 'test'|'build'|'diff'|'artifact'|'log'|'review'|'user_confirmation';

interface Mission {
  id: string; workspaceId: string; leadAgentId: string;
  state: MissionState; budgetId: string;
  createdAt: string; updatedAt: string; version: number;
}
interface Task {
  id: string; missionId: string; parentTaskId?: string;
  dependsOn: string[]; assignedAgentId?: string;
  state: TaskState; attempt: number; leaseId?: string;
  requirements: string[]; evidenceIds: string[];
}
interface AgentIdentity {
  id: string; origin: AgentOrigin; role: string;
  workspaceId: string; supervisorId?: string;
  engineId: string; modelId?: string; capabilityIds: string[];
}
interface AgentEvent {
  id: string; schemaVersion: number; source: string;
  missionId?: string; taskId?: string; agentId?: string;
  sourceTimestamp?: string; observedAt: string;
  sequence?: number; type: string; payload: unknown;
  confidence: 'reported'|'observed'|'inferred';
}
interface Approval {
  id: string; actionDigest: string; actorId: string;
  workspaceId: string; expiresAt: string; status: string;
}
```

**Rules:** Observed ≠ controlled; `unknown` ≠ `idle`; tool output ≠ verified success; no percentage progress without task/evidence denominator; source timestamps and observation timestamps must remain distinct.

---

# 6. Functional requirements (prioritized)

## FR-01 First-run and shell — P0
- Lightweight animated EXTALIA splash; no duplicate 3D renderer during splash.
- Validate setup state; first-run wizard exclusively until required config succeeds.
- Returning user lands on 3D Office, but daemon starts independently of page visibility.
- Keep Chat and Office as separate routes; remove redundant Virtual Agent/Virtual Office radio switch.
- Restart action in desktop; web reload separately labeled.
- Graceful no-provider, offline, corrupt-config and migration recovery.
- macOS/Windows/Linux packaging plan and versioned config migrations.

**Acceptance:** incomplete setup cannot be bypassed by deep link; existing sessions not lost; splash supports reduced motion.

## FR-02 Native lead agent — P0
- One named lead agent per mission; a default lead per profile, configurable per workspace.
- Lead can plan, delegate, summarize, request approvals and verify integration.
- Lead has no magical knowledge of unobserved work; reports cite task events and evidence.
- User may intervene, pause, resume, reassign or cancel.
- Supervisor summaries are event-based and rate-limited, not a flood of terminal output.

**Acceptance:** all child tasks report to mission supervisor; final report distinguishes verified/unverified work.

## FR-03 Parallel heterogeneous subagents — P0
- Agents are identities; models are replaceable inference backends.
- Per-agent model/provider/skills/tools/workspace/budget configuration.
- Concurrent subagents may use different providers and different models.
- DAG dependencies, bounded delegation depth, concurrency slots, timeouts, cancellation, backpressure.
- Subagent spawning must be policy-checked and tracked; no recursive spawn storms.
- Same-model and cross-model concurrency both supported.

**Acceptance:** integration fixture runs 3 parallel tasks with 2+ provider implementations; one provider failure does not corrupt unrelated tasks.

## FR-04 Model registry/router — P0
- Provider capabilities discovered/configured: tool calling, streaming, vision, context, pricing, rate limits.
- OpenAI-compatible endpoint support plus independently implemented adapters as feasible.
- Explicit model selection, preferred/fallback routes and task-aware routing.
- Circuit breaker, rate limiting, exponential backoff, provider health and per-model concurrency.
- Price tables are versioned, user-overridable and marked estimates; actual billing may differ.
- Do not send data to a provider disallowed by workspace policy.

**Acceptance:** route and fallback decisions are logged with reason; secrets never appear in logs.

## FR-05 Tools and execution — P0
- File read/write, Git, terminal, tests/build, optional browser/search via capability-scoped tools.
- Typed tool schemas, timeouts, stdout/stderr caps, cancellation and process tree cleanup.
- Tool actions have idempotency keys; non-idempotent actions require recovery reconciliation.
- Worktree isolation for write-capable concurrent coding agents; read-only snapshot sharing permitted.
- Explicit artifact ownership, integration queue, diff review, test gates, merge conflict resolution.
- Never silently merge to protected branches or deploy to production.

**Acceptance:** two concurrent writers cannot silently overwrite the same file; process cancellation cleans children.

## FR-06 Durable task graph — P0
- SQLite WAL, schema migrations, transactional state transitions, append-only event journal.
- Crash-safe task leases, heartbeat, reaper, recovery states and retry policies.
- No blind replay of destructive commands after restart.
- Resume from durable checkpoints; show exact status if external process recovery unsupported.
- State/event pagination and retention policy.

**Acceptance:** forced restart mid-task yields recoverable/unknown state, never fabricated completion or duplicate deployment.

## FR-07 Observe external engines — P0/P1
- Adapter contract supports Codex CLI, Claude Code, Hermes, Gemini/Antigravity where public/local integrations actually permit.
- Discovery via explicit folder permission, supported hooks, session exports or process metadata; no unrestricted scanning.
- Read-only by default; per-adapter capabilities: observe, read_messages, read_tools, pause, resume, control, delegate.
- Source freshness, confidence and last-seen timestamps; unavailable data shown as unavailable.
- No automatic takeover or kill of external sessions.
- No unsupported claim that every engine exposes tokens, costs or detailed tools.

**Acceptance:** unsupported control buttons hidden; stale session not falsely marked working.

## FR-08 Mission Control / approvals — P0
- Active missions, agents, blockers, dependency DAG, waiting approvals, verified deliverables.
- Approvals include action, scope, exact parameters digest, risk, expiry, requester, workspace.
- Emergency Stop affects only Extalia-controlled processes; observed engines unaffected.
- Audit trail for decisions and overrides.
- Progress is verified-task based, not LLM-generated arbitrary percentage.

**Acceptance:** approval invalidated if action parameters materially change.

## FR-09 3D Virtual Office — P1
- Campus/F1/F2/F3/Stack spectator views, floor/light controls in Office-only header.
- View fits available viewport without page scroll; compact liquid-glass layout has clear gutters.
- Agent positions/status derive from canonical event state, never fake work.
- Avatar click opens compact popover; Agents & Sessions click opens full modal (Messages/Activity/Tasks/Tools), board collapses and restores.
- Semantic bubble: “Reading file…”, “Running tests…”, etc.; never raw commands or secrets; bubble fades when no activity.
- Facility NPC: female receptionist and male bartender are persistent F1 facility roles, not coding workers; allowed leisure areas strictly constrained; return to stations on visitor/service demand.
- Reception desk is not allocated to generic agents.
- Spawn queue: max 3 avatar admissions per second with stagger; configurable; real agent events never dropped.
- Preserve semantic navigation, stairs, crowd avoidance and truthful room/meeting assignments.
- Realtime local-location environment and warm night office retained; graphics quality preserved through light budgets, instancing and LOD.

**Acceptance:** 3D hidden does not stall mission execution; ≥40 FPS benchmark target without sacrificing night ambience.

## FR-10 Learning/experience — P1
- Experience collector records task plan, tools, outcomes, test evidence, corrections and costs, with redaction.
- Memory scopes: mission, workspace, user-approved global. No automatic one profile → another sharing.
- Pattern discovery produces **candidate** preferences/skills with provenance, confidence and counterexamples.
- Skill format `SKILL.md` with manifest, capabilities, tests, version, source, provenance and rollback.
- Automated validation/sandbox test before review; approval required for privileged activation.
- Obsidian-compatible Markdown vault sync opt-in; atomic writes and conflict-safe handling.
- Model effectiveness derived from verified outcomes and sample size, not agent self-rating.

**Acceptance:** a rejected skill never becomes active; rollback restores prior skill version; sensitive data stays within scope.

## FR-11 Workflow automation — P1
- Manual, schedule, Git webhook, filesystem and dependency triggers.
- Idempotent trigger ingestion; timezone-safe schedules; pause/resume.
- Automation respects same budget and approval policy as manual missions.
- Background daemon executes without Office open.

## FR-12 Replay/observability — P1
- Historical timeline from recorded events; no invented interpolation of unobserved work.
- Structured traces, event correlation IDs, task/agent/session filters.
- Privacy-aware log retention and export.
- Agent activity popovers use semantic summaries; detailed logs remain behind permissions.

## FR-13 Extensions — P2
- Versioned SDK for providers, observers, tools, skills and knowledge connectors.
- Manifest permissions, compatibility ranges, sandbox/isolated execution where possible.
- Plugin failures isolated from core.
- No arbitrary unsigned plugin auto-execution.

## FR-14 Theme/accessibility — P1
- Existing themes plus optional modern macOS-inspired Liquid Glass Pro.
- CSS-first translucent surfaces, controlled blur, no expensive live refractive layer over 3D by default.
- Respect reduced transparency/motion, keyboard, focus trapping, contrast and screen reader labels.
- Theme GPU cost included in FPS regression suite.

---

# 7. Lead-agent governance and collaboration

## 7.1 Supervision contract
Every native task has `missionId`, accountable lead, assigned worker, permissions, budget, evidence and lifecycle. Child workers may ask for help but cannot expand beyond configured depth/concurrency/cost.

## 7.2 Delegation policy
- `maxActiveAgents`, `maxDelegationDepth`, `maxSubagentsPerParent`, `maxToolProcesses`, `maxConcurrentBuilds`, `maxLocalModelJobs`, per-provider concurrency.
- Work stealing only between agents with matching permissions/skills.
- Cancellation propagates down task DAG; supervisor can preserve already-verified artifacts.
- Worker failure triggers bounded retry/reassign; no infinite loops.

## 7.3 Collaboration
Use explicit proposal/review/dispute/decision records. Meetings in 3D occur only on real collaboration events. Integration coordinator resolves changes through diff/tests, not majority vote of models.

---

# 8. Security and privacy requirements

**Threat model:** prompt injection in repository/web/tool output, malicious skill/plugin, secret exfiltration, workspace leakage, shell abuse, poisoned memory, untrusted external-session logs, replay of destructive commands, SSRF/network abuse.

Controls:
1. Per-workspace filesystem allowlist; deny sensitive paths by default.
2. Scoped network egress policy and provider allowlist.
3. Secret vault/OS keychain; never persist plaintext tokens in Markdown, UI state or event payload.
4. Tool permission matrix and approval digest/expiry.
5. Sandboxed subprocesses where OS permits; disclose unsupported containment.
6. Separate observed session read rights from process control.
7. Sanitized external events; treat observed output as untrusted data, never instructions.
8. Knowledge ingestion redaction, provenance and scope checks.
9. Immutable/auditable decision records and user-visible revocation.
10. Plugin signing/allowlist policy and dependency vulnerability review.
11. Explicit data export/delete and retention controls.
12. Threat-model and adversarial tests before public release.

No claim that Rust alone supplies a security sandbox.

---

# 9. Data and storage

Canonical tables (names illustrative):
- `workspaces`, `profiles`, `agents`, `engines`, `models`, `provider_credentials_refs`
- `missions`, `tasks`, `task_dependencies`, `task_attempts`, `task_leases`
- `events`, `tool_calls`, `artifacts`, `evidence`, `approvals`
- `budgets`, `usage_records`, `provider_health`
- `observed_sessions`, `adapter_capabilities`, `session_mappings`
- `memories`, `knowledge_sources`, `experience_records`
- `skills`, `skill_versions`, `skill_evaluations`, `learning_candidates`
- `workflow_definitions`, `workflow_runs`, `audit_log`

Use migrations and backup/restore. Event append and task state update must be transactional when in same store. Store large logs/artifacts in content-addressed filesystem, with SQLite references and retention. Encrypt sensitive data at rest where feasible, with OS keychain-managed keys.

---

# 10. APIs and event protocol

Local API endpoints (illustrative, versioned):
```text
GET    /v1/health
GET    /v1/capabilities
GET    /v1/agents
GET    /v1/observed-sessions
POST   /v1/missions
GET    /v1/missions/:id
POST   /v1/missions/:id/pause
POST   /v1/missions/:id/resume
POST   /v1/missions/:id/cancel
GET    /v1/missions/:id/tasks
GET    /v1/approvals
POST   /v1/approvals/:id/decision
GET    /v1/skills
GET    /v1/learning-candidates
GET    /v1/events?cursor=...
GET    /v1/stream (SSE/WebSocket)
```

IPC must authenticate local clients, validate origin and restrict bind address to loopback by default. Use schema-versioned events, monotonically increasing store sequence, reconnect cursor, deduplication, bounded buffers and backpressure.

**No frontend-to-provider secret leakage.**

---

# 11. Resource-aware performance

## 11.1 Design principles
- Headless core runs with no GPU/3D requirement.
- 3D rendering and orchestration run in separate processes/threads where practical.
- Optional Python worker sleeps/stops when unused.
- No global polling storm: hooks/events preferred; polling bounded and configurable.
- Backpressure on event streams and log ingestion.
- CPU/RAM quotas and process concurrency.
- Batch DB writes without losing critical transition durability.
- Lazy-load Office scene, avatar assets, theme effects and heavy knowledge libraries.
- No mandatory vector DB for MVP; start with SQLite FTS and optional embeddings.

## 11.2 Rendering
- Real-light budgets per view, emissive fixtures/fake light pools at night.
- Shadow budgets, selective casters, baked/contact grounding.
- Instancing/batching for repeated façade, paving, plants, fixtures.
- View-aware room/avatar LOD; hidden scenes do not run costly updates.
- SmartScreens update on state change; texture uploads throttled.
- Limit DPR based on measured device capability without indiscriminate blur.
- Profile draw calls, triangles, shader compile, texture memory, long tasks, FPS and p95 frame time.
- Do not add GPU-intensive live glass refractive layers over the Office by default.

## 11.3 Benchmark profiles
A. Office day; B. Office night; C. Stack; D. 20 visible agents; E. 20 API agents headless; F. 3 concurrent builds; G. idle 30 minutes; H. resume after crash. Publish hardware, OS, browser/Electron, resolution, DPR, build SHA and methodology.

---

# 12. UX and information architecture

Navigation:
- **Office** (default after setup): spectator campus/floors, status, avatar popovers.
- **Chat**: lead-agent conversation and mission context.
- **Missions**: DAG, status, evidence, results, approvals.
- **Agents & Sessions**: native/observed, model, origin, capabilities, session detail modal.
- **Knowledge & Skills**: memory scope, candidate review, versions, Obsidian.
- **Workflows**: schedules/triggers.
- **Insights**: cost, quality, replay, health.
- **Settings**: providers, permissions, themes, budgets, storage, integrations.

First-run wizard order: workspace/profile → data/privacy → provider/engine → connection test → permissions → optional external observation → finish. Keep optional integrations skippable.

Screens must distinguish `Working`, `Waiting`, `Unknown`, `Stale`, `Offline`, `Completed` based on actual events.

---

# 13. Acceptance scenarios (end-to-end)

**AC-01:** Fresh install, no credentials: splash → setup-only → successful connection → Office; no inaccessible main shell.

**AC-02:** The lead agent delegates backend to Provider A, frontend to Provider B, tests to Provider C concurrently; all show distinct model/agent identity and report to one mission.

**AC-03:** Two coding workers edit separate Git worktrees; integration review detects conflict before merge.

**AC-04:** Restart daemon during a non-idempotent tool call; task enters recovery/unknown, no blind duplicate execution.

**AC-05:** Attach an external Codex session read-only; display messages/activity only if adapter supports; no unauthorized stop/control.

**AC-06:** An external session goes silent; UI marks stale/unknown rather than fabricated idle.

**AC-07:** Agent requests production deployment; action-specific approval with exact scope; changing action invalidates approval.

**AC-08:** Budget exhausted; scheduler queues/pauses new tasks, preserves running-state integrity, reports to the lead agent.

**AC-09:** Skill candidate generated from verified outcomes; user rejects; skill not active.

**AC-10:** One profile's experience does not leak to another profile or global skills without explicit approved export.

**AC-11:** Office at night preserves warm lighting and meets benchmark target on stated hardware; hidden Office consumes no animation frames.

**AC-12:** Office-only floor/light controls, no page scroll, readable Liquid Glass gutters, semantic bubbles, avatar popover, agent modal with board restore.

**AC-13:** Receptionist/bartender remain facility NPCs and do not take agent coding workstations; spawn queue prevents mass mount spikes.

**AC-14:** Mission replay reconstructs recorded events only; missing segments marked unknown.

**AC-15:** Offline launch can view stored history and skills; cloud model calls show offline state without losing queue.

---

# 14. Delivery roadmap and dependencies

| Stage | Deliverable | Exit gate |
|---|---|---|
| 0. Baseline | audit current repo, tests, perf, API contracts | source/UX/runtime gaps documented |
| 1. Core contracts | schemas, events, agent registry, capability model | typed contract tests pass |
| 2. Native MVP | one lead, ≥3 parallel heterogeneous subagents, tool runner | real multi-provider mission passes |
| 3. Durable control | SQLite journal, scheduler, leases, budget, approvals | crash/restart and security tests pass |
| 4. Observe | read-only adapters + freshness semantics | external session truthful/permissioned |
| 5. Mission UX | Mission Control, chat, modal, Office event projection | end-to-end workflow understandable |
| 6. Workspace isolation | Git worktrees, integration queue, artifact evidence | no overwrite/conflict escape |
| 7. Evolve | experience, Obsidian, memory, skill candidate/review | no unapproved privileged skills |
| 8. Automation | triggers, replay, cost insights | long-running headless reliability |
| 9. Ecosystem | SDK, docs, packaging, security hardening | cross-platform release gates |

**Priority correction:** For an actually useful Hermes competitor, Stage 2/3/6 are more critical than polishing 3D, marketplace or Python ML.

## 14.1 Rust adoption gate
Start with typed core contracts. If Rust core is adopted, migrate ownership of scheduler/event store/process supervision behind stable IPC. Keep UI unaffected. Benchmark startup, memory, binary size, reliability and cross-platform packaging. Do not require a full rewrite.

## 14.2 Python adoption gate
Introduce Python only after concrete learning/retrieval workloads exceed a simpler TypeScript/SQLite implementation. Worker remains optional, capability-advertised and resource-limited.

---

# 15. Definition of done for first competitive release

- Standalone Extalia lead agent works with at least two real provider implementations.
- Heterogeneous-model subagents execute concurrently and return verifiable artifacts.
- Durable missions survive restart safely.
- Budget/permissions/approvals enforce policy, including cancellation.
- One external engine can be observed read-only with truthful freshness semantics.
- One clean mission UI + 3D projection share the same event truth.
- Local-first installation works on at least one desktop OS, with cross-platform roadmap and reproducible packaging.
- Skills can be created/imported/reviewed; no unsafe auto-activation.
- Documentation and benchmarks are reproducible.
- No dependency on Hermes for native orchestration.

---

# 16. Remaining implementation ADRs

1. Retain Electron vs measured Tauri migration (default: retain Electron).
2. Rust now vs transitional TS kernel (default: contracts first, phased Rust).
3. Which two provider adapters ship in MVP (must verify real credentials/SDK behavior).
4. Observed engine integration permissions and exact supported versions.
5. User-controlled data retention and encryption model.
6. Target hardware for 40 FPS acceptance.
7. Exact local API authentication/IPC transport by OS.
8. Skill compatibility manifest format and trust levels.
9. Whether external sessions can ever be adopted into supervised missions (default: explicit user action only).
10. Which workflow triggers ship before v1 stable.

**End of v1.0 baseline.**

---
# 17. v1.1 locked decisions and scope

**Approved:** Hybrid Skill Activation; isolated vault per profile (work/personal/client) and explicit opt-in shared vault; Obsidian optional; Markdown + wikilinks portable; SQLite indexed graph; NVIDIA SkillSpector mandatory pre-activation; fast category-first routing; resource-intensive scanners/learning on demand; knowledge and experiences distinct from executable skills. **These decisions supersede any conflicting v1.0 optional activation or shared-vault language.**

**Trust invariant:** externally sourced material (user skill, repository, Obsidian note, observed agent output, imported session) is untrusted data until verified; passing a scanner never confers tool permissions or proves correctness. Any skill mutation invalidates prior attestation. No agent can grant itself permissions or approve its own high-risk change.

## FR-15 Category-based skill routing — P0
- Resolve request intent to one or more hierarchical category IDs using deterministic alias/keyword/project-stack lookup in SQLite; multiple categories per skill, categories have stable IDs, localized labels and aliases.
- Filter candidates by ACTIVE status, verified hash/attestation, profile/workspace ACL, capability grants, runtime compatibility, conflicts and dependency closure **before** ranking.
- Select top bounded candidates; load full SKILL.md content only for selected skills. For ambiguous requests, use workspace signals then optional semantic fallback, not a full skill-file scan.
- Split multi-domain missions into scoped tasks; resolve skills independently for each subagent. Return `no_safe_skill` when no eligible candidate; never bypass the gate.
- Track selection rationale, index generation, decision latency, false-positive/false-negative feedback. Hot reload atomic indexes, invalidate cache by manifest/policy/profile generation.

## FR-16 Mandatory SkillSpector inspection — P0
- Quarantine all newly imported/generated/modified skills and supporting files. Scan the **immutable staged package** using NVIDIA SkillSpector adapter, record exact command, tool version, policy version, scan coverage, report, SHA-256 content tree and exit status. Confirm supported CLI flags against the pinned upstream version during integration; do not hardcode speculative flags.
- A complete scan with no blocking findings is **necessary, never sufficient**. Also run manifest/schema validation, permission diff, dependency/source integrity checks, compatibility checks and functional tests. Optional deeper semantic inspection for ambiguity/high exposure.
- Fail closed on missing scanner, timeout, incomplete report, parsing error, stale attestation, hash mismatch, or high/critical finding. Medium findings go to human review. Low findings may proceed only under explicit policy. A human cannot silently bypass an unscanned/incomplete package; exceptions require separately audited administrator break-glass policy and remain disabled by default.
- Enforce permissions at tool-executor boundary, not in prompt text; deny by default for shell, network, secrets, workspace writes and destructive actions. Re-scan after changed bytes or materially changed scanner/policy rules.
- Run scanner in resource-limited worker, without credentials and without network unless explicitly needed and authorized; store redacted reports.

## FR-17 Obsidian wikilinks and knowledge graph — P0 foundation / P1 UI
- Markdown vaults use native `[[Note]]`, `[[folder/Note|alias]]` and stable frontmatter IDs; maintain link resolution for rename, aliases, broken links and duplicate titles. Standard Obsidian Global/Local Graph must render note-to-note links without Extalia plugin.
- Maintain SQLite `knowledge_nodes`/`knowledge_edges` as rebuildable index of Markdown and verified events. Typed relations (learned_from, depends_on, used_by, supersedes) live in metadata; wikilinks provide Obsidian compatibility. Graph queries always ACL-filter nodes **and edges**.
- Per-profile vault by default; opt-in shared vault contains only explicitly published/sanitized knowledge, never automatically federated private notes. Vault file paths are sandboxed and canonicalized.
- Extalia graph view is lazy-loaded and renders bounded subgraphs, not entire vault by default. No Obsidian process or plugin is required for core features.

## FR-18 Hybrid autonomous learning and activation — P0 policy / P1 engine
- L1: automatically capture bounded, redacted, attributable experiences; L2: auto-update Extalia-managed notes in authorized scope after verification; L3: propose skills/changes and require inspection + evaluation.
- Low-risk **declarative, non-executing** skills may auto-activate after complete inspection, compatibility checks, functional evaluation and preapproved permissions. Skills with shell/network/write/secrets/new permissions, policy changes or uncertain classification require explicit human approval. Approval is action-, hash-, workspace- and version-bound and expires after mutation.
- Self-generated skills receive no trust advantage. Never allow auto-modification of security policy, tool grants, scanner config or approval workflow.
- Learn from observed agents only to the degree events/evidence are actually available; observed logs are untrusted and never evidence of a verified success by themselves.

## FR-19 Agent capability registry — P0
- Register agents' task categories, available tools, model/provider support, concurrency, permissions, current health and provenance. Capability is distinct from skill knowledge. Dispatch by fit, cost, quota, availability and policy; don't infer tools from model name.

## FR-20 Memory hierarchy and provenance — P0
- Working memory: ephemeral task context; episodic: event-sourced task outcomes in SQLite; semantic: verified scoped Markdown knowledge; procedural: versioned approved skills.
- Each claim links to source evidence, observation time, validation method, owner/profile, confidence basis, revision and trust status. AI-generated summaries are not equivalent to independently verified outcomes. Conflicts create review records, not silent overwrites.

## FR-21 Skill dependency and compatibility resolver — P0
- Declare framework/runtime constraints, dependencies, conflicts, minimum permissions and version range; resolve deterministic dependency closure before activation. Detect cycles, missing packages, incompatible constraints, privilege escalation via transitive dependencies; pin approved versions.

## FR-22 Learning sandbox and evaluation — P1
- Evaluate executable or behavior-changing candidates in isolated disposable worktrees/containers with denied secrets/network by default, explicit resource limits and recorded filesystem/network side effects. If robust isolation is unavailable, mark evaluation unavailable and do not auto-activate.
- Compare to baseline with reproducible test suite, representative cases, regression checks and sample-size caveats. No fabricated improvement metrics. Record test artifacts and human review.

## FR-23 Knowledge revalidation and sync — P1
- Bidirectional filesystem sync with debounce, atomic writes, revision/hash preconditions, conflict copies, journaling and rollback. Do not overwrite user-managed notes automatically; no auto-delete. Markdown edits from Obsidian are untrusted inputs and cannot activate skills.
- Trigger revalidation on dependency/version change, contradictory evidence, expired source, policy update or explicit request; do not rescan entire vault continuously.

## FR-24 Learning transparency and performance intelligence — P1
- Evolve dashboard: candidate lifecycle, scan report, approval, evidence, provenance, wikilinks, graph, versions, rollback, blocked reasons and scoped audit trail.
- Track verified task success, selection precision, regression rate, human corrections, latency and cost per verified task, segmented by difficulty/workspace/provider; do not rank agents/models from incomparable tasks or small samples.

# 18. v1.1 end-to-end acceptance gates

| ID | Given / When / Then |
|---|---|
| AC-16 | New user-imported skill → quarantined, not visible in active router; scanner unavailable → remains quarantined. |
| AC-17 | Complete clean scan but executable permission expansion → human approval required; denial prevents tool access. |
| AC-18 | Approved skill bytes or dependency changes → previous attestation invalid; no routing until reinspection. |
| AC-19 | Request spans Laravel and authorization → category resolver produces bounded scoped selections; unapproved skill never selected. |
| AC-20 | Skill requires PHP >=8.2 in PHP 7.3 workspace → excluded with clear compatibility reason. |
| AC-21 | Agent produces candidate from successful task → evidence captured; candidate cannot self-approve. |
| AC-22 | Obsidian app absent → Markdown, wikilinks, graph indexing and native orchestration still work. |
| AC-23 | Note renamed via Obsidian → links/index reconciled without silent content loss; ambiguous links surfaced. |
| AC-24 | Knowledge of profile A linked from profile B → ACL denies both node content and edge disclosure; shared knowledge only via explicit publication. |
| AC-25 | Concurrent Extalia/Obsidian edits → conflict retained for resolution, neither version silently discarded. |
| AC-26 | SkillSpector timeout/incomplete report → fail closed, audit reason and no approval shortcut. |
| AC-27 | Headless idle runtime → no persistent scanner, embedding worker, Python learning worker or 3D rendering. |
| AC-28 | Skill upgrade fails regression evaluation → previous approved version remains active; rollback audited. |
| AC-29 | Observed external agent claims success without verifiable artifacts → remains unverified; no auto-learning promotion. |
| AC-30 | Vault file contains prompt-injection instructions → treated as data, never changes agent permissions or policies. |

# 19. v1.1 implementation sequence (dependencies are mandatory)

**Gate 0 — Audit existing repository:** inspect actual TS/Electron services, SQLite migrations, adapters, rendering performance, installed Python/Rust toolchains; avoid speculative rewrites.

**Gate 1 — Contracts and policy:** canonical IDs/events; profile ACL; trust labels; manifest schema; approval semantics; immutable skill packages and hash; capability registry; migration plan. Tests: ACL and permission denial.

**Gate 2 — Secure registry:** quarantine; pinned SkillSpector adapter; report parsing; fail-closed gate; dependency/compatibility checks; category index and routing; audited activation and rollback. Tests AC-16–20, AC-26, AC-28.

**Gate 3 — Knowledge foundation:** per-profile vault, optional shared publication, Markdown frontmatter, wikilinks, SQLite graph index, incremental watcher, conflicts and provenance. Tests AC-22–25, AC-30.

**Gate 4 — Evolve:** experience evidence capture, L1/L2 updates, candidate generation, sandbox/evaluation, hybrid auto-activation, metrics and Learning Center. Tests AC-21, AC-29 and representative regressions.

**Gate 5 — Hardening:** stress/resource budgets, startup/idle, crash recovery, 3D headless isolation, security review, release documentation. All ACs pass with recorded evidence.

**Not implementation claims:** this PRD defines future work. No source code, scanner installation, vault creation, or production policy enforcement is implied.
