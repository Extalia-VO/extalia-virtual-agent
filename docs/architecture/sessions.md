# Sessions and the session library

Profile, Workspace and Session are separate concepts (PRD §9–§11):

- A **Profile** is a user context such as Work or Personal.
- A **Workspace** is a project context inside a profile. It may point to a
  project location chosen by the user; Extalia never discovers it by scanning.
- A **Session** is a persistent work context. A workspace holds many sessions.

## Portable sessions

`extalia.session.v1` is the interchange format that every importer produces and
every export writes. It contains content (messages) and provenance (source id,
source session id, export time, optional provider and origin version). Local
organization never travels with it.

A session's identity is its **source key** `<sourceId>:<sourceSessionId>`.
Importing the same source session twice updates it instead of duplicating it.

## The library

`@extalia/core` keeps three kinds of data apart (PRD §39):

| Data | Changed by |
| --- | --- |
| Imported content and provenance | A newer import of the same source session |
| Local organization: rename, move to a workspace, archive, trash | The user only; imports never overwrite it |
| Exclusions (tombstones) | Trashing or deleting a **linked** session |

Rules:

- Import is previewed first; the preview always matches what is applied.
- One invalid session refuses the whole batch.
- Structured credential fields are refused; likely credentials inside message
  text are masked by default and counted in the preview.
- Imported text is inert: commands and code are stored, never executed.
- Deleting or trashing a session never touches the source. For linked
  sessions an exclusion stops the next sync from bringing it back; restoring
  from Trash removes the exclusion.
- Export writes portable sessions with credentials masked and without local
  organization.

## Native imports

`@extalia/importers` turns native histories into portable sessions: Codex
rollouts, Claude Code project transcripts (latest branch, subagent files
excluded), Hermes Agent `state.db` (each profile separately) and Gemini CLI
recordings. Antigravity conversations are detected but their binary format is
not readable yet. Parsers drop reasoning fields, mask credentials and keep tool
calls as inert text.

The host only looks in the known history locations (honoring `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` and `HERMES_HOME`), never searches the home folder, reads
files with size limits and symlink checks, opens SQLite databases read-only and
never writes to any source. A scan lists bounded metadata; previews and imports
refer to scan results by opaque ids that expire after 15 minutes.

The library lives in `state/library.json` in the user-data directory. A damaged
file is moved aside, never overwritten. A database replaces it later (PRD §44).

Managed sessions run by Extalia are stored separately: an append-only event log
and the model history per session in `sessions/`.
A connection can turn history off (`features.history: false`). Sessions
created on it live only in the host's memory (at most 4,000 events each) and
disappear when the host stops; nothing about them is written to disk. The
choice is made when a session is created, so turning history off never deletes
or stops saving older sessions, and turning it back on never writes earlier
unsaved turns.

## Continuing another agent's conversation

`continueSession({ kind: 'library' | 'observed', id }, workspaceId)` starts a
managed session from an imported or observed conversation, for example when
Codex or Claude Code ran out of quota. The source is never changed. Only user
and assistant text is carried over: the other agent's tool calls cannot be
replayed and their output is usually large and stale. The first request is
always kept because it states the task; the rest is filled from the most
recent messages backwards within about 60,000 characters (8,000 per message,
longer ones keep their start and end).

The carried messages become the new session's model history (merged into
alternating user and assistant turns) and appear in its event log on the
`import` channel with the source runtime, so Chat shows them between "Earlier
in …" and "Continued in Extalia" dividers. The system prompt tells the agent
where the conversation came from and to check the current files before relying
on the earlier work. In a Hermes Agent workspace, Hermes keeps its own history,
so the carried messages are sent to it as context with the first prompt instead
([runtime-adapters.md](runtime-adapters.md#hermes-agent-managed)).

## Continued sessions (observed)

An observed conversation is one office character (one observation record) for
as long as it is the same conversation. What each app does when the user
continues an earlier chat, checked read-only against local history (counts
only, no content):

| App | Continuation in the local history | How Extalia keeps one character |
| --- | --- | --- |
| Claude Code | 838 transcripts, each holding one session id that matches its file name. Two continuations seen: the new file has a new session id and starts with copies of the earlier rows (same message uuids and timestamps), then carries on. In one pair the earlier file ends with a `continued-in` row naming the new id. Subagent folders were not copied. | The first message uuid (the anchor) is shared by both files. The later file takes over the earlier record when the earlier file's last message is not after the later file's creation time. An earlier file read after its successor is a stale copy and is ignored. Two branches that both keep being written stay separate. |
| Codex | 65 rollouts, one thread id each. Resumed threads keep their id and file: 15 rollouts span over an hour inside one file with a single session meta. Forks seen are subagent threads (`thread_spawn`, `forked_from_id`), already mapped to their root session. | The same id is the same record (no change needed). Hook and transcript reports of one session share one record. |
| Gemini CLI | 19 recordings, one session id each; no shared ids, so no continuation was seen. | The same id is the same record. A continuation under a new id would stay separate. |
| Hermes Agent | `state.db` `parent_session_id` is set on 99 of 153 sessions: 94 subagent sessions and 5 `session_switch` children with the same model. The dashboard list does not expose the parent. | Not linked yet. A `session_switch` child stays a separate record. |

Rules for Claude Code (`observations.ts`, `continuation`): a record and a
native session with the same anchor are one conversation when
the earlier one's last message is at or before the later file's birth time
(macOS and Windows report it; without it nothing is linked). Discovery and
hook reports both apply it, and a hook-first session is taken over the same way.
Subagents keep their ids under the record, so their names stay stable while the
record lasts; a continuation folder holds only its own subagent files, so the
earlier file's subagents are not carried over.

The lead model shown for an observed character is the newest report by time
(not the last one written): hook payloads (their receipt time) and the
transcript's latest lead model event compete, and a re-read transcript window
with an older model never overwrites a newer hook model (`reportModel`). In the
office, `latestAgentModels` orders model-bearing events by event time, then
sequence, and copied history never counts.
