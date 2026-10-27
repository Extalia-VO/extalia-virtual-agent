# Extalia technical implementation blueprint (PRD patch v1.1.1)

**Status:** proposed implementation contract, subject to repository audit. **Applies to:** Master PRD v1.1, FR-01–FR-24. **Scope:** architecture, frameworks, file ownership, implementation order and extensibility. **This is not an implementation, nor a verified description of the current source tree.** How it maps onto the repository: [gap map §5](../prd-v1.1-gap-map.md#5-patch-v111-technical-implementation).

## 1. Locked principles

1. **Extend, do not rewrite.** Keep React + TypeScript + R3F, Electron and the packages that already work. Do not migrate to Tauri or split every module into crates before there is evidence of need.
2. **Rust is the control plane** for scheduling, lifecycle, policy, approvals, durable event/task state and process supervision. **Python is an on-demand worker** for the scanner, embeddings, pattern analysis and evaluation that genuinely need the Python ecosystem. **LLM provider calls do not have to go through Python.**
3. **Hexagonal architecture (ports/adapters) + modular monolith** as the structural standard; *pragmatic* DDD at domain boundaries. No microservices for a local-first application.
4. **Contract-first:** versioned schemas, contract tests and compatible adapters before an implementation migrates. No duplicated domain models without code generation or compatibility checks.
5. **Event-driven but not dogmatic event sourcing:** SQLite stores transactional state plus an append-only audit/event log; replay only claims activity that was actually recorded.
6. **Fail closed for security:** a new or changed skill must not become active when inspection fails, is incomplete or stale, or policy is not met. A scanner does not replace sandboxing and permission checks.
7. **Extendable by design:** providers, agent runtimes, tools, skill sources, inspectors, knowledge backends and UI features use interfaces/registries; built-in defaults stay simple, an extension SDK follows once contracts are stable.
8. **No 75:25 Rust:Python ratio as a KPI.** Judge the actual split by resource benchmarks, latency, maintainability and reliability.

## 2. Recommended frameworks, libraries and standards

| Area | Recommendation | Reason / limit |
|---|---|---|
| Rust async | Tokio | Async IO, task cancellation, process management; not every function needs to be async |
| Rust HTTP/local API | Axum (optional if an existing transport is absent) | Typed local API; IPC over Unix socket/named pipe or authenticated loopback |
| Rust serialization | Serde + serde_json | JSON contracts and worker messages |
| Rust errors | thiserror in the domain, anyhow at application boundaries | Typed errors, clear diagnostics |
| Rust SQLite | SQLx + SQLite WAL (or rusqlite if a synchronous workload fits better) | One owner of migrations/transactions; **choose one** after the audit |
| Rust observability | tracing + tracing-subscriber | Correlation ids, spans, structured logs |
| Rust testing | cargo test + integration tests; cargo clippy/fmt | Quality gate |
| Python packaging | pyproject.toml + uv or locked pip | Reproducible worker environment; never require a global Python |
| Python validation | Pydantic v2 where needed, or typed dataclasses | Validate input/output at the trust boundary |
| Python tests | pytest + Ruff | Worker correctness, formatting/lint |
| TypeScript contracts | JSON Schema + generated TS/Rust/Python bindings where the toolchain fits | Single source of truth, schema compatibility tests |
| Frontend | React + TypeScript + the existing UI stack | No rewrite to a new framework |
| Desktop | Existing Electron + secure preload/context isolation | Never expose raw Node APIs to the renderer |
| Skills | SKILL.md + Extalia metadata manifest, SQLite category index | Portable Markdown; mapping and security live in the registry |
| Knowledge | Markdown + Obsidian wikilinks, SQLite FTS5/edges | Vault works without Obsidian; embeddings optional |
| CI | GitHub Actions or the existing CI: lint/test/security/package smoke tests | Cross-platform macOS/Windows/Linux |

**Engineering standards:** Rust API Guidelines; Rust 2024 edition only if the project toolchain is compatible; SemVer for public packages/protocol; optional Conventional Commits; ADRs for architecture decisions; OpenAPI 3.1 for an HTTP API (if used); JSON Schema for messages; least privilege; secure by default; reproducible builds; SBOM for releases; an explicit per-OS support matrix. Verify every choice against the project's dependencies and actual build compatibility.

## 3. Target directory structure (adapt after the audit)

```text
extalia/
├── apps/
│   ├── web/src/features/{office,mission-control,agents,skills,knowledge,learning}/
│   └── desktop/                       # keep the actual Electron structure
├── packages/
│   ├── contracts/                     # schemas + generated bindings + fixtures
│   └── sdk/                           # public extension interfaces, later stage
├── crates/
│   ├── extalia-daemon/                # main.rs, startup, IPC, lifecycle
│   └── extalia-core/                  # modular monolith, NOT every crate from the start
│       └── src/
│           ├── lib.rs
│           ├── domain/{task,agent,skill,knowledge,approval,event}.rs
│           ├── application/{dispatch,skill_activation,learning_jobs}.rs
│           ├── ports/{provider,tool,inspector,knowledge_store,event_store}.rs
│           ├── adapters/{sqlite,providers,process,python_worker,markdown}.rs
│           ├── orchestrator/{scheduler,supervisor,router}.rs
│           ├── skills/{registry,categories,compatibility,policy}.rs
│           ├── knowledge/{vault,wikilinks,graph,sync}.rs
│           ├── security/{permissions,approvals,attestation}.rs
│           └── telemetry/mod.rs
├── workers/intelligence/
│   ├── pyproject.toml
│   ├── extalia_intelligence/
│   │   ├── __main__.py
│   │   ├── protocol/{schemas,dispatch}.py
│   │   ├── scanner/{skillspector_adapter,report_normalizer}.py
│   │   ├── embeddings/{generate,batch}.py
│   │   ├── learning/{experience,patterns,candidates}.py
│   │   └── evaluation/{benchmarks,regression}.py
│   └── tests/
├── migrations/                         # or crates/extalia-core/migrations, pick one
├── tests/{contracts,integration,security,performance,fixtures}/
└── docs/{adr,architecture,implementation,operations}/
```

**Rule:** do not create empty directories just to match the diagram. Start with `extalia-core`, `extalia-daemon`, `packages/contracts` and one minimal worker. Split crates when the dependency graph, build times, ownership or reuse justify it. Record every file-location change in the audit.

## 4. Dependency direction and domain boundaries

```text
UI (React/Electron) --> versioned local API/IPC --> Application services
                                                 |       |
                                                 v       v
                                               Domain <- Ports (traits)
                                                           ^
                                                           |
                                              Adapters: SQLite/LLM/CLI/Python/Markdown
```

- `domain` must not import Axum, SQLx, Electron or Python.
- `application` depends on domain + ports; adapters implement ports.
- `security` is a mandatory guard on sensitive operations; the frontend only displays decisions and is never the permission authority.
- Observed external agents are read-only by default; control only when the adapter declares a verified capability and the user allows it.
- A profile/workspace is a security boundary for queries, indexes, events, memory, vaults and caches.

## 5. Core contracts to write before feature code

**Canonical ids:** `workspace_id`, `profile_id`, `mission_id`, `task_id`, `agent_id`, `event_id`, `skill_id`, `skill_version_id`, `job_id`, `correlation_id`.

**Example domain interfaces (Rust pseudocode):**

```rust
#[async_trait::async_trait]
pub trait ModelProvider: Send + Sync {
    async fn generate(&self, request: ModelRequest) -> Result<ModelResponse, ProviderError>;
}

#[async_trait::async_trait]
pub trait SkillInspector: Send + Sync {
    async fn inspect(&self, package: QuarantinedPackage) -> Result<InspectionReport, InspectError>;
}

pub trait SkillPolicy {
    fn evaluate(&self, skill: &SkillVersion, report: &InspectionReport,
                scope: &WorkspaceScope) -> PolicyDecision;
}
```

`async_trait` is an ergonomic option; native async traits may be used where object safety and the design allow. Do not copy this pseudocode blindly without compiling and testing it.

**Required event envelope:** `schema_version`, `event_id`, `correlation_id`, `workspace_id`, `profile_id`, `origin(native|observed)`, `source`, `observed_at`, `occurred_at?`, `confidence`, `payload`, `sequence?`. Idempotent ingestion, monotonic sequencing per stream where available, unknown/stale when events are missing.

**Worker protocol v1:** newline-delimited JSON over stdio (or length-prefixed framing for large payloads); request_id, operation, deadline, schema_version, result/error; bounded stdout/stderr; cancellation; process exit code; startup handshake; schema validation. Worker logs go to stderr only. Never accept arbitrary commands from a model. File paths must be inside an allowed workspace staging area.

```json
{"schema_version":1,"request_id":"r-1","operation":"skill.inspect","deadline_ms":30000,"payload":{"package_id":"pkg-1","sha256":"..."}}
```

**API versioning:** `/api/v1/*` for HTTP; typed IPC messages on desktop. Every breaking change needs a schema migration and compatibility tests. Do not lock in gRPC as an early dependency.

## 6. Database schema and ownership

**Operational SQLite (WAL, foreign keys ON):** `profiles`, `workspaces`, `missions`, `tasks`, `task_dependencies`, `task_attempts`, `agents`, `agent_capabilities`, `agent_events`, `approvals`, `provider_usage`, `worker_jobs`.

**Skills:** `skills`, `skill_versions`, `skill_categories`, `skill_category_edges`, `skill_category_mappings`, `skill_intents`, `skill_inspections`, `skill_permissions`, `skill_approvals`, `skill_activation_history`.

**Knowledge:** `knowledge_documents`, `knowledge_revisions`, `knowledge_nodes`, `knowledge_edges`, `knowledge_provenance`, `learning_experiences`, `learning_candidates`, `learning_evaluations`; optional FTS5 indexes, rebuildable from Markdown where appropriate.

**Migration rules:** ordered, reversible where feasible, backup before destructive migrations, never auto-delete user Markdown, tested against upgrade fixtures, transactions and constraints for activation and task-state changes. Secrets in the OS keychain, never plaintext SQLite. Persist hash + policy version + scanner version for inspection attestations.

## 7. Security: skill activation state machine

```text
IMPORTED -> QUARANTINED -> INSPECTING -> INSPECTED -> EVALUATING
                                    \-> BLOCKED / REVIEW_REQUIRED
EVALUATING -> AWAITING_APPROVAL (if required) -> ACTIVE -> SUPERSEDED/REVOKED
```

- Skills imported from the user, GitHub, an external agent, generation or Obsidian all pass through quarantine. There is no special path for a trusted agent.
- The scanner runs through a pinned, tested adapter; validate output against the installed version. **Do not assume CLI flags or a JSON schema without checking the official version in use.**
- Fail closed on scan error/incomplete scan, stale hash, revoked attestation or policy mismatch. A passing scan does not by itself allow privileged tools.
- Hybrid activation: automatic only when *low risk*, the policy scope allows it, evaluation passes, permissions do not increase and the approval policy permits; elevated permissions and sensitive capabilities need explicit approval.
- TOCTOU protection: hash the package before the scan, after the scan, and immediately before activation/execution; immutable version artifact.
- Running untrusted code requires sandboxing: OS-specific limits on filesystem, network, secrets, CPU/time/memory. Containers are not always available; document the fallback and fail closed when isolation cannot be enforced.
- Never let the scanner, the Python worker or a model write directly to `skill_approvals` or the `ACTIVE` state.

## 8. Category routing, compatibility, knowledge, learning

**Routing:** normalize intent → workspace/project context → category index → candidate retrieval → compatibility/dependencies/conflicts → active + attested + permission filter → ranking → the selected SKILL.md is loaded only at execution. Cache scoped by workspace/profile/policy/index revision; invalidate on change. Semantic fallback only when ambiguity is measured.

**Obsidian:** vault per profile; shared vault opt-in; Markdown is the document content, SQLite a derived index; the wikilink parser supports aliases and relative paths, disambiguation, rename/edge updates, orphan links and cycles; incremental watcher + debounce + atomic writes + conflict preservation. Obsidian text is never treated as a privileged command. Native Obsidian Graph View compatibility and an Extalia graph UI are an optional later stage.

**Learning:** verified task outcomes → sanitized experiences → candidate knowledge/skill → provenance + evaluation → security gate → controlled promotion → measurable feedback. No self-approval, no silent cross-profile leakage, no self-modification of core policy. Record baseline vs candidate and roll back on regression. Knowledge may auto-update only Extalia-managed scoped notes.

## 9. Implementation order by files and results

| Phase | First files/directories touched | Deliverable and exit gate |
|---|---|---|
| **0 Audit** | `docs/implementation/REPO_AUDIT.md`, ADRs | Inventory of packages, processes, data, current skills, OS packaging; list of files to preserve/modify/create; **no runtime changes** |
| **1 Contracts** | `packages/contracts/schemas/*.json`, `tests/contracts/*`, web client | Versioned schema + fixtures + compatibility tests; existing UI still works |
| **2 Minimal Rust kernel** | `crates/extalia-core/src/{domain,ports,application}`, `crates/extalia-daemon/src/main.rs`, `migrations/001_*.sql` | One native task, durable event, restart recovery, permissions enforced |
| **3 Multi-model + concurrency** | `orchestrator/{scheduler,router,supervisor}.rs`, `adapters/providers/*`, `tests/integration/*` | ≥3 concurrent subagents across ≥2 providers; cancellation, budgets, failure isolation |
| **4 Secure skills** | `skills/{registry,categories,compatibility,policy}.rs`, `security/*`, `workers/intelligence/.../scanner/*` | Quarantine/inspection/approval/attestation/TOCTOU tests; no uninspected execution |
| **5 Obsidian/graph** | `knowledge/{vault,wikilinks,graph,sync}.rs`, knowledge migrations | Profile vault isolation, graph edges, atomic sync, conflict tests, Obsidian not required |
| **6 Learning** | Python `learning/*`, `evaluation/*`, Rust `application/learning_jobs.rs` | Candidate generated from verified evidence; baseline evaluation; gated promotion |
| **7 UX/observe** | Existing web features, external adapters, event streaming | Mission Control + Skill Security Center + Knowledge Graph; truthful status, no fake progress |
| **8 Hardening/release** | `tests/security/*`, `tests/performance/*`, CI workflows, packaging | macOS/Windows/Linux smoke tests, headless benchmarks, upgrade/rollback, documented limitations |

Phases may be split into small pull requests. Do not start the next phase while a safety-critical exit gate fails. Re-run the audit after every significant repository change.

## 10. Example first coding slices (acceptance driven)

**Slice A — one durable task:** create a mission via the API; one SQLite transaction writes task + event; reload after a process restart; the UI shows real state. Tests: duplicate event, crash before commit, stale lease, cross-profile denial.

**Slice B — provider interface:** two mock providers first; then a real provider adapter with its secret from the OS keychain; per-provider concurrency and rate limits; cancellation; no Python dependency. Tests: provider timeout, 429/backoff, unknown billing metadata, partial output.

**Slice C — skill inspection:** import a harmless test SKILL.md; quarantine; invoke the scanner worker with a pinned version; normalize the report; require a policy decision; activate only the immutable matching hash. Tests: scanner absent, malformed JSON, high risk, package mutated mid-scan, no network permission.

**Slice D — vault:** create a note with wikilinks, index edges, rename the note, detect a conflict, restart sync. Tests: alias links, broken links, cross-profile edge denial, user edits not overwritten.

**Slice E — learning:** generate a candidate from verified fixtures, scan and evaluate, compare to baseline, queue approval where needed; roll back on a failed regression. Tests: unverifiable source, conflicting knowledge, low sample count, permission escalation.

## 11. CI and non-functional definition of done

- Typecheck, lint, Rust fmt/clippy/test, Python Ruff/pytest, contract/schema tests; critical security tests block merges.
- Cross-platform Electron packaging smoke test and daemon/worker start/stop test; handle a missing worker gracefully, except mandatory skill inspection.
- Benchmarks are **measured, never invented:** idle RSS/CPU, cold start, p50/p95 routing latency, 3+ agent concurrency, Python worker start/stop, event throughput, day/night Office FPS. Publish hardware, build SHA, OS and method.
- A release includes migration backup/restore, changelog, feature flags, permission matrix, security review, license/SBOM and developer setup instructions.
- Every coding-agent handoff lists inspected files, created/modified files, commands run, tests passed/failed, unverified assumptions and rollback steps.

## 12. Extensibility rules

**This blueprint is a baseline that can be developed much further**, not a feature ceiling. Prioritize stable contracts and versioned extension points:

- **New LLM provider:** implement `ModelProvider`; model metadata, costs, quota, streaming, capability detection.
- **New external agent:** implement an observe/control adapter with explicit capability flags; never pretend read-only observation grants control.
- **New skill source/scanner:** implement source/inspector adapters; the mandatory central policy stays in Rust.
- **New category taxonomy:** versioned category graph + aliases + migrations; existing skills reindex incrementally.
- **New knowledge backend:** Markdown vault by default; further connectors behind `KnowledgeStore` without breaking provenance/isolation.
- **New learning technique:** Python worker operation names + versioned schema; offline evaluation before production promotion.
- **New UI:** feature modules consume public typed events; they cannot bypass security APIs.
- **Enterprise later:** encrypted team sync, RBAC, audit export, remote daemon, distributed queue — **not prerequisites for a local-first MVP**.

**Change governance:** new requirement → impact analysis (security, schema, performance, compatibility) → ADR → schema revision → tests → migration → staged rollout. Keep backward compatibility or an explicit upgrade path. Avoid premature abstractions; introduce interfaces at proven variability points.

## 13. Not decided until the source audit

Exact package paths, existing database ownership, the current Electron IPC strategy, the current build and release pipeline, actual CLI/provider APIs, Python runtime bundling per OS, the pinned scanner version and CLI contract, and actual benchmark targets. Never claim these are verified; audit the source first, then record ADRs and revise the target tree.
