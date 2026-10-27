# ADR 0011: Mission launch, plan review and monitoring UI

Status: Accepted (2026-10-17); retained-DAG decision amended by [ADR 0012](0012-mission-planning-admission-and-retained-graphs.md) (2026-10-18)

## Context

Stage 2 has a read-only mission kernel (ADR 0008), host API (ADR 0009) and lead
planning (ADR 0010), but no product surface. The PRD asks for a Missions page with
a dependency view and status, without invented progress, and requires that
model answers are never presented as verified work. Chat and the 3D Office stay
as they are.

## Decision

Add a **Missions** page (`apps/web/src/missions/`) with a sidebar item (shown
when a workspace exists) and entry links from the Office session dialog (managed
Extalia Native leads only) and the Office activity board.

- **Eligibility.** Only managed Extalia Native sessions in a native workspace with
  a project folder can launch. Observed and Hermes Agent sessions are counted and
  explained, never offered. A session that is busy with a turn is marked and
  explained, and the default choice is an idle session. The host stays the
  authority and rejects the same cases.
- **Launch.** The user enters a goal, the allowed connections (the workspace's
  primary connection and its mission allowlist), an optional model allow-list and
  a maximum number of tasks. The allowlist can be widened in place through
  `setWorkspaceMissionConnections`, with an explicit Save. Credential-missing and
  history-off connections are labelled. "Plan with lead" calls
  `planNativeMission`. This is feature-detected because an older preload may lack
  it. "Write the plan myself" always works. Planning starts nothing.
- **Plan review.** The plan is editable data. A DAG view arranges tasks in
  dependency columns, with SVG connectors measured from the cards. Columns stack
  on narrow screens and connectors then run in a left gutter. The connectors are
  decorative: every card also says in text what it waits for. One task is
  edited at a time: title, alias (a rename rewrites dependents), role,
  instructions, connection (limited to allowed connections), model (a ComboBox
  whose allowed set is the connection's configured/tier models, the primary's
  catalog and the pairs the lead planned), dependency chips, time limit (seconds)
  and steps. Validation is inline and per field: cycles, missing and self
  dependencies, duplicate or invalid aliases, bounds and disallowed pairs. As a
  final check the host's `normalizeHostMissionRequest` runs. Launch is disabled
  while any problem exists. `role` and `rationale` stay in the page and are never
  sent.
- **Monitor.** The page polls `nativeMissionRun` every 1.5 s (6 s when hidden)
  while running, and restarts at once on a new session event that carries the
  mission's `correlationId`. It stops at a terminal state. Progress is the text
  "N of M tasks completed" plus running and failed counts. It is never a
  percentage. "Answers unverified" shows while no evidence is attached, which is
  always the case today. Every answer renders as Markdown under an "Unverified
  model answer" badge. Failure reasons map the kernel's reason codes to plain
  text. `unknown` and `recovering` are explained as not replayed and needing
  reconciliation. Each task shows its worker identity (short agent id, full id
  as a tooltip), connection/provider and exact model.
- **Cancel** uses the existing session `cancel` after an inline confirmation. No
  new cancel API is added.
- **DAG for runs.** New host records retain alias dependencies for every task.
  The monitor prefers these edges, so reopening a run retains its graph. An
  in-memory map of at most 32 submitted requests supports older hosts. Legacy
  runs with no complete graph or matching cached request show an explanation
  and the task list; missing edges are never invented (ADR 0012).

## Consequences

- This UI adds no host method, permission or tool. Missions stay read-only;
  the later host metadata extension is described in ADR 0012.
  The renderer never sees credentials or endpoints.
- The run state shown is whatever the host projected; the UI does not compute or
  smooth progress.
- Reopened new runs use retained `dependsOn` metadata; legacy graph omissions
  remain unknown. Task results stay available regardless of graph availability.
- Strings live in `i18n.ts` (EN/ID). Styles are in the `v0.0.43 missions` block,
  using theme tokens plus overrides for Liquid Glass / Pro.

## Not decided here

Reconciliation UI for `unknown`/`recovering`, evidence linking, approvals,
budgets, mission replay and Office avatar projection of mission workers remain
later stages.
