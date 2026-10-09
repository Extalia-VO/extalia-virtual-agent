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
