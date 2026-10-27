# ADR 0015: Mission runtime budgets and usage ownership

Status: Accepted (2026-10-18)

## Context

Native missions had per-task deadlines and concurrency/agent admission but no
mission-wide duration, token or usage accounting. The protocol `Budget` record
was always written with zero limits. The planning pack requires honest
accounting (FR-04/FR-08) and AC-08: an exhausted budget blocks new scheduling
without corrupting running state. ADR 0014 made every control event an
acknowledged SQLite (or bounded RAM) commit before the next provider/tool
effect; budgets must use that boundary instead of a second store.

## Decision

`HostMissionRequest.budget` is one optional object:
`{ maxDurationMs?, maxTokens?, maxTaskTokens?, maxConcurrency? }`. The strict
normalizer rejects unknown keys, accessors, non-integers and out-of-range values
(never clamps): duration 1 s–24 h, tokens 1–100,000,000, a per-task limit no
larger than the mission limit, concurrency 1–8. The legacy top-level
`maxConcurrency` remains and must agree with the budget's value. An omitted
limit is not enforced. The host retains the normalized budget, always including
concurrency, on the run; the protocol plan budget mirrors it (0 = no limit).

**Usage ownership.** The runtime meters every provider call made by a task.
Only provider-reported `inputTokens`/`outputTokens` count. A call that returns
without both values, fails, is cancelled/timed out, or never acknowledges
cancellation marks that task's usage `unknown`; its reported counts remain a
lower bound. Unreported usage is never zero and never estimated. The run reports
`usage { inputTokens?, outputTokens?, unknownTasks }`; counts are absent when
nothing was reported. Late results from abort-ignoring calls cannot change the
accounting after the task outcome is fixed. Cached-input detail is not counted.

**Enforcement** happens in the real scheduler at two boundaries, never by
aborting an in-flight call for tokens:

- Admission: once the mission is exhausted, queued tasks become `blocked`
  (`budget-exhausted`, `usage-unknown` or `mission-deadline`) and no new task
  is assigned. Running tasks keep their state.
- Provider call: before each call a running task is refused when the mission is
  exhausted or its own `maxTaskTokens` is reached; it ends `cancelled` with that
  reason and keeps its reported usage. The in-flight call completes normally.

Mission token exhaustion is `tokens` when reported usage reaches `maxTokens`.
With a mission token budget, any unknown usage (except after user cancellation)
exhausts it as `usage-unknown`: a budget that cannot be proven fails closed.
With only `maxTaskTokens`, unknown usage refuses that task's next call only.
A single call can overshoot a limit; the overshoot is reported, not hidden.

`maxDurationMs` starts after the mission's first acknowledged event. Expiry
records `duration`, stops admission and cooperatively cancels running tasks with
the existing abort/grace window. Tasks that acknowledge become `cancelled`
(`mission-deadline`) with unknown usage for the aborted call; tasks that do not
become `unknown`/`execution-unknown` and the mission `recovering`, as before.
Exhaustion alone yields a terminal `failed` mission plus `budgetExhausted`; it is
not unresolved execution and does not quarantine connections.

**Persistence.** `commitEvent(event, result?, accounting?)` passes the current
usage, per-task usage and exhaustion reason at every acknowledgement. The host
commits them in the same checkpoint as the event (ADR 0013/0014), so the
accounting that preceded each provider/tool effect is durable before it starts.
Completed turns journal reported counts as `turn.completed.usage`
(`inputTokens`/`outputTokens` integers only; no prose, cost or estimate). New
`turn.failed` codes: `budget-exhausted`, `usage-unknown`, `mission-deadline`.
Retained records gain optional `budget`, `usage`, `budgetExhausted` and task
`usage`, strictly validated on load and now also before each saved write.
Restart recovery marks previously assigned/running tasks' usage unknown and
recomputes the totals; nothing is replayed. History-off missions keep the same
data in RAM only.

**Cost.** No user-overridable versioned price table exists in this repository,
so no cost is computed or displayed. `maxCostUsd`/`spentCostUsd` remain 0 and
are not enforced. A future price table must be versioned, user-overridable and
every derived number labelled an estimate.

The Missions page offers optional limits in the plan editor and shows usage
against the budget, "unknown" when nothing was reported, a lower-bound note
when tasks were unreported, per-task usage and an exhaustion banner (EN/ID).

## Scope and limits

The token budget relies on adapters reporting usage. The OpenAI-compatible
streaming adapter does not request `stream_options.include_usage`, so many
servers report nothing and a mission token budget then stops as `usage-unknown`.
Changing adapter requests is FR-04 work. Budgets are per mission: no workspace,
daily or provider-wide spending ledger, no retry budget, no lease or reaper.
Adapter-internal retries consume tokens that the adapter may not surface.

## Validation and rollback

Tests use scripted providers/fetches, temporary profiles and SQLite: AC-08
admission blocking with running work intact, refusal at the next call, per-task
limits, fail-closed unknown usage, deadline cancellation (cooperative and
abort-ignoring), restart recovery, strict normalization/write validation and UI
helpers. No SQL schema change: the database stays at version 2.

Rollback: older v0.0.46 binaries reject records or events that contain the new
fields and fail closed at startup. Do not strip fields, edit the database or
delete unresolved records to start an older binary. Reverting only the UI is
safe; reverting the host requires a forward-compatible decoder first.
