# Chat teams and the Native prompt routine

Chat shows **Team / orchestrator** above the message composer. Open setup to
review roles, tasks, soul, models and permitted connections. The status describes
the saved setup, not how many workers are currently running.

- Before a session is created, setup and the switch edit the workspace default.
  New sessions copy that reviewed configuration explicitly.
- In an existing managed session, changes affect that session only. The setup
  dialog can separately save a workspace default for future sessions.
- Turning the switch off preserves members, model priorities and connection
  grants. Turn it on again to reuse the setup. An empty roster needs setup first.
- Changes during a running turn apply next turn. Stop the current turn separately
  if needed. A running model's roster changes cannot overwrite newer user settings.

Native uses the configured team on every subsequent prompt while it remains
active; it does not reset after the task. It delegates only work that fits the
members' roles, and can handle small requests itself. Each delegation names a
configured member. Without an active roster, Native runs solo: generic tier
settings cannot bypass an absent, paused or empty team. Models cannot enable,
clear or replace a paused setup behind the user's switch.

Observed chats are controlled by their source application and have no managed
team controls. Hermes receives a fresh team brief or explicit solo guidance on
each turn, including resumed conversations. Its runtime still controls its own
delegation tools; the Chat switch configures Extalia team instructions and does
not claim a verified Hermes tool-disable capability.

## Before a Native prompt

The host prepares bounded context without a separate model classifier call:

1. **Relevant skills:** when Extalia skill tools are enabled, deterministic
   English/Indonesian hints select categories and a small matching metadata
   preview: up to four built-ins and eight external references. The model reads
   a chosen body through `skill_read` only when needed. Full authorized discovery
   remains available through `skill_search` and `skill_list`; scanner and exact
   workspace-grant requirements remain mandatory for external skills.
2. **Relevant memory:** when enabled, rank this workspace's note names and short
   summaries against the composed prompt, including text imports. Offer at most
   four positive matches. Do not fill an unmatched preview with alphabetical
   notes. Metadata search and revision-bound reads remain available when needed.
3. **Compact briefs:** remove repeated background from internal task briefs and
   worker reports. Preserve constraints, conditions, numbers, paths and code.
   The user's full prompt and model history are not rewritten or compressed.
4. **Saved team:** use its active state and reviewed member policy. A setup check
   is not permission to spawn every member on every prompt or create a new team.

These are lexical hints, not semantic or exhaustive retrieval. Missing preview
matches do not prove the information is absent. Disabled/provider-owned memory
or skills are not silently replaced with Extalia tools. Worker tools remain
bounded by the selected connection, permissions and workspace folder authority.

The bundled **orchestrator** skill documents this routine and is available on
demand. Core team controls work without enabling that skill. **Caveman** is a
separate concise-reply style activated by an explicit user request; it never
removes detail the user needs, changes permissions or promises a saving
percentage. Automatic savings measures concern bounded context and short
briefs, not lossy editing of user messages. Normal task/tool loops may still
need multiple model requests; no paid-provider savings benchmark is claimed.

See [Native teams](native-teams.md), [built-in skills](builtin-skills.md),
[workspace memory](workspace-memory.md) and
[workspace folder boundaries](workspace-boundaries.md).

Implementation verified locally on v0.4.202: full `pnpm check` passed with
6,530 TypeScript tests, 23 optional tests skipped, 474 Rust tests and all builds.
Mock-browser checks covered persisted setup/toggles/reload, observed and Hermes
states, both languages, light/dark and desktop/phone layouts. No real profile
settings or paid-provider workloads were changed by verification.
