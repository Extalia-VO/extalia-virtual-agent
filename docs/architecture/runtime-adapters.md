# Runtimes, providers and observed agents

Extalia works with AI agents in two different ways. Both produce the same
[Extalia Protocol](protocol.md) events, so Chat, Console and the Office show
them the same way, but what Extalia is allowed to do differs.

| | **Managed sessions** | **Observed sessions** |
| --- | --- | --- |
| Who runs the agent | Extalia starts and drives it | The agent's own app (CLI, desktop app, IDE) |
| Examples | Extalia Native (any API key or router); Hermes Agent | Codex CLI/Desktop, Claude Code, Gemini CLI, Antigravity |
| Prompting from Extalia | Yes | Only through a verified source-bound native route, source queue or paired cooperative channel |
| Steer, pause, cancel | Where the runtime supports it | Only the exact actions advertised by the selected source/transport; no universal control |
| `session.started.control` | `managed` | `observed` |
| Event channel | `stream` | `transcript`, `hook`, `mcp` |

Unsupported actions are shown as unavailable, never emulated (PRD §16).

A workspace runtime/connection is the default for new managed sessions. Existing
sessions keep their recorded Hermes profile or Native connection. Session model
catalog requests and option validation resolve that saved target, rather than
adopting a later workspace default. Changing defaults does not rewrite history;
Chat offers an explicit new-session action when the targets differ. New Hermes
sessions capture an explicit workspace model in their options; legacy sessions
never inherit a model from a different Hermes profile.

## Runtimes are not providers

A **runtime** is the agent loop: it plans, calls tools, edits files and runs
commands. A **provider or router** only answers model requests. Hermes Agent is
a runtime. OpenAI, Anthropic, Google, Ollama, OpenRouter, 9Router, OmniRouter
and other OpenAI-compatible endpoints are providers or routers.

```text
Extalia ──► Runtime adapter ──► Runtime (e.g. Hermes Agent) ──► Provider / Router (e.g. 9Router)
```

A provider alone gives model completions, not an agent with tools. When the
user only has an API key or a router, Extalia's own runtime, **Extalia Native**,
supplies the agent loop and scoped read, search, write and edit tools. Native
terminal commands remain unavailable until a verified workspace-isolated executor
exists; file tools remain subject to workspace permissions ([ADR 0005](../adr/0005-extalia-native-runtime.md)). External
runtimes such as Hermes Agent keep their own loop and are connected through
adapters.

Native team members may use different saved provider connections and model
fallback chains under explicit user-defined grants. The host routes and guards
those connections; views consume team configuration and protocol events.
See [ADR 0058](../adr/0058-native-team-connection-authority.md) and the
[Native teams guide](../getting-started/native-teams.md). This capability does
not extend an external runtime's delegation contract.

### Memory and skills

Runtimes and some routers bring their own memory and skills (Hermes Agent;
OmniRoute). To avoid two systems injecting overlapping context, every
connection names one owner for each: Extalia, the provider (only where it has
them), or off. With OmniRoute and Extalia memory, Extalia sends
`x-omniroute-no-memory: true`. Extalia's memory is per workspace and stored in
the user-data directory; skills are `SKILL.md` files (built-in, user-wide, or in
the project's `.extalia/skills/`).

### Managed runtime adapter responsibilities

Connect and disconnect, report capabilities, create or resume a session where
supported, submit prompts, stream output, normalize tool, command, file, task
and subagent activity into protocol events, pause/cancel/steer where supported,
and report errors. Adapters never leak native payloads past the protocol. The
Hermes Agent adapter keeps its pure stream mapping in `packages/runtime` and its
process handling in `packages/host`; later adapters may get their own
`packages/adapter-<runtime>`.

### Hermes Agent (managed)

Each workspace chooses its agent runtime. **Extalia Native** is the default and
needs a model connection. **Hermes Agent** needs a Hermes profile (`default`
unless chosen) and optionally a model; it needs no connection because Hermes
brings its own providers, tools, memory and skills. Extalia offers Hermes when
the host finds the `hermes` command: `EXTALIA_HERMES_BIN` (a full path) or
`hermes` on `PATH`, located without running a shell. Profiles are `default` plus
the directory names under `$HERMES_HOME/profiles` (`~/.hermes` by default);
nothing inside a profile is read.

Every prompt starts one Hermes process in the workspace folder, without a shell:

```text
hermes -p <profile> chat --query-file - --oneshot --format stream-json \
  --source extalia --in <folder> [--resume <hermes-session>] [--model=<model>] [--yolo]
```

- The prompt is written to stdin. The environment is reduced to `PATH`, `HOME`,
  locale, temporary-folder, `HERMES_HOME` and XDG variables (plus the Windows
  system variables); Extalia's own settings and secrets are never passed on.
  Hermes reads its credentials from its profile, so provider keys that exist
  only in a shell are not visible to it.
- Hermes' JSON lines map to protocol events: `system/init` gives the model and
  the Hermes session id (never a second `session.started`); `text` becomes
  `model.delta`; `tool_use` becomes `agent.state: working` and `tool.started`;
  `tool_result` becomes `file.written` (from `files_created`, `files_modified`,
  `files_deleted`) and `tool.completed` (redacted, at most 4,000 characters);
  `result` becomes `model.completed`. When the process exits, the host emits
  `turn.completed` with token usage, or `turn.failed` with Hermes' error and the
  end of its stderr, then `agent.state: idle`. The host assigns event ids and
  sequence numbers; events carry `source.runtime: hermes` on the `stream`
  channel. Other output lines are ignored.
- The Hermes session id is saved with the Extalia session once Hermes has worked
  on it, and later prompts pass `--resume`. A session keeps the Hermes profile it
  was created with.
- **Stop** sends SIGTERM (Hermes interrupts its running tools) and kills the
  process group after 3 seconds. Closing Desktop or the Bridge stops running
  Hermes processes the same way.
- **Continue in Extalia** into a Hermes workspace sends the carried conversation
  to Hermes as context with the first prompt.

Approvals work differently from Extalia Native. Hermes runs its own tools, so
Extalia cannot show an approval card before each action. Without a terminal,
Hermes answers its own approval prompts with `approvals.single_query_mode`
(default `deny`): a command Hermes considers dangerous is refused at once and
the agent looks for another way. Hermes does not hold ordinary file edits for
approval. Extalia passes `--yolo` only when the workspace allows both file
edits and commands without asking; with any **Ask** setting, Hermes' approvals
are never bypassed. The workspace form states this next to the Hermes settings.

Not available for Hermes sessions: steering or pausing a running turn,
answering Hermes' approval prompts from Extalia, Hermes' reasoning text, and
separate cards for Hermes subagents (they appear as tool calls). Deleting an
Extalia session leaves Hermes' own copy in its profile. On Windows the command
must be an executable (`hermes.exe`), since no shell runs `.cmd` wrappers. The
stream format was verified against Hermes Agent 0.21; other versions may differ.

## Observed agents

An observed agent keeps running exactly as before; Extalia watches. There are
three observation channels, used together where available:

1. **Transcript reading** (`transcript`, read-only). Most agent apps already
   write their sessions to disk. Extalia reads selected files, never writes them,
   and checks periodically for changes while open. No change to the agent's configuration
   is needed. Formats are version-specific, so each parser declares which
   versions it was verified against and reports anything else as unsupported.
2. **Hooks and plugins** (`hook`, opt-in one-time setup). Where an app supports
   lifecycle hooks or plugins, `extalia connect <app>` installs a small
   forwarder after showing the planned change and getting the user's approval.
   It backs up the app's configuration, keeps the user's existing hooks, never
   blocks or steers the agent, and `extalia disconnect <app>` removes it.
   Hooks give real-time events that transcripts cannot (for example a command
   starting before its output is written).
3. **MCP tools and instructions** (`mcp`, optional integration). The adapter exposes MCP tools
   that let an agent report intent, progress and hand-offs, plus a short
   instruction (skill or project instruction file) asking it to do so. This
   adds meaning, but it is best-effort: the model may skip it and it costs
   tokens. It never replaces channels 1 and 2 as the source of truth.

Office history loading is scoped to the host and session. Adding or removing a
watched session preserves the histories and pending reads of the others; changing
hosts discards that cache. A busy sibling's recent-event window also retains a
bounded roster of quiet agents' latest activity and terminal evidence. Source
timestamps remain unchanged, so retaining a report does not renew its liveness.
When events have no sequence number and share a timestamp, their delivery order
is preserved; opaque event IDs are not a causal clock.

Receiving a hook does not permanently disable transcript catch-up. Newer source
events that hooks did not report can reach the live observation stream, with
actor-scoped deduplication and the same authority rules on history reload.
Older transcript states cannot replace a newer hook report. Explicit stop/end
reports and user pauses remain authoritative. This is evidence-based catch-up,
not a heartbeat: silence from both channels cannot prove that an outside process
is still working.

### Why not "just one prompt"

A prompt only affects the session it is typed into, the model may ignore or
forget it, and an agent editing its own configuration is neither reliable nor
reviewable. Persistent hook connection is managed by Extalia itself through
`extalia connect`, which is deterministic, shows a dry run first, and can be
undone. A copy-paste setup prompt may be offered later as a convenience, but it
only asks the agent to run `extalia connect <app> --dry-run` and show the
result to the user; it does not replace the command.

### Live transcript observation available today

Choose **Observe agent apps** during first-run setup, or switch workflows in Settings.
The Observe page opens on **Sessions**. **Agent apps** contains connection setup,
and **Settings** contains automatic watching and ignored folders. Switching these
tabs preserves the selected session and unsaved form drafts while the page is open.
This path needs no model connection, API key or registered workspace. Open **Choose native
sessions**, scan known sources, preview the selected conversations, then **Watch selected
live**. Extalia watches up to ten selected transcripts (5000 messages / 5 MB each). Pause,
resume, rename or delete the Extalia observation independently of the native conversation.
Watching resumes at launch unless it was paused. Native tool text stays inert.

Idle polls inspect file metadata and Hermes database/WAL metadata before parsing. Changes
and rewinds replace the normalized snapshot and emit `session.updated` through the same
protocol used by managed sessions. Polls do not pile up behind a slow disk. Source paths
and database sidecars are revalidated on each poll, and an unavailable source retains the
last readable snapshot. These parsers are covered with synthetic fixtures; live native
format compatibility depends on the installed agent version.

Transcript observation does not prove an agent is currently running, waiting for permission,
or successful. It displays what the source saved. Installed notification hooks add live lifecycle
evidence; optional MCP reports add intent and handoff labels. Neither notification
channel can answer external questions or grant external approvals. A separately
reviewed synchronous permission hook is described in ADR 0063.

### Changed files

The **Files** tab in a conversation or Office character panel lists that session's
reported writes. The main **Files** page remains a workspace folder browser.

| Source | File evidence consumed |
| --- | --- |
| Extalia Native | Actual tool outcome files, including reported partial writes |
| Managed Hermes | Structured `files_created`, `files_modified`, `files_deleted` and successful `resolved_path` results |
| Codex | Completed `apply_patch` envelopes with add/update/delete/move paths |
| Claude Code | Successful Write, Edit, MultiEdit and notebook edit calls with explicit paths |
| Gemini CLI | Successful write_file/replace results with explicit paths |
| Antigravity | Successful write_to_file and replacement calls; hooks can recover arguments from the matching pre-tool event |
| Observed Hermes | Successful known edit calls and structured file lists in their results |

Hooks and transcripts share bounded extraction; transcript calls retain file candidates
without retaining raw arguments in activity steps. Candidates become writes only after
successful results. Relative paths retain their directories; external absolute paths
are not collapsed to basenames. Unknown create/update distinctions remain `update`.
Moves are represented as deleting the old path and adding the new path.

Optional `file.written.toolCallId` ties evidence to its source tool and agent. This
prevents hook/transcript replay duplicates. Files tabs consume explicit write events;
short tool targets alone never establish a file change. Pending, failed and read calls do
not become inferred writes. Explicit managed outcome files remain evidence even
when the overall operation fails after a partial write.

Coverage depends on the source format. Arbitrary terminal/script changes and edits
hidden inside wrapper tools are not inferred from code, output prose or Git status.
An empty list means no recognized write evidence, not proof that the disk is unchanged.
No new hooks or external configuration are installed by this projection.

### Taking over an observed session

Observed sessions are read-only by default. [Observed Codex control](../getting-started/observed-codex-control.md)
is an explicit exception for a verified existing-server Unix socket: send to the
same native thread and answer newly received native questions. It does not start
an engine or use private Desktop IPC. [ADR 0061](../adr/0061-observed-reply-channels.md)
also permits conditional same-owner Hermes gateway control and manually paired
cooperative tool replies. Cooperative replies return through an explicit live
tool call; they do not establish native app identity, wake an idle agent or
answer another native tool's pending question. See the [source capability matrix](../getting-started/observed-replies.md).
To continue the work in a separate Extalia-managed session,
use **Continue in Extalia** (`continueSession`), available for imported and
observed conversations: it starts a new managed session (Extalia Native or
Hermes Agent) seeded with the recent conversation and leaves the source
unchanged (PRD §14.4; see [sessions.md](sessions.md#continuing-another-agents-conversation)).
Attaching a runtime to the original session itself is only possible where the
original app offers a safe, documented resume mechanism.

## Status

| Integration | Mode | Status in this repository |
| --- | --- | --- |
| Extalia Native: OpenAI, Anthropic, OpenRouter, 9Router, OmniRoute, Ollama, custom OpenAI-compatible | Managed | Available (Desktop and the `extalia` Bridge) |
| Hermes Agent | Managed | Available (Desktop and the `extalia` Bridge): one `hermes` process per prompt, streamed into Chat, with resume and stop; Hermes' own approval rules apply (see above) |
| Codex 0.167.0 synchronous PermissionRequest hook | Observed, approved scoped setup | Full pending payload, explicit one-use shell decision through original callback; trust/manual Desktop activation pending. Separate request_permissions tool not covered; ADR0063 |
| Codex CLI 0.167.0 public queue | Observed, saved opt-in | Exact original UUID/profile queue messages; no resume or new agent session. Durable intent and receipt metadata, no automatic resend; waits for active turn completion |
| Codex app-server 0.167.0 with an explicitly exposed original-server Unix socket | Observed, opt-in control | Same-thread steering, native questions and explicit native command/file/turn-scoped permission decisions under ADR0062; no persistent grant or private Desktop IPC |
| Codex, Claude Code, Hermes Agent, Gemini CLI, Antigravity | Observed transcript | Available: selected read-only transcripts, metadata polling and pause/resume; fixture-validated formats |
| Codex, Claude Code, Gemini CLI, Antigravity; Hermes outbound webhooks | Observed hooks | Available: explicit reversible setup through `extalia connect`, dry run, backups and disconnect; version-specific source support |
| Supported shell/MCP agent clients | Cooperative tool replies | Explicit one-use channel through `extalia reply` or `await_reply`, returning to the original held tool call; manual source pairing required |
| Hermes gateway with public discover-only attach command | Conditional observed native control | Exact owner/session/generation attachment and explicit replies; inspected older CLI lacks this command and remains unavailable |
| Supported agent apps | Observed MCP reports | Available through `extalia mcp`: intent and handoff reports; separate opt-in `await_reply` tool |
| Codex, Claude Code, Hermes, Gemini CLI, Antigravity history | Import (read-only) | Available: scan, preview and import into the library; recognized textual formats only |

See the [migration ledger](../migration/ledger.md) for what is reused from the
prototypes and [ADR 0004](../adr/0004-managed-and-observed-sessions.md) for the
decision record.
