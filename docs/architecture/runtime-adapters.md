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
and report errors. Adapters live in `packages/adapter-<runtime>` and never leak
native payloads past the protocol.

## Observed agents

An observed agent keeps running exactly as before; Extalia watches. There are
three observation channels, used together where available:

1. **Transcript reading** (`transcript`, read-only). Most agent apps already
   write their sessions to disk. Extalia reads those files, never writes them,
   and follows new lines as they appear. No change to the agent's configuration
   is needed. Formats are version-specific, so each parser declares which
   versions it was verified against and reports anything else as unsupported.
2. **Hooks and plugins** (`hook`, one-time setup). Where an app supports
   lifecycle hooks or plugins, `extalia connect <app>` installs a small
   forwarder after showing the planned change and getting the user's approval.
   It backs up the app's configuration, keeps the user's existing hooks, never
   blocks or steers the agent, and `extalia disconnect <app>` removes it.
   Hooks give real-time events that transcripts cannot (for example a command
   starting before its output is written).
3. **MCP tools and instructions** (`mcp`, optional). Extalia exposes MCP tools
   that let an agent report intent, progress and hand-offs, plus a short
   instruction (skill or project instruction file) asking it to do so. This
   adds meaning, but it is best-effort: the model may skip it and it costs
   tokens. It never replaces channels 1 and 2 as the source of truth.

### Why not "just one prompt"

A prompt only affects the session it is typed into, the model may ignore or
forget it, and an agent editing its own configuration is neither reliable nor
reviewable. Persistent connection is done by Extalia itself through
`extalia connect`, which is deterministic, shows a dry run first, and can be
undone. A copy-paste setup prompt may be offered later as a convenience, but it
only asks the agent to run `extalia connect <app> --dry-run` and show the
result to the user; it does not replace the command.

### Taking over an observed session

Observed sessions are read-only in Extalia. To continue the work from Extalia,
the user either starts a new managed session seeded with selected context
("continue as new session", PRD §14.4), or attaches a runtime where the
original app offers a safe, documented resume mechanism.

## Status

| Integration | Mode | Status in this repository |
| --- | --- | --- |
| Extalia Native: OpenAI, Anthropic, OpenRouter, 9Router, OmniRoute, Ollama, custom OpenAI-compatible | Managed | Available (Desktop and the `extalia` Bridge) |
| Hermes Agent | Managed | Planned, Phase 2 (reference adapter) |
| Codex, Claude Code | Observed (transcript, hook, MCP) | Planned, Phases 2–4; prototype behavior is being migrated |
| Gemini CLI, Antigravity | Observed | Planned, Phase 4; parsers ship only after verification against installed versions |
| Codex, Claude Code, Hermes, Gemini CLI history | Import (read-only) | Available: scan, preview and import into the library; Antigravity detected only |

See the [migration ledger](../migration/ledger.md) for what is reused from the
prototypes and [ADR 0004](../adr/0004-managed-and-observed-sessions.md) for the
decision record.
