# Architecture overview

Extalia is a spatial agent workspace: users prompt, supervise and observe AI
agents through conventional views (Chat, Console, Tasks, Terminal, Files, Git,
Logs) and through a 3D office. Every view reads the same session state.

```text
Runtime / agent app
      ↓
Runtime adapter (managed) · Observer (transcript, hook, MCP)
      ↓
Extalia Protocol events (@extalia/protocol)
      ↓
Session, task and agent state (@extalia/core)
      ↓
Views: Chat · Console · Tasks · Terminal · Files · Git · Logs · Office
```

Two rules protect this structure (PRD §47):

- **The Office must keep working if any runtime disappears.** Renderer and UI
  code never import a runtime, provider or adapter; they consume protocol
  events and core state only.
- **Personal setups are configuration, not code.** Names, rosters, rooms and
  integrations are user data. Core never special-cases them.

## Repository layout

```text
apps/
  web/        React client; also the renderer UI loaded by Desktop
  desktop/    Electron shell: secure window, app protocol, preload bridge
  cli/        `extalia` command: local Bridge, updates, diagnostics and validation
packages/
  protocol/   Extalia Protocol v0: event types and validation (no dependencies)
  core/       Domain model: profiles, workspaces, session library, portable
              sessions, privacy rules
  platform/   Platform capability contracts and data-directory resolution
  runtime/    Extalia Native agent loop, delegation, provider adapters and the Hermes Agent stream mapping
  host/       Node host: files, commands, credentials, Hermes Agent processes, imports and selected transcript observation
  importers/  Pure native-history parsers
  office/     Pure spatial presence contracts; the shared Web/Desktop scene lives in apps/web/src/office
tooling/      Repository checks: boundaries, public safety, versions
docs/         Architecture, ADRs, migration ledger, release notes
```

More packages from the PRD's proposed monorepo (renderer, avatars,
adapters, knowledge, …) are added
when their phase starts, each with a boundary rule in
`tooling/check-boundaries.mjs`.

Setup, Settings, Chat and Office run in the same application shell. The Office
renderer is loaded on demand from the same web build served by the Bridge and
packaged by Desktop. It receives host session summaries and protocol events;
it never launches a separate agent host or connects directly to a provider.
The campus and furnished floors are adapted from the existing Virtual Office.
New visual improvements belong in this repository; see
[Office development](../design/office-development.md). Per-character
appearance is saved in the host and shared by Web and Desktop; avatar walking and
navigation remain later scene milestones.

Backend placement follows [ADR 0071](../adr/0071-rust-openai-completion-and-resource-evidence.md): choose Rust, supervised Python or TypeScript from measured resource/latency tradeoffs and output compatibility. Retain TypeScript where migration adds latency without worthwhile memory or responsiveness benefits; React stays presentation-only. This supersedes the mandatory zero-TypeScript destination in [ADR 0069](../adr/0069-ui-only-typescript-and-backend-ownership.md), while retaining its source ownership inventory. A pure parser or scheduler remains backend work even without Node imports. Earlier [ADR 0053](../adr/0053-evidence-based-native-process-partition.md) permission, parity and settlement gates still apply.

Workspace-bound [deferred learning](../adr/0074-deferred-learning-and-workspace-knowledge.md)
uses a bounded host admission timer and independent background settlement. Rust
retains curator execution and artifact ownership. Isolated workspaces bind a stable
vault profile, and scoped Knowledge requests reuse the daemon's dedicated index
thread with an eight-profile LRU. All default/scoped Knowledge requests share a host
admission lane so queue wait does not consume wire execution deadlines.

[Idle team knowledge](../adr/0075-idle-team-knowledge-and-office-context.md)
extends that same timer owner with real team discussions and acknowledged artifact
results. New foreground work fences maintenance and drains its entered effects;
the full chosen quiet interval restarts after actual foreground settlement.
Office portals the shared countdown above its prompt while keeping source-context
selection independent from the global character board and automatic camera.

The skill registry uses that same lazy profile daemon independently of mission
backend selection. [Pinned SkillSpector inspection](../adr/0068-pinned-skillspector-inspection.md)
runs in a separate bounded Rust-owned worker, with a bundled Python/scanner
manifest pinned into the daemon. Scanner evidence, user review, approval and
activation remain distinct; imported text never grants its own permissions.

[OpenAI-compatible model discovery](../adr/0070-rust-provider-model-discovery.md)
uses an isolated Rust mode for actual HTTP and catalog parsing, with child-close
settlement. [Completion measurements](../adr/0071-rust-openai-completion-and-resource-evidence.md)
retain TypeScript as the production default: neither native candidate provides an
overall workload efficiency improvement. Native completion modes are development
experiments excluded from ordinary release builds. A shared-worker candidate uses separately owned request
runtimes and positive owner-join receipts; IPC failure still retains affected
ownership until actual process close. Native orchestration/history, Anthropic
processing and privileged host services currently remain TypeScript.
The [resource comparison](../bench/provider-completion.md) measures the isolated
production provider path, not whole Desktop or 3D Office memory.

## Dependency direction

```text
protocol ← core ← platform ← apps (web, desktop, cli)
```

- `protocol`, `core` and `platform` contain no UI framework, renderer, Electron
  or Node built-ins; they run anywhere.
- Packages never depend on apps.
- Apps reach native features only through platform capabilities
  ([platform.md](platform.md)); only the composition root decides which host
  it runs in.

`pnpm lint` enforces these rules.

[Cross-agent work continuity](../adr/0076-cross-agent-work-continuity.md) keeps a
canonical work record across reviewed Native connection changes and existing
observed endpoints. Immutable source archives, user-reviewed notes and honest
transport receipts remain distinct from hidden harness context. Existing Native
sessions keep their ID; observed app IDs remain separate aliases. Scoped external
MCP readers expose only the notes/snapshots pinned by an explicit handover,
with expiring hash-only grants, live privacy checks and no future-work access.
Native agents receive bounded read tools only after handover. Old generated
capsules are replaced in model history without deleting conversation events.

Saved native mission checkpoints and canonical native control events use
host-owned SQLite WAL under the profile lock, with one-time import of legacy
sidecars. The read-only mission loop requires their atomic acknowledgement
before provider/tool effects (ADRs 0013–0015). Session view events remain a
separate JSONL projection. With the opt-in Rust core, the sidecar owns canonical
mission events and exact task leases in `core.sqlite`; the host retains the
display checkpoint. Independent heartbeats renew unexpired leases and authority
loss stops runtime admission (ADRs 0030–0031). A periodic daemon sweep quarantines
expired missions under the same store lock (ADR 0032), independently of stdin
activity. Immutable execution admissions and late turn-promise observations are
available for read-only recovery inspection (ADR 0033); they do not clear genuine
execution uncertainty. Sealed local-operation tracking and known search-worker
exit add scoped local-drain evidence for trusted built-in adapters (ADR 0034).
Atomic recovery reviews bind canonical state and execution evidence in one read
view with an opaque profile-bound digest (ADR 0035); they expose missing task
admissions and unverified worktree ownership without authorizing closure.
The [original planned-task record](../adr/0046-original-planned-task-membership.md)
adds an immutable graph captured atomically at mission creation. Internal Rust
admission/review checks refuse task membership or definition drift; legacy
absence stays explicit. This records planned tasks, not complete executor,
planner or descendant ownership, and does not authorize recovery closure.
Saved Rust automatic planning now has a separate
[durable lifetime receipt](../adr/0047-durable-native-planning-lifetime.md)
before credential/catalog/inference work. Write-ahead host markers retain
unresolved session/connection guards across restart and backend changes; only
actual local pipeline completion on the original connection records a weak
observation. It does not establish later mission-root, child or writer ownership.
Saved Rust mission starts also retain a [durable preparation lifetime](../adr/0052-durable-mission-preparation-lifetime.md) before credentials or worktree creation. It correlates the future mission and actual supervisor, drains entered preparation, and hands off only after canonical creation plus host/startup persistence. Uncertain preparation or cleanup remains blocked across backend changes and restart; it is not complete executor or writer ownership.
Physical-settlement reconciliation and execution-time action approvals
remain later gates. Generic Python workload execution remains planned; the
separately pinned SkillSpector worker described above is a specific supervised
Python integration and does not provide a general Native executor.
The [probe-only worker protocol](../adr/0041-probe-only-worker-protocol.md) adds
an independent bounded NDJSON codec and pure Rust correlation/deadline state
machine, with a test-only Python health reference. It has no production launcher,
scanner operation or runtime consumer; cancellation/EOF never proves physical
settlement or scanner readiness. The later pinned SkillSpector integration is
separate from this probe-only contract.
The [owned health-probe supervisor](../adr/0042-owned-health-probe-supervision.md)
now exercises genuine subprocesses through a disconnected Rust library API,
with bounded I/O, watchdogs and direct-child reaping. Its feature-gated fixtures
need no Python. Unverified cleanup poisons admission, and direct-child exit
still establishes neither descendant settlement nor scanner/sandbox readiness.
The [bundle inventory observer](../adr/0043-worker-bundle-artifact-observation.md)
checks an independently supplied manifest pin and bounded exact file contents
on trusted quiescent Unix staging trees. Its portable contract does not
authorize a launch; Windows observation refuses until handle/reparse checks are
implemented. This observer alone does not enable a production Python consumer.
An [explicit developer experiment](../adr/0044-relocated-developer-python-bundle.md)
now stages a pinned CPython source archive, materializes regular files, relocates
the payload and exercises the Rust health owner on macOS ARM64. The manifest
permits sixteen path components to retain measured upstream license paths.
That developer experiment is not installer or scanner certification. The later
SkillSpector release path has its own pinning, confinement and packaging evidence;
generic Python workload execution and unverified platform gates remain closed.

The [shared Native status panel](../adr/0054-native-status-and-recovery-inspection.md) projects actual local operation/worker lifetimes and narrow recorded mission metadata. Explicit rechecks may retire only positively observed inactive scope markers; run-bound cancellation, stale-response guards and existing recovery inspection preserve uncertainty without replay.

[Native persistence admission](../adr/0056-native-write-drain-and-relevant-memory.md) checkpoints accepted prompt text before inference and drains admitted local writes before profile unlock; it does not infer external process settlement. Initial workspace recall ranks bounded relevant metadata and uses a stat-validated metadata-only cache, while full content and revision checks remain fresh.

The [Native memory and context controls](../adr/0055-native-memory-integrity-and-context-budgets.md) add revision-bound user/agent writes, scoped paged inspection, explicit provider caching and bounded request-pressure checks. Local refusals preserve history and do not imply a provider call, compaction or recovery authority.

Native Chat and Teams use [progressive workspace memory](../adr/0045-progressive-workspace-memory.md):
a bounded summary catalog, literal metadata search and optional paged reads.
Workers receive read tools only. Built-in recall and opt-in concise-response
instructions do not install upstream hooks or enable automatic learning.
[Automatic Native skill context](../adr/0073-automatic-native-skill-context.md)
uses that private inventory for complete, bounded procedure reads before each
managed Chat, delegation or meeting request. Mandatory memory guidance and
configured-lead orchestration remain separate from capabilities. Selection
refreshes after steering and re-verifies selected external revisions; a quiet
metadata-only receipt appears in the shared Chat/Office transcript. Canonical
mission workers and observed external harnesses remain separate contracts.
The [bounded Native skill inventory](../adr/0057-bounded-native-skill-discovery.md)
retains external metadata/private digests and offers constant-size discovery
schemas. Fresh registered reads remain mandatory; initial verification still
performs linear I/O within an explicit raw-row bound.

The [mandatory external-skill boundary](../adr/0049-mandatory-external-skill-ingress.md)
keeps legacy inventory/consent out of agent offerings. Fresh scanner-gated
registry reads are required for external catalog metadata and every skill read;
canonical shipped built-ins remain separate. Generic documents are unverified
task data, not implicitly activated skills or automatically scanned contents.
An [explicit per-message learning mode](../adr/0050-explicit-prompt-skill-candidates.md)
lets the Native lead propose one generated candidate into the profile library,
then obtain mandatory registry inspection. It grants no activation or worker
skill-writing authority; absent production scanner evidence means quarantine.
The [Skills routing preview](../adr/0048-skill-routing-application-preview.md)
exposes exact-revision eligibility diagnostics through an optional daemon/host
operation. It preserves ambiguity and explicit pins while granting no dispatch,
activation or model access. Whole-vault graph facets filter the bounded loaded
overview locally; they do not change the vault or widen agent access.

Knowledge is [independent of the mission backend](../adr/0051-knowledge-independent-of-mission-backend.md): Desktop and Bridge expose its page and vault setup with either backend, using the same lazy sidecar as recorded Rust recovery.

[Automatic learning and profile artifacts](../adr/0067-rust-owned-learning-and-profile-artifacts.md)
also use that same sidecar. Rust owns curator jobs and result processing, hash
admissions, generated skill staging and two-phase Markdown exports. A bounded
worker keeps this filesystem work away from mission/control dispatch. Host ports
retain consent, approved provider HTTP, actual effect draining and event projection;
this does not migrate ordinary Native Chat tools or claim local model inference.

## Further reading

Optional [next-prompt suggestions](../getting-started/prompt-suggestions.md) use
memory-only platform snapshots. Native prepares bounded completed-task context
and generates only when the view requests its advertised completion anchor.
Observed predictions come from an existing harness connection or authenticated
cooperative report. They never authorize prompt execution or modify history.

PRD v2 adoption follows [ADR 0036](../adr/0036-prd-v2-compatible-adoption.md)
and its [acceptance map](../product/prd-v2-acceptance-map.md). The additive
`extalia.control.v1` capability manifest distinguishes engine, worker and provider
subjects without renaming existing runtime IDs or changing legacy events. Its
TypeScript/generated-schema/Rust validators check claim conformance only; they
do not establish actual support, resolve evidence or authorize dispatch.
Its scoped identity-map contract and pure core forward/reverse lookup preserve
exact legacy source namespaces, reject ambiguous bindings and deny foreign
profile/workspace lookups. The map asserts identities without proving ownership;
it neither migrates stores nor activates a translator or runtime.
Task snapshots keep definition/state revisions and execution/validation/acceptance
claims distinct. A pure read-only legacy projection retains complete source
namespaces and uncertainty; it cannot admit effects or release dependencies.
Acceptance/waiver references still require authoritative resolution under V2-06.
Delegation envelopes and pure branch/replay inspections preserve lineage and
narrow explicit caps, without verifying grants or admitting execution. Effect
admission, durable command receipts and the effect-time broker gates remain open.
The [provisional reservation ledger](../adr/0037-provisional-delegation-reservations.md)
now persists scoped hierarchical allocations and immutable bookkeeping receipts
in Rust schema 9. It remains separate from command delivery, verified authority,
actual expenditure enforcement and all daemon/runtime routes.
The [native action-intent lifecycle](../adr/0038-admission-bound-native-action-intents.md)
binds non-executable edit requests to actual execution admissions and live leases
in schema 10. Immutable pending/expired/revoked history cannot become a grant;
policy/parameter truth and positive user decisions remain separate prerequisites.

The [skill dependency preflight](../adr/0039-read-only-skill-dependency-preflight.md)
checks exact pins, compatibility, conflicts, cycles and permission ceilings over
verified staged sources and a read-only profile snapshot. It returns diagnostics
only, never dispatch authority; lifecycle operations still refuse unresolved relations.
An optional `skill.preflight` daemon/host capability exposes these diagnostics in
Skills without calling inspection or changing lifecycle state. Compatibility facts
and permission ceilings stay empty on this application surface; older peers retain
their existing registry behavior.

The [category/intent routing preview](../adr/0040-eligibility-first-skill-routing-preview.md)
uses the shared read-only source snapshot, active candidate roots, explicit pins
and workspace approval applicability before ranking. It preserves ambiguity and
denies dispatch for every result. No runtime selection or built-in exemption is
enabled; scanner/worker readiness still requires actual version-bound evidence.

- [Protocol](protocol.md)
- [Runtimes, providers and observed agents](runtime-adapters.md)
- [Agent-app connection safety and verification](agent-app-connections.md)
- [Sessions and the session library](sessions.md)
- [Platform capabilities](platform.md)
- [Native mission host API](native-missions.md)
- [Security model](security.md)
- [Architecture decision records](../adr/README.md)
