# ADR 0008: In-memory native mission supervisor before host integration

Status: Accepted (2026-10-17)

## Context

The Stage 1 contracts and repository check pass. Existing native delegation can
run workers, but team model routing uses one saved connection. It is not yet a
mission DAG scheduler across explicit providers. Durable task/event storage and
worktree isolation require separate implementation stages.

## Decision

Implement an additive, programmatic supervisor in `@extalia/runtime`, using
validated orchestration v1 plans and the existing provider-neutral turn loop.
A trusted caller binds explicit provider/model identities and supplies bounded
read-only tools. The graph is fixed before execution. Enforce global/provider
concurrency, individual-agent exclusivity, hierarchy depth and task cancellation
or timeout. Failed branches block their dependents; unrelated work continues.

Do not expose write/command/delegation tools through this first slice. Do not
resolve credentials, scan profiles, create worktrees or invoke external agents.
The existing provider adapters may perform their own documented retry behavior;
the supervisor adds neither retries nor fallback routes.

Emit validated v1 events with actual mission/task/agent context to the caller.
Provider/model attribution comes from task results (including captured model
names) joined by task/agent IDs to plan identities; v1 events do not gain new
provider fields in this slice.
Any sequence is local to one invocation, not a durable global cursor. A model
answer remains unverified and cannot become test/build proof. Treat event sinks
and model providers as explicit integration boundaries, not hidden services.

## Consequences and remaining gates

- Existing session/Office v0 event producers and consumers are unchanged.
- No storage migration or competing persisted event authority is introduced.
- Before host integration, map legacy IDs and workspace/provider permissions,
  decide canonical event projection/storage, and define mission invocation APIs.
- Abort requests are cooperative. A non-cooperative provider cannot be claimed
  killed; report uncertainty and suppress late callbacks after task closure.
  Quarantine is local to the invocation; a caller must reconcile unknown work
  before starting another invocation that could overlap the same resources.
- Token/cost/duration budgets (other than agent/depth admission limits), approval
  enforcement, leases/recovery, write isolation, mission UI
  and live-provider certification remain unimplemented.
- Scripted tests through the OpenAI and Anthropic adapters prove local protocol
  integration only, not cloud availability, billing or task quality.

See [continuation ledger](../product/native-orchestration-v1-handoff.md).
