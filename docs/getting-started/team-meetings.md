# Team meetings and profile vaults

For reusable lessons after work, see [automatic learning](automatic-learning.md).
That separate profile policy does not require a meeting or repeated prompt.

Native teams can hold a real discussion before work. Enable a configured team,
approve its connections and models, then ask the lead to discuss a focused
question. The lead uses `conduct_team_meeting` for an explicit meeting request
or a planning/decision discussion that needs the team's perspectives. Ordinary
delegation, editing a Markdown file, or mentioning a meeting does not start one.

The tool admits one meeting per lead turn, with one to thirteen selected team
members plus the lead. Room A has ten seats and room B fourteen. Participants
use their approved model chains and read tools only, even when they normally
have edit access. They contribute in two bounded rounds; round two receives the
actual first-round findings. The lead then synthesizes the returned discussion.
This is discussion evidence, not proof of subsequent implementation or accepted
decisions.

## Events and the Office

`meeting.started` carries a stable meeting ID, same-session participant agent
IDs, topic and optional room. Attributed `meeting.contribution` events record
the actual round and text. `meeting.completed` closes the meeting with a
completed, cancelled or failed outcome and an optional exported note path.
Native persists the start before invoking participant providers and waits for
entered workers to settle before finalization. Cancellation alone is not a
worker-settlement receipt.

The Office consumes these events for both managed and observed sessions. It
routes valid participant groups to distinct meeting chairs, shows their topic
and round, uses discussion/listening poses and returns them to their reserved
desks after the meeting. Unknown participants, overflowing groups and occupied
requested rooms are not assigned overlapping meeting chairs. Ordinary work
continues to use workstations.

## One vault per workspace profile

In **Settings → Storage**, create or edit the workspace vault profiles and
assign workspaces to them. Each workspace belongs to one profile; multiple
workspaces can share that profile's one vault. Vault roots must be separate
across profiles. This groups workspace vault destinations inside the current
Extalia installation; it does not create separate application instances or
move existing sessions, credentials or notes.

The original profile keeps its existing Knowledge vault. New managed profile
vaults live under the current Extalia data folder at `vaults/<profile-id>`;
you can instead select an existing external folder. These are plain Markdown
folders compatible with Obsidian. Extalia does not modify `.obsidian` settings.

Enable meeting-minute exports for a destination explicitly. The owned default
vault permits them by default; an existing external indexed vault requires an
explicit opt-in bound to that selected root. Changes are refused during active
agent work and stale configuration revisions must be refreshed. Picking a
destination grants no model access to read its contents or edit unrelated files.
If it overlaps a registered workspace, workspace write restrictions still apply.

Saved Native meetings export actual contributions under
`Meetings/<workspace-id>/<meeting-id>.md`, with profile, workspace, session and
outcome metadata. A pinned binding prevents a running meeting from silently
switching destinations. Exports never overwrite a different existing note.
History-off sessions keep their discussion in memory and do not export durable
minutes. Export failure is reported separately from the discussion outcome.

The existing Knowledge page continues to index the original selected vault.
Additional profile vaults are explicit Obsidian/minutes destinations; they are
not silently attached to that running index or added to model context.

## Observed applications and hooks

An observed application must explicitly report its meeting. Its ordinary vendor
hooks cannot establish a meeting just because a prompt or tool mentions one.
The optional Extalia MCP server exposes `report_meeting` with these phases:

| Phase | Required meeting fields |
| --- | --- |
| `start` | `meeting_id`, `participants` (known raw agent IDs); optional `room_id`, `topic` |
| `contribution` | `meeting_id`, `agent_id`, `round` (1 or 2), `text` |
| `complete` | `meeting_id`, `outcome`; optional reported `note_path` |

Use the exact source `session_id` when reporting through MCP. Announce real
subagents through the source's supported lifecycle reports before listing them
as participants. Only the original reporter can complete its active meeting;
foreign sessions, unknown participants and replayed reports are ignored. A
reported note path is source-reported metadata, not proof that Extalia exported
that external agent's note. Automatic profile minutes described above apply to
saved Native meetings.

Authenticated hooks can send the same explicit `report_meeting` payload using
`tool_input`, or the supported top-level report fields. This reuses the existing
hook authentication and source-session binding. Labels-only observation drops
topic, contribution and artifact content while retaining appropriate lifecycle
state. Source failure/end closes the displayed meeting without inventing a
successful discussion.

No application configuration is installed by this feature. Existing connection
setup still requires its documented preview, user review and undo procedure.
