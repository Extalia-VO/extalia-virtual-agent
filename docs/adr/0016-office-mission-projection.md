# ADR 0016: Office projection of native mission workers

Status: Accepted (2026-10-18)

## Context

Native missions (ADRs 0009–0014) project their runtime activity into the
session's v0 event log with `correlationId` = mission id: the lead announces each
worker (`subagent.spawned` with role `read-only-worker`, label = task title,
model) followed by its `task.created`; workers report `task.assigned`,
`agent.state` and read/search `tool.*`; each task ends with `task.completed`
plus an `agent.state` that distinguishes failed, cancelled, blocked and unknown.
The Office treated these like any managed subagent: every worker was shown
working from its spawn (fake work while queued), never left after finishing,
and unknown work looked like an ordinary blocked or ready agent. PRD FR-09 and
AC-12/AC-13 require truthful positions and states, semantic bubbles and bounded
avatar admission.

## Decision

A pure fold (`apps/web/src/office/missionPresence.ts`) derives per-worker
mission state from correlated events only; it never reads instructions or
answers. The retained record (`listNativeMissions`, read by
`useOfficeMissions` after mission lifecycle events, coalesced per session) adds
the mission title, the task's connection display name and exact reason code, and
is authoritative for terminal and unknown task states. Events stay authoritative
for live progress. The projection is read-only: no runtime, host or mission
storage change.

| Task state | Presence | 3D office | Board label | KPI bucket |
| --- | --- | --- | --- | --- |
| queued | `idle` + `mission.state=queued` | not admitted (no avatar, no desk) | Queued | not counted |
| running (assigned/working) | its own reported state, else thinking | admitted through the spawn queue, seated by the existing seating policy | Reading / Searching / Thinking | working |
| completed | Ready for the existing subagent linger, then offline → Earlier | stays seated, then walks out | Ready | idle (Ready) |
| failed | Ready with phase `error` for the linger, then leaves | as completed | Error · short reason | errors |
| cancelled | as completed (never-started: not admitted) | as completed | Ready (or Not started) | idle |
| blocked (never started) | idle for the linger, not admitted | none | Not started | not counted |
| unknown / recovering | `blocked` + `mission.state=unknown`; no linger | keeps a desk, no work animation (desk "wait" pose) | Unknown, warning tone | errors |

Unknown is never idle: a worker becomes unknown when the retained record says
so, when its run is `recovering` (a task still queued in a recovering run is
"Not started"), or when the mission ended or its session stopped while the
worker had not reported an end. Queued and never-started workers are listed
under their lead but are not "in the office": they are excluded from the
present count and KPIs (documented in the KPI hints).

Each worker gets a stable full name from `generateFullName(workerId, used)`
(unique within its session, lead and team names first) and a look seeded by that
name. Rows nest under the lead with the existing dashed tree lines and show the
task title as the task line, a "Mission · title" badge, connection · model and
the mapped state. A lead with mission workers gets a Missions icon link that
opens the Missions page for its session. The mission announcement bubble belongs
to the lead (hand-off), not to a worker that has not started; worker bubbles come
only from `tool.started` kinds (Reading a file…, Searching files…).

Avatars are admitted only when running, through the existing director spawn
queue (`ADMISSION_SPACING_MS` 340 ms, per-arrival-point spacing). Events are not
dropped: every announced worker stays on the board regardless of admission.
Sessions with workers still present keep their event history loaded after the
mission ends, so completed workers can linger and leave.

## Consequences and limits

- After an Office reload, a non-running session's history is loaded only when it
  is selected; unknown workers of an earlier recovering mission then appear only
  on selection or on the Missions page. Listing every session's missions on load
  was rejected for cost.
- The projection is not atomic with the SQLite journal (ADR 0014); missing
  segments resolve to unknown, never to idle or completed.
- A load with several running workers seats them at once (existing settle rule),
  which can cause a one-second frame-time spike; live arrivals are staggered.
- Reconciliation UI, evidence links and replay remain Mission Control work.
