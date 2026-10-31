# ADR 0036: Compatible adoption of PRD v2 contracts

Status: Accepted for additive contract work (2026-10-29). Runtime activation,
vendor certification and release acceptance remain gated as described below.

Tracking: [V2-01 / #39](https://github.com/Extalia-VO/extalia-virtual-agent/issues/39).
Basis: [audit](../product/prd-v2-audit.md),
[staged plan](../product/prd-v2-development-plan.md) and the
[canonical acceptance map](../product/prd-v2-acceptance-map.md).

## Context and decision scope

The incoming implementation pack is a design input. Its conflicting examples do
not supersede existing protocol, storage, stack or permission decisions. This ADR
resolves D-01–D-07 for new compatibility contracts. It authorizes their definition
and validation, not dispatch, migration of existing records, external configuration
changes, a new default authority or a release. Existing event stores, runtime IDs,
features and uncertainty guards retain their meaning.

The audit records archive SHA-256
`88db9001964a0f11c4602e47addde8f5f0d5d75cfa81f5eefaaa10b5c83e5db9`.
Original source examples remain outside public source because they contain private
identities. Public contracts and fixtures use synthetic identifiers and content.

## D-01: Repository, stack and canonical ownership

Keep this public repository, React/Electron/Three.js, and the dependency direction
`protocol ← core ← platform ← apps`. Reinterpret incoming F0-02/FR-018 as source,
history, license, asset and distributed-artifact revalidation. It does not require
a new repository or rewritten history. Vue/Tauri adoption would need a separate
ADR with measured benefits and migration/rollback evidence.

`@extalia/protocol` remains the schema authority. Rust remains the canonical
control-plane direction under [ADR 0021](0021-rust-integration-strategy.md), with
TypeScript host/provider/executor code retained behind its contracts. Each store
has one canonical writer; host checkpoints and UI event streams are projections,
not independent authority. Rust default-on still needs the existing parity and
benchmark gate; a contract parser cannot turn it on.

Python remains a Rust-supervised, on-demand worker using bundled, pinned CPython
under [ADR 0022](0022-python-worker-distribution.md), never a prerequisite for
chat, manual orchestration or observation. This ADR neither installs it nor
declares its distribution or sandbox implemented.

## D-02: Native coordinator and executor

Add a deterministic coordinator seam for DAG planning, scheduling, policy and
evidence collection above the existing Native API executor. Preserve the Native
API agent, user-selected model/custom router, Hermes runtime and stored runtime
IDs (`extalia-native`, `hermes`). Logical engine choices do not rename these IDs.
The compatibility boundary records explicit engine/runtime mappings.

Manual plan editing, navigation, history and mock compliance can work without a
provider key. Real coding requires an available, permitted worker/model. OpenCode
is a candidate coding worker, not a fourth primary engine or mandatory replacement
for API-based Native execution. Native, Hermes and OpenClaw describe logical
coordinator choices; availability and executable capability are independently
reported for the actual installed mode.

## D-03: Wire, IDs, task revisions and delegation

New PRD v2 contracts use `protocol: 'extalia.control.v1'` and numeric
`schemaVersion: 1`, exposed as `CONTROL_PROTOCOL_VERSION` and
`CONTROL_SCHEMA_VERSION`. The string `"1.0"` from incoming examples is invalid on that
wire; there is no coercion. Contract/schema version, installed adapter version,
provider protocol version, application version and document version are distinct.
Existing `extalia.v0`, orchestration schema 1 and daemon frames remain unchanged.
Parsing dispatches by contract family before validating its version; the number
`1` alone never identifies a protocol. Unknown versions fail closed.

The first V2-02A increment defines only `ControlCapabilityManifest` conformance:
engine/worker/provider subjects, per-mode support states, nonblank reasons,
adapter versions and required verification references. A supported/experimental
claim requires the actual runtime version; an unknown version is never guessed.
The parser checks reference shape, not whether the claimed version, policy,
configuration or evidence is true, current or belongs to this scope. Receivers
must resolve and validate those facts before any effect. Experimental claims
explicitly require opt-in; a manifest cannot grant that opt-in itself.
This structural check neither authorizes a call nor implements task state,
delegation, storage or dispatcher contracts below.

New entity IDs are UUIDs. Legacy `s_…`/`w_…`, orchestration UUIDs and external IDs
cross the boundary through explicit scoped mappings recording source family and
source identity. Preserve their original values and source references; reject
collisions or foreign-scope mappings. Never infer UUID authority or rewrite old
rows in place. Imported snapshots are immutable revisions; reimport deduplicates
or appends a new source-hashed revision with preview, rather than overwriting the
old snapshot. Linked/observed sources remain read-only.

V2-02B adds a bounded `ControlIdentityMap` contract and pure core lookup, without
activating a translator on existing event or storage paths. The map carries the
canonical UUID `profileId` and `workspaceId`. Each binding contains an entity kind
(`session` or `workspace`), canonical UUID and the exact source tuple: family
(`extalia.v0`, `orchestration.v1`, `external`), system, installation `instanceId`,
source `workspaceId` and original `id`. Source workspace identity is distinct
from the map's canonical workspace scope. Both Extalia families require system
`extalia`; an external adapter uses its explicit runtime identifier. Source IDs
and installation IDs are never trimmed, normalized or generated by lookup.

Existing v0 data can contain arbitrary bounded nonblank workspace/session IDs;
the current host's `s_`/`w_` generation patterns are not storage constraints.
Orchestration source workspace/entity IDs remain UUIDs; external IDs remain
opaque bounded text. The complete tuple is encoded without delimiter ambiguity.
Within one map, repeated tuples or repeated canonical UUIDs are rejected across
all entity kinds. Alias merging needs a future explicit design; this increment
does not coalesce sources. A registry contains at most 1,000 bindings.

Forward/reverse lookup validates the whole map and checks exact profile/workspace
scope before returning detached bindings. Foreign scope, malformed/colliding maps,
invalid references and unmapped identities fail without UUID passthrough or alias
inference. TypeScript and Rust share golden fixtures; generated JSON Schema
documents the additional tuple/canonical uniqueness and UTF-16 validation checks.
These are asserted namespaces, not proof of ownership, source membership, freshness
or permission. Authoritative registry storage, binding admission and actual source
ownership resolution remain gated future work, as do engine/runtime aliases,
state/evidence translation and delegation. No old records are rewritten.

Task definitions carry `definitionVersion` for immutable plan/definition revision;
mutable task aggregates carry `stateVersion` for compare-and-swap. Plan revision,
execution attempt, workspace engine generation and writer fencing generation are
separate counters. New mutation commands carry the applicable expected versions;
stale or missing expectations cannot mutate a protected aggregate. Incoming
`TaskDefinition.version` needs an explicit translator, never an implicit alias for
both revisions. Legacy `Mission.version` and task enums keep their existing meaning.

The new task lifecycle includes `superseded` alongside the incoming lifecycle.
Supersession preserves the prior definition and audit trail; it does not cancel
an executor or establish settlement. An active definition must drain/reconcile
before replacement can gain execution authority. Unknown provider states remain
unknown/opaque and cannot become completed. Transition/translation fixtures must
cover every supported state before runtime use.

V2-02C introduces `ControlTaskSnapshot` as a separate `extalia.control.v1`
`kind: 'task-snapshot'` claim. Its lifecycle is `created`, `blocked`, `ready`,
`leased`, `running`, `waiting_approval`, `retry_wait`, `validating`, `completed`,
`failed`, `cancelling`, `cancelled`, `unknown`, `manual_intervention`, `superseded`.
It carries UUID profile/workspace/mission/task scope, independent positive safe
integer `definitionVersion` and `stateVersion`, execution outcome/optional execution
UUID, validation and acceptance records, and unique bounded evidence UUIDs.
This neither extends legacy task enums nor defines a transition/command protocol.
`superseded` may retain a running execution claim; it is not settlement evidence.

Execution outcome (`not_started`, `running`, `succeeded`, `failed`, `cancelled`,
`unknown`) is distinct from validation (`not_run`, `pending`, `passed`, `failed`,
`unknown`) and acceptance (`not_reviewed`, `pending`, `accepted`, `rejected`,
`waived`, `unknown`). Resolved validation/acceptance claims require an opaque
`recordRef`; a waiver also requires a reason. A known started outcome requires
`executionId`. An accepted claim requires succeeded execution, passed validation
and evidence. A completed claim requires succeeded execution and acceptance or
waiver; a waiver may retain failed/unknown validation and cannot invent execution
success. The same three consistency guards are enforced by TypeScript, generated
JSON Schema and Rust. Scope/record/UUID shape never establishes truth or freshness.

The pure core legacy projection reads only a valid orchestration-v1 task plus
explicit caller-asserted canonical profile/workspace view scope and original
family/system/installation/source-workspace/source-mission namespace. Original
task and mission IDs remain inside `source`, not presented as mapped canonical
entities. The view is explicitly read-only and ineligible for dispatch; it is not
accepted as either an old task or a new task snapshot. Queued/assigned project
conservatively to `created` without claiming readiness or lease ownership; generic
`waiting` projects to `unknown`, retaining the exact source state. Completed,
failed and cancelled outcomes are labelled source-reported, not proven settlement.
Source verification/evidence labels remain intact, even for `verified`, while v2
validation/acceptance remain unknown and both revisions remain null. No attempt,
mission version or source state is reused as a new revision. v0 events, malformed
tasks and unknown source enum values are refused, not coerced into success.

This increment does not implement authoritative definition/record storage, CAS
mutations, transition admission, record resolution, dependency release, migration
or runtime dispatch. Before any consumer uses an accepted/waived claim to admit
effects or satisfy dependencies, V2-06 must resolve its real record and validate
actor authorization, profile/workspace/mission/task/execution identity, exact
definition/evidence versions and digests, scope, expiry/revocation and policy
version. A waiver's reason/reference is not that proof. No runtime consumer or
acceptance gate is activated by this contract; even a well-formed fictional record
remains an unresolved claim. Definition revision commands, engine aliases,
delegation and the rest of V2-02/T1 remain subsequent work.

Delegation uses canonical `sourceEngineId` and `targetEngineId` naming, a required
opaque `authorityRef`, root mission/workspace/run identity, parent task, execution
identity, engine generation, bounded lineage, remaining hop/child limits, inherited
budget, expiry and stable idempotency identity. `authorityRef` refers to a real
authoritative scoped admission/lease record; it is not a model-created engine name,
approval ID or bearer permission minted by parsing. Incoming `ownershipToken`,
`originEngineId` and `delegateeEngineId` require an explicit boundary translation;
conflicting aliases are rejected. An approval reference remains separate.

The broker resolves and validates authority against the current profile, workspace,
root/task/execution, actor, target, generations, scope and expiry before admitting
a child. Each delegation narrows the parent's authority and consumes bounded
budgets atomically; lineage/hop checks cannot be bypassed by a new process ID.
External children with unavailable ownership/settlement proof remain unknown.
No contract-only reference grants authority or starts a broker.

V2-02D adds a separate `ControlDelegationEnvelope`, `kind: 'delegation'`, with
strict TypeScript/Rust validation and generated JSON Schema. Required fields
include a delegation UUID, profile/workspace/root-mission/root-run UUIDs,
root/source/target engine IDs, delegating parent task and source execution UUIDs,
target task UUID, positive workspace engine generation, target definition version
and SHA-256 digest, opaque authority reference, lineage, explicit limits/budget,
stable idempotency key and issue/expiry instants. An optional `approvalRef` is
separate; it cannot replace `authorityRef`. Legacy aliases and extra fields fail
closed instead of silently translating them. Definition digest and references
are caller claims, not proof that any authoritative record exists or matches.

Lineage is an ordered list of 1–32 `{ engineId, taskId }` ancestors. Its first
engine matches the root; its last entry identifies the delegating source and
parent task. Task identities cannot repeat across ancestors or as the target,
even under another engine. Same-engine delegation to a distinct child task is
allowed. This is child delegation, not a task handoff/engine-switch protocol.
The source execution identifies the sender, not target execution or settlement.

`hopRemaining` (0–32) and `childRemaining` (0–1,000) describe descendant allowance
after this edge; zero denotes a leaf. No implicit defaults or unbounded omitted
caps exist. All budget fields are required nonnegative safe integers:
`maxWallClockMs`, `maxTokens`, `maxToolCalls`, `maxEstimatedCostMicrousd`.
A micro-USD is one millionth USD; the cost cap is still an estimate. No implicit
conversion from legacy floating USD or absent caps is performed. Zero budget
does not confer permission to spend. Actual worker/time/tool/billing limits need
enforcement against the authoritative remaining pool at each effect.

Pure extension inspection accepts an explicit clock and requires both windows
active (issue inclusive, expiry exclusive), identical root scope/generation,
source-parent correspondence and exact lineage prefix plus one ancestor.
Delegation/source-execution/authority/idempotency identities cannot be reused
from the parent. Both descendant allowances consume at least one and cannot
expand; budget caps cannot grow, issue time cannot precede the parent's and
expiry cannot exceed it. Checks compare claimed envelopes only, not trusted
grants or the current generation. A fresh process ID cannot reset this ancestry.

Pure replay comparison scopes keys by profile/workspace/root-mission/root-run.
An identical key with changed validated intent is a conflict, including changes
to target, definition, authority, generation, limits, budget or timestamps. JSON
object-key order and equivalent safe-integer number representations do not change
intent; timestamp/reference spelling remains exact. Equality, even for expired
historical intent, is not permission to resend and is not a durable receipt.

Both pure inspections are implemented in TypeScript and Rust with shared fixtures.
TypeScript success explicitly returns `authorityVerified: false` and
`dispatchEligible: false`; Rust success likewise establishes only consistency.
They create no IDs, mutate no budget, store no receipt and call no driver. Two
siblings can separately pass; only a future canonical transaction can reserve
their shared allowance atomically. AR-04 still needs real scoped authority/actor/
target/version/generation resolution, expiry/revocation, inherited policy and
approval enforcement, atomic child/budget admission, durable intent/receipt and
actual provider ownership/settlement proof. There is no broker/runtime wiring,
migration, engine-alias translation or claim of complete V2-02/T1 acceptance.
The later [ADR 0037](0037-provisional-delegation-reservations.md) adds provisional
local allocation persistence without closing those authority or effect gates.

## D-04: Completion and evidence

Model execution outcome, validation and acceptance as distinct facts. A worker's
successful return or `tool.completed` establishes neither validated output nor
accepted task completion. Required dependencies release only after the configured
validation/evidence policy accepts the result, or an explicit authorized waiver
records actor, exact evidence/definition versions, scope, reason and policy version.
Failed validation or unknown evidence cannot silently satisfy a required edge.
Waiver remains visible and never manufactures a verified test result.

Historical `completed + unverified` remains unverified and is not retroactively
promoted or rewritten. A legacy event translated into a new read model retains
its provenance and uncertainty; translation alone cannot admit new dispatch.
Mission completion requires the applicable acceptance of every required node;
optional, cancelled and superseded nodes need explicit plan/dependency treatment.
V2-06 defines that policy and migration before scheduler activation.

Presence first checks correlation, source trust, instance generation and freshness.
Reject/quarantine wrong-scope events and ignore stopped/older generations. Keep
durable task terminal history separate from live freshness. Display unresolved
safety/approval blocks explicitly; expired reconciliation/heartbeat makes optimistic
activity unknown/stale, never completed or idle. For current trusted activity the
order is error/safety, approval/blocked, actual meeting, reviewing, working, idle,
offline. Decorative movement supplies no execution evidence.

## D-05: Release applicability

Mock-only vertical slices are preview. A core v2 alpha claim requires T1–T4 plus
one real permitted worker, source-safe minimal import/export, applicable Bridge,
security and actual claimed platform evidence. OpenCode is the first candidate;
the final worker/vendor choice and permitted account-mode certification stay open.
A different first worker needs a recorded scope decision and the same acceptance
suite; it cannot waive FR-007. Hermes/OpenClaw mixed-engine E2E gates their feature
claims, and becomes an alpha blocker only when included in that alpha's promises.

Per-mode capability manifests report status, reason, installed/protocol versions,
auth and policy clearance. Unsupported, unavailable or blocked operations perform
no process/provider call. Technical feasibility and provider/account entitlement
are independent gates before a real worker runs; parsed files, hook trust and
discovered binaries do not certify managed control. Existing provider permission
systems remain effective. No consumer wrapper, credential extraction or arbitrary
already-open external-session takeover is authorized.

## D-06: Isolation, controllers, fencing and durable effects

Profile/workspace isolation covers settings, secrets, grants, skills, knowledge,
sessions and event delivery. Workspace engine switches use a persisted engine
pointer and monotonic generation, explicit drain/reconciliation and CAS. Old
generations cannot regain dispatch, write or integration authority after switching.

The incoming unique key `(sourceSystem, externalSessionId, activeControllerLease)`
is rejected: different leases permit duplicate controllers. Use one active
controller slot keyed by canonical external source identity (source system,
source installation/account namespace and external session ID), **excluding**
workspace, controller and lease ID from the uniqueness key. A canonical store
transaction claims/replaces that slot under a unique key and CAS, increments a
monotonic fencing generation, and records controller, lease and expiry. Historical
leases live separately. Expiry alone does not prove external settlement or permit
unsafe replay.

Every control/write/integration effect checks current slot, exact lease/execution,
engine and writer generations and unexpired authority at its actual boundary,
including after awaits. A local process/file lock only coordinates its documented
scope. Separate data directories or a vendor's own clients are not globally fenced
by this database. If the official external surface cannot establish safe ownership
and conflict handling, refuse attach/resume/control; expose observe/import mode.
Never claim a provider-global controller guarantee without provider evidence.

Keep command intent and event delivery separate. A canonical transaction commits
state transition, queue claim, immutable command intent with stable command ID and
idempotency key, canonical domain event and event-outbox entry as applicable.
The event outbox publishes committed facts and retries delivery; it does not grant
permission to resend an effect. A command dispatcher rechecks current authority
and exact durable action approval, records attempt/ack/provider operation identity
and reconciles outcome independently. ACK means accepted, not completed. An absent
ACK after possible acceptance is unknown; retry requires explicit replay-safe
classification and supported receipt/dedupe evidence. A new execution attempt gets
a new execution identity. No exactly-once external-effect guarantee is made.

Event inbox deduplication, workspace sequence and consistent snapshot cursor support
at-least-once delivery with idempotent projection; gaps require bounded replay or
resync. They are not proof of command nonacceptance. V2-08 production dispatch and
retry wait for applicable V2-03/04/05/06 fencing, terminal reconciliation, durable
approvals and evidence gates. Contracts, schemas and mocks may precede them.

Exact approval enforcement retains [ADR 0026](0026-permission-enforcement-point.md):
bind actor/profile/workspace/task, canonical target, validated parameter digest,
scope, expiry and policy version; check revocation immediately before each effect.
User decision and worker request identities differ. Reconnect does not grant;
restart handling retains the existing pending-approval expiry rule. With daemon
authority selected, failure denies rather than falling back to a weaker policy.
Bridge pairing/client scopes/revocation extend existing loopback/Host/Origin/token
defenses; remote/LAN exposure is not enabled by this decision.

Recovery review, settled promises and local drain remain scoped evidence under
[ADR 0035](0035-atomic-canonical-recovery-review.md), not terminal authority.
Unknown planner/descendants, remote effects or writer/worktree ownership stay
quarantined. Reconciliation requires immutable applicable membership/ownership,
fencing and a reviewed digest recomputed inside the committing transaction.

## D-07: Milestones and retained requirements

Keep application/package versions lockstep; PRD v2 is not application v2.0.
v0.5 retains durable control, knowledge carryover (V2-17A), scanner and bundled
Python acceptance. T7 scheduling or a passing mock cannot defer them silently;
scope changes require an explicit roadmap/ADR amendment. v0.6 retains reviewed
learning/evaluation, rollback and no automatic privileged skill activation.

[ADR 0023](0023-skill-scanner-adapter-pinning.md) remains fail closed: unavailable,
unverified, invalid or incomplete scanner evidence cannot activate untrusted
skills. A clean scan is necessary, not sufficient; activation never adds grants.
The scanner pin/source/license/report and per-OS containment remain open until
verified. Preserve existing knowledge/skills, EN/ID, accessibility and the accepted
campus performance target; incoming benchmark targets do not lower it.

## Consequences and open evidence

Compatibility costs explicit translators, separate revisions and shared TS/Rust
fixtures, but avoids competing authority and historical reinterpretation. The
acceptance map controls requirement-to-backlog traceability. AR scenario IDs are
planned assertions until linked to runnable tests, commands and artifacts.

Runtime ownership, reconciliation, approvals, queue, engine switching and new
acceptance remain implementation gates. Vendor modes/accounts, scanner pin,
platform packaging/sandbox support, reference hardware and measured thresholds
are not certified here. Source/history/SBOM/asset/tarball review and required CI
remain release gates. No runtime, configuration, real profile, release or vendor
PoC is changed by accepting this ADR.
