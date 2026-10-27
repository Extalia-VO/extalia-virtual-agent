# ADR 0010: Accountable lead mission planning

Status: Accepted (2026-10-17)

## Context

Stage 2 can run a fixed, read-only native mission DAG (ADR 0008/0009), but the
user had to write every task, dependency and connection/model binding by hand.
The PRD asks for one accountable lead that splits a goal into heterogeneous
worker tasks (FR-02/FR-03). Planning must not widen authority: the kernel stays
read-only, nothing new is persisted and model output stays unverified.

## Decision

Add `planNativeMission(sessionId, { goal, maxTasks?, connectionIds?, models? })`
to `AgentHostApi` and its method allow-list. It returns a `MissionPlan`
(`title`, `tasks`, `maxConcurrency`, `source: 'model' | 'heuristic'`, `note?`,
`leadModel?`) and never launches task execution or records a mission.
[ADR 0012](0012-mission-planning-admission-and-retained-graphs.md) adds transient
session/lead-connection admission during the planning call. The user reviews
and edits the plan, then launches it through the unchanged `startNativeMission`.

- **Lead.** The session's own connection and model (session override first)
  are the lead. The host resolves its credential exactly as for a prompt; the
  renderer never receives it. One completion with no tools and a 45 s timeout.
  Tool calls in the reply are ignored. Hermes and observed sessions are refused.
- **Eligible pairs.** Workspace-allowed mission connections (primary plus the
  explicit `missionConnectionIds`), optionally narrowed by `connectionIds`.
  Each offers its configured model; the lead connection also offers the session
  override and the session team's models. `models` narrows the set and may add
  models the connection lists. History-off connections (for saved sessions) and
  connections with a missing credential are left out with a note. At most 24.
- **Prompt.** Workers are numbered (`worker: 2`) with model, connection display
  name and provider API. No endpoint, connection ID or credential is shown. The
  goal is redacted (common secret patterns plus the resolved lead credential).
  Team roles/tasks/models are hints. With two or more eligible connections the
  lead is asked to use at least two.
- **Strict parse.** A single JSON object (one code fence or reasoning block is
  tolerated, prose is not); unknown fields, unknown/non-integer workers, invalid
  or duplicate IDs (`^[a-z][a-z0-9_-]{0,63}$`), missing dependencies, cycles,
  oversized text (title 200, instructions 4,000, reply 64,000 characters) or more
  than `maxTasks` reject the whole reply. Echoed text is redacted. Planner-set
  defaults: 180 s timeout and 8 steps per task, concurrency = widest level (≤4).
  If the lead used one connection although two were eligible, one parallel task
  moves to another connection and the `note` says so. The result must pass
  `normalizeHostMissionRequest` and use only eligible pairs.
- **Fallback.** Any failure (no model, lead busy with mission work, provider
  error, timeout, unusable reply) returns a deterministic plan — survey →
  parallel analyses → synthesis, alternating connections, team roles as angles —
  with `source: 'heuristic'` and the reason in `note`.
- **Placement.** Pure helpers (`normalizeMissionPlanRequest`, `missionPlanPrompt`,
  `parseMissionPlanReply`, `heuristicMissionPlan`, `checkMissionPlan`,
  `missionPlanToRequest`, `missionTaskLevels`) live in `@extalia/platform`, so
  the renderer can validate edits and the mock host can plan without importing
  runtime code. The host only adds authorization, pair resolution and the call.

## Consequences

- No privileged tool, persistence format, event type or Hermes dependency is
  added. Planning creates no session events and no mission sidecar.
- The plan is advisory data; the launch path re-validates everything. Lead
  answers and worker answers remain unverified; no evidence is fabricated.
- A lead may still choose poorly within the eligible set; the user reviews.
  Live-provider plan quality, cost and latency are not certified.
- Model fit uses names and the lead's judgement, not a capability registry
  (FR-04 remains pending).
- The mock host plans with the deterministic helper (labelled, no model asked)
  and simulates task state changes with demo answers marked unverified.

Rollback: remove `planNativeMission` from the API/allow-list, `missionPlan.ts`
and its exports, the host method and tests, and the mock mission simulation.
No stored data needs migration.

See [native missions](../architecture/native-missions.md) and the
[continuation ledger](../product/native-orchestration-v1-handoff.md).
