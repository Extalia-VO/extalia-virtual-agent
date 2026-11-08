# 0063: Scoped synchronous Codex permission hooks

Status: accepted (2026-11-08). Real Desktop activation and user manual testing pending.

## Context

The public native queue delivers messages to the existing conversation but cannot
answer permission prompts. The inspected Desktop has no supported app-server
control endpoint. Codex documents synchronous `PermissionRequest` command hooks
that can return a decision to the original pending request.

## Decision

Use an independently authenticated loopback callback held by the original native
hook process. The shared Desktop/Bridge listener routes `/api/permissions/codex`
to a separate broker, outside asynchronous notification ingestion. A dedicated
private token is created only by an explicitly approved installation. Notification
tokens, transcript events, queued messages and cooperative tool replies never
authorize native permissions.

The global configuration invokes a stable forwarder with one exact native UUID.
Other conversations return `{}` before reading private files or sending payloads.
Extalia additionally binds an explicitly opted-in watched observation to its
registered profile, canonical transcript and source fingerprint. No second agent
or source conversation is started. Native hook trust remains in Codex and is never
written by this installer. Installing configuration alone does not prove that an
already loaded Desktop conversation has refreshed or trusted the definition.

Installation and removal require a read-only preview and matching approved
revision. Existing notifications and trust records survive; configuration backups,
a transaction journal and a scoped undo command are provided. A changed source
invalidates the review. Extalia saves only source-binding metadata, never pending
request bodies, answers or permission grants.

Pending requests retain complete bounded native JSON, an opaque host handle,
payload digest and monotonic expiry. UI choices start unselected. Native response
identity is checked in both broker and forwarder. Disconnect, cancellation, source
replacement, observation pause, shutdown, unknown context and timeout pass control
back to Codex. Client/server/hook limits are 60/55/65 seconds respectively. There
is no automatic retry or persistent grant. The server rejects foreign Origins,
invalid Host names, notification credentials, duplicate JSON keys and oversized
bodies.

## Verified scope and limits

Isolated CLI 0.167.0 probes with temporary profiles and a local synthetic provider
verified that Bash `PermissionRequest` allow executes the original pending command
and deny prevents it. The nine-key payload contains native session/turn,
transcript, cwd, event, model, permission mode, tool name and tool input. It omits
shell, login, argv and explicit granted permission scopes. Extalia presents the
complete native payload without inventing missing detail; users can defer to
Codex. Only the verified exact Bash shape in the watched working directory admits
allow. Additional context and apply_patch requests offer deny/pass only.

The built-in `request_permissions` tool did not invoke this hook and still needs
the existing original-server RPC path or a reply in Codex. Managed-network
coverage is unverified. Approval policy `never` does not invoke this hook. The
application does not change the user's permission mode.

Holding the hook blocks execution; interrupting the original turn terminates its
hook child. A public config/MCP reload in an isolated source refreshed definitions
on the same thread and process. Desktop UI review/hot reload and a real native
Desktop approval remain unverified until the user reviews the hook and performs
that test. Automated marker delivery is separate evidence from user manual tests.

## References

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex permission modes](https://learn.chatgpt.com/docs/permission-modes)
- [Queue and native RPC permissions](0062-codex-queue-and-native-permissions.md)
