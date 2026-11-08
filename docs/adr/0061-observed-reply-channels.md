# ADR 0061: Explicit same-session replies for observed apps

Status: Accepted for cooperative tool returns and conditional Hermes gateway attachment.

## Context

The owner requests messages and input replies from Extalia to conversations
already running in Codex Desktop, Claude, Claude Code, Hermes, Antigravity and
Gemini CLI. An imported transcript does not own the original application or its
pending requests. Starting a second engine with saved history cannot establish
live-session control.

## Decision

Keep three distinct capabilities:

1. Existing Codex same-server attachment under ADR 0060, with its exact native
   thread/turn and public endpoint requirements.
2. Conditional native Hermes gateway attachment through the public discover-only
   `hermes gateway attach --json` command. Verify the gateway's returned owner,
   profile, native session and execution generation. Never start/recover a gateway
   or create another session. Missing public attach support means unavailable.
3. A manually paired cooperative reply channel. The user creates a one-use channel
   for a watched observation and pastes its instruction into the intended original
   conversation. The agent explicitly calls `extalia reply` or the MCP tool
   `await_reply`. Extalia returns the user's text to that exact held tool request.
   It neither wakes an idle agent nor intercepts native questions or permissions.

The cooperative channel's native source association is host-owned, but the bearer
token proves possession only. It does **not** attest which app or conversation
called it. Manual pairing is explicit in the UI. Do not label its connected state
as verified native session control.

Apps without transcript observation can use a manual-pairing entry in Agent apps.
Its transient pairing record is explicitly unverified and creates no session or
history entry. It uses the same bounded tool-return protocol, without claiming
an observed native identity.

The loopback reply listener is independent from notification-only hooks. Use an
ephemeral port, exact loopback Host, no browser Origin, bounded JSON, a 256-bit
one-use token and opaque request identity. Tokens and answers remain in memory.
Expire unclaimed channels after five minutes and held tool calls after 45 seconds.
Pause, removal, source changes, disconnect and host closure revoke outstanding
requests. Failed delivery is never automatically retried. No terminal keystrokes,
private application IPC, debugger injection or competing resume process is used.

Hermes native permission choices require an explicit user response. Persistent
"always" authorization is excluded because it changes source configuration.
Unknown native request kinds remain in the source app.

## Consequences

Cooperative replies can run in an existing shell-capable conversation without
editing another application's settings. MCP-only clients need the tool already
connected, or a separately reviewed configuration change with dry run, approval,
backup and undo. Ordinary Claude Desktop Chat must not be confused with Desktop
Code or assumed to provide a local shell.

Claude Code channels/hooks and vendor Remote Control features are documented
future integration paths. They are not advertised as implemented Extalia native
attachments. See the [capability and evidence matrix](../getting-started/observed-replies.md).
