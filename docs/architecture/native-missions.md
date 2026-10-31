# Native missions in the session host

The programmatic mission API runs a fixed graph of read-only native tasks in an
existing managed session. Desktop IPC and the authenticated Bridge carry the
same `AgentHostApi` methods. The renderer never constructs providers or receives
credentials. See [ADR 0009](../adr/0009-native-missions-in-session-host.md).

| Method | Purpose |
| --- | --- |
| `setWorkspaceMissionConnections(workspaceId, connectionIds)` | Explicitly allow additional saved provider connections for a native workspace. The workspace primary connection is implicitly allowed. |
| `planNativeMission(sessionId, request)` | Ask the session's lead (its own connection/model; host-resolved credential) to propose an editable read-only plan from a goal. Launches no task; temporarily reserves the session and lead connection during inference. Returns a deterministic plan with `source: 'heuristic'` and a `note` on failure. See [ADR 0010](../adr/0010-lead-mission-planning.md). |
| `startNativeMission(sessionId, request)` | Validate and reserve a mission, return its record, then run it asynchronously. |
| `nativeMissionRun(sessionId, missionId)` | Read status and bounded, unverified answers for this session's mission. |
| `listNativeMissions(sessionId)` | Read bounded retained mission records for the session. |
| `cancel(sessionId)` | Request cancellation through the existing managed-session lifecycle. |
| `sessionEvents(sessionId)` / `subscribe(listener)` | Read/receive canonical v0 events; mission events carry `correlationId` and task events carry `taskId`. |

Workspace authorization is saved in optional `missionConnectionIds`. Existing
workspace updates preserve it when omitted; `[]` explicitly clears extra access.
The host loads the real session/workspace and independently resolves each saved
connection. Effective connection/runtime policy cannot be revoked while a native
mission in that workspace is active or unresolved. Caller-supplied endpoints, credentials, credential references, runtime
plans or executable tools are not accepted.

A typed caller can use the API as follows (IDs refer to saved user choices):

```ts
await host.setWorkspaceMissionConnections(workspaceId, [secondaryConnectionId]);
const run = await host.startNativeMission(sessionId, {
  title: 'Review project',
  maxConcurrency: 3,
  tasks: [
    {
      id: 'inspect', title: 'Inspect backend',
      instructions: 'Read the backend structure and report findings.',
      connectionId: primaryConnectionId, model: 'model-a', dependsOn: [],
    },
    {
      id: 'review', title: 'Review findings',
      instructions: 'Review the predecessor findings against the project.',
      connectionId: secondaryConnectionId, model: 'model-b', dependsOn: ['inspect'],
    },
  ],
});
const current = await host.nativeMissionRun(sessionId, run.id);
// current may still be running. Model answers are always unverified.
// Optional runtime budget (ADR 0015); usage is provider-reported only:
await host.startNativeMission(sessionId, { title: 'Bounded review', tasks, budget: { maxDurationMs: 600_000, maxTokens: 200_000, maxTaskTokens: 50_000, maxConcurrency: 3 } });
// run.usage = { inputTokens?, outputTokens?, unknownTasks }; run.budgetExhausted = 'tokens' | 'usage-unknown' | 'duration'
await host.cancel(sessionId);
```

To let the session lead propose the graph first (no task runs until launch):

```ts
const plan = await host.planNativeMission(sessionId, { goal: 'Review the login flow', maxTasks: 4 });
// plan.source is 'model' or 'heuristic' (see plan.note); edit, then launch explicitly:
await host.startNativeMission(sessionId, missionPlanToRequest(plan));
```

Requests contain 1–16 tasks, unique task aliases and a valid DAG. Instructions
are limited to 16,000 characters per task. Concurrency defaults to 3 and is capped
at 8; per-task deadlines default to 60 seconds and range from 50 ms to 10 minutes.
Worker turn steps default to 8 and are capped at 20. Bridge requests also retain
the existing 1 MiB transport limit. Model identities must match configured names;
model aliases and router-auto behavior are not silently substituted.

The host supplies only workspace-bounded file read/list/search tools. A task
receives bounded predecessor output explicitly marked unverified and untrusted,
with truncation indicated. No write, command, memory, skill or delegation tool is
available. A model answer is not artifact/test evidence. Lead planning
(`planNativeMission`) only proposes tasks over workspace-allowed connection/model
pairs; the plan's tasks pass `normalizeHostMissionRequest` and must still be
launched explicitly. Real-cloud certification remains open.
The Web/Desktop **Missions** page ([ADR 0011](../adr/0011-mission-ui.md)) uses only
these methods: plan, edit and validate, `startNativeMission`, poll `nativeMissionRun`
with correlated session events, and `cancel`. It shows task states and unverified answers.
Planning participates in session/connection admission. Cancellation or the 45-second
lead-call deadline returns a heuristic proposal, but a provider that ignores abort
keeps its reservation until its actual call settles. Late replies are discarded;
planning reservations are not durable across host restart. Candidate catalog
discovery precedes that deadline and retains its existing four-second abort
signal/cache; cancellation during discovery rejects preparation after the
lookup settles. An abort-ignoring catalog can keep that request pending. See
[ADR 0012](../adr/0012-mission-planning-admission-and-retained-graphs.md).

Saved sessions reject selected connections with history off. A transient session
keeps all mission metadata and projected events in memory. Projected statuses,
model names and retained answers respect this same policy. No guarantee about
provider-side retention is implied. Known resolved credentials and common secret
patterns are masked from retained labels and answers; inputs and model output
remain untrusted data.

Saved mission checkpoints now use host-owned `state/missions.sqlite` with WAL
and transactional checkpoint/change rows ([ADR 0013](../adr/0013-transactional-mission-checkpoints.md)).
The existing profile lock gives Bridge/Desktop one writer. Each changed snapshot
and its revision/digest commit atomically; change cursors are monotonic and reads
bounded. Schema 2 adds sanitized canonical native control events in the same
transaction ([ADR 0014](../adr/0014-atomic-native-mission-events.md)). The runtime
requires a synchronous increasing sequence acknowledgement before provider and
read-tool effects, including caller-supplied tool prechecks. Persistence failure
latches the mission, stops new admission and aborts siblings; ambiguous execution
stays unknown. Session v0 JSONL events remain a separate projection and are not
atomic with SQLite.

The host imports a validated `sessions/<session-id>.missions.json` once per
session, committing its marker/source digest with the checkpoints. Original
sidecars remain untouched; once imported they are never an authority or fallback.
A removal tombstone prevents stale sidecar reimport. Corrupt/newer databases
fail closed; older binaries cannot safely continue from stale sidecars.

Result retention remains at most 16 records and 8 MiB of encoded metadata per
session. Older terminal records and their changes are pruned; current/unresolved
records are protected. Checkpoint changes are capped at 8,192 per session and
writes that exceed the cap fail atomically. Each change page is limited to
1–1,000 records. New task records include validated `dependsOn` alias arrays
(explicit `[]` for roots), so reopened missions retain their DAG. Legacy tasks
without this field remain graph-unknown and still show their results.

Before exposing saved state after restart, a `running` mission is committed as
`recovering` with unknown task execution and is never replayed. Unknown execution
blocks reuse of affected connections and deletion that would erase quarantine.
A lost/corrupt saved session record cannot hide unresolved checkpoints: startup
fails closed until that record is restored/reconciled.
Intermediate runtime task states and planner reservations remain volatile.
Transient/history-off mission results and recovery metadata remain in RAM;
checkpoint durability does not certify provider/tool intent or retry safety.

Native control events and their checkpoint commit atomically before each
provider/tool effect ([ADR 0014](../adr/0014-atomic-native-mission-events.md)).
Optional mission budgets ([ADR 0015](../adr/0015-mission-budgets-and-usage.md))
limit duration, reported tokens per mission/task and concurrency. Exhaustion stops
admission (queued tasks become blocked) and refuses a running task's next model
call; in-flight calls are not aborted for tokens. Unreported usage is unknown,
never zero; a mission token budget with unknown usage fails closed. No cost is
computed because no versioned price table exists. No performance/memory claim
follows from this integration.

With the opt-in Rust core, `core.sqlite` owns canonical mission events and task
leases behind the same host API. Gate 3.3A adds read-only recovery inspection
([ADR 0030](../adr/0030-authoritative-mission-recovery-inspection.md)); the host
checkpoint remains a separate display projection. Gate 3.3B adds independent
30-second heartbeat renewal of exact task/lease/holder claims and strict expiry
fencing ([ADR 0031](../adr/0031-native-lease-heartbeat-and-fencing.md)). Heartbeats
do not grow the event journal. Tools require a fresh lease renewal before policy
decisions; authority loss latches the runtime persistence-failure path, even
when providers are silent. Restart and ignored cancellation retain uncertainty,
never replay execution. Rust mission admission requires the heartbeat capability;
an older daemon cannot silently fall back to TypeScript.

Gate 3.3C adds a periodic daemon sweep sharing the single core store under a mutex
([ADR 0032](../adr/0032-periodic-native-lease-reaping.md)). At most 16 affected
missions are quarantined per transaction: an expired lease makes in-flight
siblings unknown and the mission recovering, while queued and terminal tasks
stay unchanged. Renewal and reaping serialize; neither can revive quarantine.
The sweep continues while stdin is idle and stops when the request loop ends.
Sweep failure latches mission, policy and skill mutations until daemon restart;
canonical snapshots stay read-only. Knowledge indexing keeps its own worker.

Gate 3.3D1 records immutable execution admissions in core schema 7 and once-only
`turn-promise-settled` observations ([ADR 0033](../adr/0033-durable-execution-observations.md)).
Admission identity binds the supervisor invocation, exact task/attempt/lease,
profile, workspace and captured task/graph hashes. History without admission is
never backfilled. Actual turn fulfillment/rejection may report late through its
original daemon connection; abort, timeout, cleanup and restart cannot invent
an observation. Recovery lists this evidence with its explicit limit, preserving
unknown/recovering state, results and worktree ownership. A settled turn does not
prove parallel tools drained, child exit or remote cancellation.

Gate 3.3D2 seals and tracks raw provider/tool promises and complete tool pipelines
([ADR 0034](../adr/0034-tracked-local-operation-drain.md)). Coverage version
`extalia-native-local-v1` is selected by the trusted built-in host composition,
not by model requests. Actual turn settlement, sealed admission and no outstanding
tracked work are all required. Search waits for its known worker to terminate or
exit; failed termination without exit retains pending work. Early parallel or
preflight failure cannot hide siblings or start post-seal effects.

Core schema 8 stores separate immutable local-drain proofs bound to the existing
admission and prior weak observation. Counts describe actual raw calls only.
Recovery can inspect this scoped evidence after reaping/restart; it never restores
authority or releases quarantine/worktrees. Unknown/custom adapters, detached
descendants, network shutdown and remote cancellation are not certified. Current
mission tool wrappers still omit parallel metadata; the generic turn-loop hook
also protects parallel use without enabling new mission parallelism.

Gate 3.3D3 adds `mission.recoveryReview` ([ADR 0035](../adr/0035-atomic-canonical-recovery-review.md)):
a single read transaction for canonical snapshot, execution evidence and complete
mission/graph hashes. Its opaque profile-bound review digest includes late
evidence and leases even when mission version/journal sequence are unchanged.
The host prefers the coherent operation, refuses mixed fallback after failure,
and rechecks local guards/identity after awaits. Legacy separate inspection stays
informational. Missing admission IDs include never-started tasks; worktree
ownership is always unverified. No review receipt, decision, closure or release
is implemented. Future decisions must recompute the review in their write
transaction and require applicable execution/worktree ownership and fencing.

Core schema 9 adds a separate [provisional delegation allocation ledger](../adr/0037-provisional-delegation-reservations.md).
Explicit scoped seeds, whole-subtree escrow, CAS and immutable receipts prevent
double allocation within this local store. Bounded reconstruction checks balances,
causal receipt chronology and revision accounting. Known-scope denials can persist
only a conservative clock observation; SQL/precommit failures roll back allocation
and clock together. Revocation is one-way and expiry/restart never refund capacity.
The library API has no daemon/host/runtime caller and every result remains
unverified and ineligible for dispatch. Mission state, source ownership, grant
resolution, actual spending and physical settlement are unchanged.

Core schema 10 adds [admission-bound native edit intents](../adr/0038-admission-bound-native-action-intents.md).
Capture checks the actual admission plus exact live lease and write-capable running
task/mission; it does not accept a caller's identity assertion alone. Parameter
hashes, policy and skill references remain unverified, so every result stays
ineligible for dispatch. No raw arguments are stored. Scoped replay, withdrawal,
per-execution clock and immutable expiry history prevent request resurrection.
Canonical profile recovery invalidates pending intents atomically with old leases;
ordinary store opening is not profile recovery. No RPC/runtime or positive approval
consumer is enabled, and legacy permission behavior is unchanged.

Full gate 3.3 still needs physical-settlement reconciliation. Execution-time
scoped approvals (3.4) and Rust-owned worktree
fencing remain open. The Python worker and its embedded CPython distribution
are not implemented; Python is not required for the current chat or mission loop.
