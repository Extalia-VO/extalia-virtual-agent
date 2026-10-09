# Runtimes, providers and observed agents

Extalia works with AI agents in two different ways. Both produce the same
[Extalia Protocol](protocol.md) events, so Chat, Console and the Office show
them the same way, but what Extalia is allowed to do differs.

| | **Managed sessions** | **Observed sessions** |
| --- | --- | --- |
| Who runs the agent | Extalia starts and drives it | The agent's own app (CLI, desktop app, IDE) |
| Examples | Extalia Native (any API key or router); Hermes Agent | Codex CLI/Desktop, Claude Code, Gemini CLI, Antigravity |
| Prompting from Extalia | Yes | No. Prompts are typed in the agent's own app |
| Steer, pause, cancel | Where the runtime supports it | No |
| `session.started.control` | `managed` | `observed` |
| Event channel | `stream` | `transcript`, `hook`, `mcp` |

Unsupported actions are shown as unavailable, never emulated (PRD §16).

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
supplies the agent loop and the tools (read, search, write and edit files; run
commands), all inside the workspace boundary and subject to the workspace
permissions ([ADR 0005](../adr/0005-extalia-native-runtime.md)). External
runtimes such as Hermes Agent keep their own loop and are connected through
adapters.

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
   and checks for changes every four seconds while open. No change to the agent's configuration
   is needed. Formats are version-specific, so each parser declares which
   versions it was verified against and reports anything else as unsupported.
2. **Hooks and plugins** (`hook`, planned one-time setup). Where an app supports
   lifecycle hooks or plugins, a future `extalia connect <app>` will install a small
   forwarder after showing the planned change and getting the user's approval.
   It backs up the app's configuration, keeps the user's existing hooks, never
   blocks or steers the agent, and `extalia disconnect <app>` removes it.
   Hooks give real-time events that transcripts cannot (for example a command
   starting before its output is written).
3. **MCP tools and instructions** (`mcp`, planned optional integration). The planned adapter exposes MCP tools
   that let an agent report intent, progress and hand-offs, plus a short
   instruction (skill or project instruction file) asking it to do so. This
   adds meaning, but it is best-effort: the model may skip it and it costs
   tokens. It never replaces channels 1 and 2 as the source of truth.

### Why not "just one prompt"

A prompt only affects the session it is typed into, the model may ignore or
forget it, and an agent editing its own configuration is neither reliable nor
reviewable. Persistent hook connection will be done by Extalia itself through
`extalia connect`, which is deterministic, shows a dry run first, and can be
undone. A copy-paste setup prompt may be offered later as a convenience, but it
only asks the agent to run `extalia connect <app> --dry-run` and show the
result to the user; it does not replace the command.

### Live transcript observation available today

Choose **Observe agent apps** during first-run setup, or switch workflows in Settings.
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
or successful. It displays what the source saved. Hook/plugin installers and MCP reporting
are not implemented in this public repository yet; `extalia connect` is not an available CLI
command. The Office scene remains the final integration milestone.

### Taking over an observed session

Observed sessions are read-only in Extalia. To continue the work from Extalia,
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
| Codex, Claude Code, Hermes Agent, Gemini CLI | Observed transcript | Available: selected read-only transcripts, metadata polling and pause/resume; fixture-validated formats |
| Codex, Claude Code, Gemini CLI | Observed hooks/MCP | Planned; native setup installers are not implemented |
| Antigravity | Observed | Binary conversations detected but not decoded; live observation unavailable |
| Codex, Claude Code, Hermes, Gemini CLI history | Import (read-only) | Available: scan, preview and import into the library; Antigravity detected only |

See the [migration ledger](../migration/ledger.md) for what is reused from the
prototypes and [ADR 0004](../adr/0004-managed-and-observed-sessions.md) for the
decision record.
