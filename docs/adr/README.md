# Architecture decision records

Important, hard-to-reverse choices are recorded here (PRD §42). Copy the format
of an existing record, number it sequentially and link it from the table.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-clean-public-repository.md) | Clean public repository with selective migration | Accepted |
| [0002](0002-desktop-shell-electron.md) | Electron for the Desktop shell | Accepted (packaging decided in 0006) |
| [0003](0003-source-first-workspace-packages.md) | Workspace packages export TypeScript source | Accepted |
| [0004](0004-managed-and-observed-sessions.md) | Managed and observed sessions share one protocol | Accepted |
| [0005](0005-extalia-native-runtime.md) | Extalia Native runtime for API-only connections; memory and skills have one owner | Accepted |
| [0006](0006-updates-and-packaging.md) | Desktop auto-update with electron-builder; npm updates for the Web client | Accepted |

| [0007](0007-native-orchestration-contracts.md) | Additive native orchestration wire contracts; retain current runtime and event protocol | Accepted |

| [0008](0008-in-memory-native-mission-supervisor.md) | In-memory native mission supervisor before host integration | Accepted |

| [0009](0009-native-missions-in-session-host.md) | Native missions through the existing session host | Accepted |

| [0010](0010-lead-mission-planning.md) | Accountable lead mission planning (proposal only, read-only, deterministic fallback) | Accepted |

| [0011](0011-mission-ui.md) | Mission launch, plan review and monitoring UI (task-state progress, answers unverified) | Accepted |

| [0012](0012-mission-planning-admission-and-retained-graphs.md) | Shared planner admission and retained mission dependency graphs | Accepted |

| [0013](0013-transactional-mission-checkpoints.md) | SQLite WAL mission checkpoint transactions and one-time sidecar import | Accepted |

| [0014](0014-atomic-native-mission-events.md) | Atomic native control events and fail-closed execution acknowledgement | Accepted |

| [0015](0015-mission-budgets-and-usage.md) | Mission runtime budgets (duration, tokens, concurrency) and honest provider-reported usage | Accepted |

| [0016](0016-office-mission-projection.md) | Office projection of native mission workers (queued/running/ended/unknown, spawn-queue admission) | Accepted |

| [0018](0018-observed-approval-bridge.md) | Observed approval bridge: opt-in per adapter, long-poll decisions, never auto-allow, no decision on failure (research for Claude Code, Codex, Hermes, Antigravity/Gemini) | Proposed |

| [0019](0019-sqlite-driver-and-database-ownership.md) | SQLite driver and database ownership for the Rust core (rusqlite bundled, one writer per file, separate core database, crate-local migrations) | Accepted |

| [0020](0020-daemon-ipc-transport.md) | Daemon IPC transport and process model (sidecar over stdio now, service deferred to W8, renderer and browser never reach the daemon) | Accepted |

| [0021](0021-rust-integration-strategy.md) | Rust integration strategy (strangler behind AgentHostApi, extalia-core + extalia-daemon, pinned toolchain, schemas from @extalia/protocol, benchmark gate) | Accepted |

| [0022](0022-python-worker-distribution.md) | Python worker distribution and NDJSON stdio protocol v1 (bundled in self-contained installers, built with uv in CI, never required for chat or orchestration) | Accepted |

| [0023](0023-skill-scanner-adapter-pinning.md) | Skill scanner adapter pinning (scanner facts unverified, pinned version and hash, evidence-derived schema, fail closed when absent) | Accepted |

| [0024](0024-profiles-acl-and-vault-roots.md) | Profiles, ACL and vault roots (profile as security boundary, one profile per workspace, ACL on nodes and edges, default vault under the data directory with optional validated folder, publish-only shared vault, memory note import) | Accepted |

| [0025](0025-skill-manifest-and-immutable-revisions.md) | Skill manifest and immutable revisions (JSON sidecar manifest, tree SHA-256 revisions, one unified lifecycle, attestation binding, TOCTOU hash points, skill tables in the core database) | Accepted |

| [0026](0026-permission-enforcement-point.md) | Permission enforcement point (tool execution boundary in the core, declared permissions as ceiling not grant, deny when the daemon is unavailable, no self-approval, digest-bound expiring approvals, UI displays only) | Accepted |

| [0027](0027-evidence-and-provenance-model.md) | Evidence and provenance model (append-only evidence records, confidence basis instead of scores, observed output always untrusted, `insufficient_evidence` rules, redaction before export) | Accepted |

| [0028](0028-workspace-isolation-for-write-capable-workers.md) | Workspace isolation for write-capable workers (one Git worktree per worker under the data folder, pinned base, serial integration queue with test gate and digest-bound user approval, fast-forward/compare-and-swap only, orphans reported never auto-deleted, non-Git workspaces refused) | Proposed |

| [0029](0029-learning-loop-experiences-evidence-candidates.md) | Learning loop: experiences, evidence and candidates (L1 capture from finished native missions only, masked and bounded; kind-fixed evidence trust, observed claims always untrusted; `insufficient_evidence` below 2 verified successes; user-only digest-bound decisions; L2 via managed-note CAS writes, L3 only staged into the skill import inbox for the W3 flow) | Proposed |

| [0030](0030-authoritative-mission-recovery-inspection.md) | Read-only Rust mission recovery snapshots and explicitly owned host projection refresh, without replay or clearing genuine execution uncertainty | Accepted; inspection slice delivered v0.4.109 |

| [0031](0031-native-lease-heartbeat-and-fencing.md) | Independent native lease renewal, exact holder/lease checks and fail-closed runtime authority loss | Accepted; gate 3.3B delivered locally v0.4.118 |

| [0032](0032-periodic-native-lease-reaping.md) | Periodic profile-scoped lease reaping and canonical uncertainty quarantine independent of stdin activity | Accepted; gate 3.3C delivered locally v0.4.119 |

| [0033](0033-durable-execution-observations.md) | Immutable execution admission identities and bounded turn-promise settlement observations without clearing uncertainty | Accepted; gate 3.3D1 delivered locally v0.4.120 |

| [0035](0035-atomic-canonical-recovery-review.md) | One pinned canonical recovery view with profile-bound review digest and explicit missing task admissions | Accepted; gate 3.3D3 prerequisite delivered locally v0.4.122 |
| [0034](0034-tracked-local-operation-drain.md) | Sealed tracked local operations and known owned-child exit, with separate scoped durable evidence | Accepted; gate 3.3D2 delivered locally v0.4.121 |

| [0036](0036-prd-v2-compatible-adoption.md) | Compatible PRD v2 adoption: additive control namespace, scoped capability claims, explicit authority/revisions and retained acceptance gates | Accepted for additive contracts; runtime activation gated |
| [0037](0037-provisional-delegation-reservations.md) | Scoped provisional delegation escrow, atomic CAS/receipt persistence, conservative clock and immutable history | Accepted for storage prerequisite; no dispatch authority or runtime activation |
| [0038](0038-admission-bound-native-action-intents.md) | Native edit-intent lifecycle bound to actual execution admissions and leases, with irreversible expiry/withdrawal | Accepted for non-executable storage; positive approval and effect gates remain open |
| [0039](0039-read-only-skill-dependency-preflight.md) | Exact-pin dependency/compatibility diagnostics over a bounded read-only profile snapshot | Accepted for diagnostics only; activation and scanner gates remain open |
| [0040](0040-eligibility-first-skill-routing-preview.md) | Eligibility-first category/intent routing over exact active revisions and workspace approval applicability | Accepted for read-only core preview; runtime selection remains open |
| [0041](0041-probe-only-worker-protocol.md) | Bounded probe-only worker NDJSON contract and pure Rust exchange retirement | Accepted for protocol tests; production launcher, Python bundle and scanner remain open |
| [0042](0042-owned-health-probe-supervision.md) | Rust ownership, bounded pipes and watchdogs for direct-child health probes | Accepted for library/test fixtures; no production scanner, sandbox or descendant settlement |
| [0043](0043-worker-bundle-artifact-observation.md) | Independent manifest pin, portable exact inventory and bounded content observation | Accepted for staging observations; no executable authority, actual bundle or Windows certification |
| [0044](0044-relocated-developer-python-bundle.md) | Pinned USTAR staging, preserved licenses and relocated native CPython health experiment | Accepted for explicit developer testing; no production Python/scanner or platform certification |
| [0045](0045-progressive-workspace-memory.md) | Bounded workspace recall and independently maintained memory-recall/Caveman guidance | Accepted for Native Chat/Teams; no automatic capture, upstream installation or learning promotion |
| [0046](0046-original-planned-task-membership.md) | Original planned tasks captured with mission creation and checked on admission/recovery | Implemented locally v0.4.152; no complete executor/child ownership or closure authority |
| [0047](0047-durable-native-planning-lifetime.md) | Durable pre-effect automatic-planning lifetime, weak observations and host recovery guards | Verified locally v0.4.153; no executable authority, mission closure or remote/child settlement |
| [0048](0048-skill-routing-application-preview.md) | Exact-revision skill routing diagnostics through the daemon, host and Skills UI | Verified locally v0.4.154; no runtime selection, activation or permission grant |
| [0049](0049-mandatory-external-skill-ingress.md) | Mandatory scanner-gated external catalogs and reads, canonical built-ins and review-only legacy input | Verified locally v0.4.155; production scanner remains unavailable and generic documents are not automatically scanned |
| [0050](0050-explicit-prompt-skill-candidates.md) | Explicit per-message learning creates generated library candidates with mandatory inspection | Verified locally v0.4.156; no approval/activation or production scanner claim |

Open questions from PRD §44 (local database, Web ↔ Bridge transport and
authentication, plugin sandboxing, skill format, registry trust, event sourcing,
Obsidian write policy, license/trademark, DCO vs CLA) each get an ADR before
implementation.

