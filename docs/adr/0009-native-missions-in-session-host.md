# ADR 0009: Native missions through the existing session host

Status: Accepted (2026-10-17)

## Context

The read-only mission kernel runs fixed DAGs with explicit model bindings, but
cannot resolve credentials, authorize a workspace, persist user history or enter
the existing cancellation lifecycle. Stage 2 needs a host boundary before UI.
The existing host uses non-UUID session/workspace IDs and stores v0 events.

## Decision

Expose native mission start/read/list calls on the authenticated AgentHostApi.
Use existing session cancel and busy reporting. Accept a strict bounded request
with task aliases, dependencies, instructions and saved connection/model IDs;
never accept provider endpoints, credential references or executable tools.
Build UUID identities inside the host after authorizing the actual session.

The workspace's primary connection is implicitly allowed; extra connections
require an explicitly saved workspace allowlist. Each selected connection uses
its own host-resolved credential. Normal workspace edits preserve an omitted
allowlist. Clearing it requires an explicit empty list. Permissions are Extalia
configuration, not modifications to external agent applications.

Only existing workspace-contained read/search file tools enter the kernel.
Keep observed/external sessions outside native execution. Reserve the session
before asynchronous preparation, share cancellation, and conservatively prevent
overlapping use of mission-reserved or unresolved provider connections.

Project actual kernel events into the existing v0 session event log, with mission
correlation and task identity. Do not store a second v1 journal. Keep bounded
run/result metadata as an atomic sidecar; metadata is a projection, not a
transactional scheduler database. Flush event writes before accepting terminal
metadata. Surface history write errors rather than fabricating persisted success.
On restart, previously running saved missions enter recovering, never replay.

Saved sessions reject history-off worker connections. A history-off session keeps
all mission metadata and projected events in memory even if other selected
connections permit history. No remote provider retention guarantee is implied.
Unknown execution remains quarantined; deletion must not erase that safeguard.
This is not a complete durable lease/recovery design, which remains Stage 3.

Model context capacity may be absent when undiscovered. Do not create a dummy
limit for a host-generated plan. Adapter support in a plan is not certification
of every model behind that adapter.

## Remaining gates

- Mission launch/review UI, live-provider certification and verified artifacts.
- SQLite transactional state/journal, crash-safe leases and explicit recovery UI.
- Enforced token/cost/mission-duration budgets and authenticated action approvals.
- Worktree-isolated writers, commands and automatic plan generation.
- Resource benchmarks; this update does not change Office rendering or animation.

See [continuation ledger](../product/native-orchestration-v1-handoff.md).
