# ADR 0012: Planner admission and retained mission graphs

Status: Accepted (2026-10-18)

## Context

The Missions page can launch and monitor read-only graphs (ADRs 0008–0011), but
lead planning previously had no lifecycle reservation. Concurrent plans or a
prompt could use the same session/connection during the model call. A timeout
signal also depends on the provider acknowledging abort. Separately, retained
mission tasks lacked dependencies, so the monitor lost the graph after reload.

## Decision

Planning uses the existing host lifecycle admission without creating a mission:

- Reserve the session before asynchronous preparation, and reserve the lead
  connection before credential/catalog work or inference. Recheck shared guards at admission;
  prompts, mission starts, other planners and policy edits use the same guards.
- Use the host cancellation controller and a bounded 45-second lead-call wait
  (credential acquisition plus inference, after candidate discovery). Cancelling
  or timing out that call returns a labelled deterministic fallback;
  it never launches tasks. Do not accept a late model reply as a current plan.
- If preparation or provider completion is still pending after cancellation,
  retain its reservation until that underlying work settles. A returned
  fallback is not proof that provider execution stopped. Check cancellation
  before calling the provider after asynchronous preparation.
- The existing shutdown bound still applies. Planning reservations are volatile,
  with no persisted planner quarantine or restart-reconciliation guarantee.
  Candidate model discovery retains the existing four-second abort signal and
  cache; cancellation during discovery is reported as a preparation error after
  the lookup settles. A catalog provider that ignores abort can keep that API
  request pending. Planning has no tools, mission records or conversation events.
  No durable scheduler, token/cost budget or scoped action approval is implied.

Retain graph edges in the existing bounded result sidecar:

- Add optional `HostMissionTask.dependsOn`, containing sibling task aliases.
  New missions copy every edge array, including explicit `[]` for root tasks.
  State updates, saved history and restart recovery preserve these arrays.
- Keep `extalia.native-missions.v1` additive for the current reader. Validate
  aliases, known references, bounds, duplicate/self edges and cycles. Legacy
  tasks with no field stay graph-unknown; they are never rewritten as roots.
- The monitor prefers complete retained edges. A bounded in-memory submitted
  plan supports older hosts only when its task set matches the run. Otherwise
  display graph unavailable and continue showing task states/results.
- No instructions, credentials or endpoints are added to retained metadata.
  Existing privacy, retention limits and unknown-execution quarantine apply.

## Consequences

Reopening a new mission can reproduce its dependency view, but this sidecar is
still metadata, not a canonical transactional event journal. Strict older host
readers can reject the added task field: retain the updated decoder if rolling
back the UI/admission change. No automatic downgrade migration is supplied.
Legacy omissions remain explicit. Answers remain unverified.

Tests use controlled provider promises and temporary profiles to cover admission,
cancellation/timeout, ignored abort, graph roundtrip and malformed graphs. Mock
UI checks establish display behavior, not live-provider quality or performance.
Durable leases, reconciliation and budgets need subsequent ADRs and acceptance.
