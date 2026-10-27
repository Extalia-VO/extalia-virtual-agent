# ADR 0014: Atomic native mission events and execution acknowledgement

Status: Accepted (2026-10-18)

## Context

ADR 0013 durably stores mission checkpoints but leaves intermediate transitions
in RAM. Its change cursor is not a task/tool event sequence. The runtime's
best-effort observer cannot guarantee that a transition is committed before a
provider or read-only tool runs. Stage 3 needs an explicit acknowledgement
boundary while preserving history-off privacy and truthful restart behavior.

## Decision

Schema 2 adds a native mission metadata-event journal to the same SQLite store.
Validate schema 1 before migrating, and add the schema/version in a transaction;
retain checkpoint revisions and existing global change cursors.

`writeSession` can commit one validated `AgentEvent` with its corresponding
checkpoint in the same transaction. Assign a per-mission sequence starting at 1
inside the transaction; ignore the caller's run-local sequence. A duplicate event
ID with identical normalized event and associated snapshot returns the original
acknowledgement without rewinding state. Conflicting reuse fails atomically.
Checkpoint retention cascades to events only when terminal runs are pruned.
Reads are bounded and paginated; control events are capped at 4 KiB each,
8,192 per run and 8 MiB of encoded event data per session. Existing checkpoint
and change caps still apply. Capacity exhaustion is a storage failure, not an
excuse to drop uncommitted records and continue execution.

Only native control metadata is accepted: mission/task states and assignment,
agent states, named read/search tool starts/completions, and bounded turn outcome
codes. Reject model prose, tool arguments/results, credentials, arbitrary labels
and raw errors. Validate mission/task/agent ownership and stable native UUID
bindings. Task/mission state events must match the supplied snapshot. Terminal
task state commits include the sanitized result snapshot, so a completed mission
cannot become visible before its retained answers exist. Answers are unverified.

The runtime gains synchronous `commitEvent(event, result?) → sequence`, distinct
from observational `onEvent`. Commit before adding an event to the returned list,
notifying observers, or returning to the provider/tool call boundary. Reject
invalid/non-monotonic/promise acknowledgements. The host supplies SQLite's
acknowledgement for saved runs and an equivalently bounded, validated RAM journal
for transient runs. No temporary database is used for history-off data.

A commit failure latches mission-wide: suppress further unacknowledged events,
stop queued admission, abort active controllers and wait the existing bounded
acknowledgement window. Work that might have started becomes unknown; tasks
blocked before execution stay blocked. Return recovering with a generic
persistence-failure reason, never a raw storage error. Abort-ignoring calls
retain unknown capacity; late events/results cannot replace the outcome.
Ordinary observer errors remain best-effort and do not become execution gates.

## Authority, recovery and limits

SQLite is authoritative for these native v1 control events and associated task
snapshots. Existing v0 JSONL events remain a derived compatibility projection for
mission runtime activity; ordinary conversation/observed-session events retain
their existing authority. The projection is not atomic with SQLite and may have
missing segments after interruption. No repair, cross-session canonical replay,
or new public journal endpoint is claimed by this increment.

Older imported/migrated runs can have no native events. Marking running work as
recovering/unknown on startup remains a conservative checkpoint operation; never
synthesize past actions or replay a provider/tool. A recovery checkpoint can
therefore differ from the last execution event. Consumers must not infer that
absent events mean no work ran.

These are persisted start markers for the current read-only loop, not permission
approval, tool parameter digests, a provider request receipt, or idempotency keys.
Adapter-internal retry behavior is inherited, and a start marker is not proof a
remote request actually ran. Leases/reaper, scoped action approval, reconciliation,
write-capable effects, budget enforcement and full AC-04 certification remain
separate decisions. Synchronous storage latency and worker-thread ownership need
measurement before claiming performance gains.

## Validation and downgrade

Use temporary profiles, scripted providers/tools and injected SQL failures to
prove no effect begins after a failed prerequisite commit, event/checkpoint
rollback is atomic, siblings/queued work stop, and late outcomes are suppressed.
Verify schema-1 migration, idempotency/conflicts, sequence/ownership validation,
retention and RAM-only history-off operation.

Schema-1 binaries reject schema 2. No automatic downgrade is supplied. Preserve
the database and unresolved state; do not edit its version or fall back to stale
sidecars. Reverting the renderer alone does not change journal ownership.

## Amendment (2026-10-21): asynchronous acknowledgement

Status: Accepted (2026-10-21). Required by ADR 0020 (stdio sidecar daemon) and
ADR 0021 (strangler migration with parity suites): once the store lives across a
process boundary its acknowledgement is necessarily asynchronous, and no effect
may depend on the daemon before the runtime can wait for it.

The synchronous `commitEvent` stays the default and is unchanged, including the
rejection of promise acknowledgements. The runtime adds an opt-in, mutually
exclusive `commitEventAsync(event, result?, accounting?) → Promise<sequence>` with
the same arguments and the same acknowledgement rules:

- **Order.** At most one commit is in flight per mission. Events are dispatched in
  emission order, and the next one only after the previous acknowledgement was
  validated. Pipelining is not allowed by this amendment.
- **Gate.** Provider calls, read-tool code (including prechecks), a task's turn
  (after its `task.assigned`/`running` events), the release of a finished task to
  its dependents and the final mission result wait until every earlier queued event
  is acknowledged. An event enters the returned list and reaches observers only
  after its acknowledgement. Accounting is captured when the event is emitted.
- **Failure.** A rejected or synchronously thrown commit, an acknowledgement after
  the bounded deadline (`commitDeadlineMs`, default 5 s, maximum 60 s), or one that
  is not a safe integer greater than the last acknowledged sequence latches the
  mission exactly as above: siblings are aborted, queued admission stops, work that
  might have started becomes unknown and the run returns recovering with the
  generic persistence-failure reason.
- **No replay.** Events queued behind a failed commit are dropped, never
  dispatched. A late acknowledgement is ignored and cannot revive the run or append
  events.
- **Cancellation.** An abort releases a waiting effect without running it; the
  pending commit itself is still bounded by the deadline.

Commit latency counts against task timeouts and the mission duration budget.
Duplicate-event idempotency and the 4 KiB / 8,192 / 8 MiB caps remain the store's
obligation on either path. The host keeps using the synchronous path until the
daemon client (behind its feature flag) supplies an asynchronous sink.
