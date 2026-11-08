# ADR 0062: Persistent Codex queue setup and explicit native permissions

Status: Accepted; extends ADRs 0060 and 0061.

## Decision

Provide two independent routes to the original Codex conversation:

- Messages use the official `codex queue --thread <UUID> --message <text>`
  command. Never add `--resume`, launch an agent or fork a conversation. A verified
  installed 0.167.0 server with stdio only consumed the queue in its original
  process/thread after its active turn finished. A missing control socket does
  not establish that native queue messaging is unavailable.
- Native questions and permissions require the existing same-server connection
  from ADR 0060. A queue receipt is not a steering action or an approval response.
  No live permission authority is inferred from a transcript or queued text.

Queue setup is explicit and stored in Extalia's own private data. Bind the exact
observed native UUID, registered canonical Codex profile, source path and file
identity. Resolve these on the host; the renderer supplies only an observation
ID and text. Appends preserve the binding; source replacement, pause, deletion,
profile changes and shutdown revoke admission. Do not edit Codex configuration.

Persist an unknown intent before executing the short CLI command, then its exact
queue receipt after acknowledgment. Store no message content. Restore metadata
on restart without resending. Unknown outcomes require explicit review and
re-enablement; unconfirmed child cleanup remains blocked. A queued receipt proves
acceptance by Codex's queue, not that an agent has read the message.

Native command, file and permission requests retain typed wire IDs and opaque UI
handles bound to the same connection, turn and item. Render complete native
details before a choice. Distinguish command execution from terminal input and
escape control bytes in input previews. File changes require the full current
proposed preview; replacements revoke previous handles. Permissions grant only
the retained requested scope with `scope: "turn"` or decline with an empty grant.

Offer only safe choices actually advertised by the native request. Exclude
session grants, policy amendments, permanent approval, unsupported fields and
automatic selection. A nonempty file `grantRoot` can have broader native
semantics, so Extalia offers only decline/cancel for that request. Decline and
cancel are not interchangeable when the runtime offers only one of them.

## Evidence and limits

Installed 0.167.0 probes used temporary profiles, workspaces and a local mock
Responses provider. Real source and Extalia observer peers both received native
requests. Command cancel resolved the source request and interrupted the turn
without executing the command. Permission decline returned an empty turn grant,
resolved the source request and completed the turn.

The real running Desktop accepted a scoped queue test. Its active turn must
finish before the message can be consumed. The inspected Desktop still exposes
no supported control socket, so native permissions on that process cannot be
certified. The current agent also cannot request permission escalation under its
active approval policy. Do not change that policy or imply a native permission
dialog was answered there.

References: [official queue command](https://learn.chatgpt.com/docs/developer-commands),
[native app-server approvals](https://learn.chatgpt.com/docs/app-server).
