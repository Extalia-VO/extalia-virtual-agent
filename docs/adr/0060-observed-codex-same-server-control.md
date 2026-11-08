# ADR 0060: Opt-in control of an observed Codex conversation on its original server

Status: Accepted (2026-11-08); implemented locally v0.4.211 with explicit endpoint limits.

## Decision

Observed sessions remain observed. The owner requested sending messages and
answering Codex questions from Extalia without creating another conversation.
An explicit, optional Codex attachment is the narrow exception to the default
read-only behavior in ADR 0004. ADR 0018's broader approval bridge remains proposed.

The user supplies the Unix socket of the already-running originating Codex
app-server. Extalia runs only `codex app-server proxy --sock <socket>`; this is
a byte proxy, not another agent engine. The stream requires WebSocket Upgrade
and masked client frames, rather than newline JSON. Missing endpoints, proxy
support or thread identity disable control. There is no engine-start, fork,
alternate endpoint, managed-session or transcript-injection fallback.

The host resolves the exact native thread ID and project folder from its own
observer registry. It verifies that this exact thread is loaded on the selected
server, reads metadata and subscribes with `thread/resume` without configuration
overrides. Omitted active turns are recovered through a bounded metadata-only
`thread/turns/list`; ambiguity disables control. Idle messages use `turn/start`
on this thread; active messages use `turn/steer` with its exact expected turn ID.
A rejected steer is never retried as a new turn.

Only native `item/tool/requestUserInput` requests actually received on this
connection can be answered. Each has an opaque Extalia handle bound to connection
generation, native JSON-RPC ID (including its number/string type), thread, turn,
item and unchanged question/options. No default answer, automatic response or
command/filesystem permission grant is introduced. Unknown request kinds remain
with the original app. Answer contents are not persisted or logged by Extalia.

Written answers are marked submitted, not accepted. `serverRequest/resolved`
means resolved or cleared and does not prove which client's answer won. Duplicate
submissions, stale handles, turn endings, source changes, pause, delete and
disconnect invalidate controls; uncertain delivery is never automatically resent.
Proxy cleanup is tracked and unconfirmed cleanup blocks replacement.

Local sockets require checked ownership, permissions, canonical path and pinned
device/inode. A changed socket requires explicit reconnection. Connections and
pending requests are memory-only; application restart does not reconnect.
No external application configuration is changed by this feature.

## Evidence and limits

Isolated Codex 0.167.0 experiments use a temporary Codex home, project and Unix
socket with a local mock Responses endpoint: no real model inference, credentials
or personal transcripts. Two subscribers received a newly emitted question; one
answered and a conflicting duplicate did not replace or duplicate its output.
The original server process and thread ID remained the same.

Pending questions were not replayed to a late subscriber. Connect before the
question is emitted; an older pending question must be answered in Codex.
The currently inspected ChatGPT Desktop Codex process did not expose a documented
control socket. Its internal IPC is not treated as a supported endpoint, and this
feature does not claim control of that Desktop session. Unix-socket support for
other clients or later Desktop versions must be verified independently.

Reference: [official Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).
