# Reply to an observed conversation

Observe can return a message or answer to a tool running in your **existing
conversation**, without starting another agent. Native attachment is a separate
capability and depends on the source application's public API.

## Cooperative reply channel

1. Update the Extalia host and CLI. In **Observe → Sessions**, select the watched
   source conversation and expand **Reply through the current agent tool**.
   The same panel is available in its Office character dialog.
   If the app has no transcript observer, use **Observe → Tool pairing → Pair a
   conversation without an observer** instead. It creates only a transient reply
   channel, not a managed session or invented native conversation identity.
2. Choose **Create one-use reply channel**. Paste the generated instruction into
   the intended conversation in the source app. Ask the agent to execute it in
   that conversation, without launching another agent.
3. When the tool connects, type your message in Extalia and submit. The text
   returns through that held tool call, so the original agent can continue.

The command is `extalia reply --url <channel-url> --token <one-use-token>`;
`--question <text>` optionally displays the agent's question in Extalia.
If Extalia MCP is already available in that conversation, its `await_reply` tool
accepts the same `url`, `token` and optional `question` fields. No settings are
automatically changed. Do not paste the token into an unrelated chat or log.

Pairing lasts five minutes; once connected, the tool waits 45 seconds. Each
channel carries one reply. Closing the panel does not cancel a channel; use
**Close reply channel**, pause observation or let it expire. A lost connection
does not prove the original agent consumed the answer; inspect the source app
before retrying. Extalia does not persist the token/answer, but the source app
may retain the instruction and tool result in its own history.

This is a cooperative tool return, not an authenticated native app attachment.
The token holder receives the answer. The user must pair the intended source
conversation. Native permission dialogs and questions already waiting in a
different tool still need their original response path. The channel cannot wake
an idle conversation or inject a new user-role message by itself.

## Source application capabilities

| App | Implemented Extalia route | Remaining condition or limit |
| --- | --- | --- |
| Codex Desktop | [Saved native queue setup](observed-codex-control.md), cooperative tool returns, or existing-server controls where a public endpoint is supplied | Queue messages wait for the active turn to finish. Reviewed synchronous hooks can answer supported pending shell requests. Other native questions/permissions require the original-server connection; the inspected Desktop has no supported named socket. |
| Codex CLI | Same original-thread queue route as Codex Desktop, on CLI versions supporting queue | Normal prompt UI is implemented for observed Codex sources; the user manual test currently confirms Desktop. |
| Claude Desktop Chat | Cooperative MCP tool return, only if the tool is available in that chat | No verified public hot-attachment API. Chat is distinct from Desktop Code; do not assume local shell access. |
| Claude Code / Desktop Code | Cooperative shell/MCP tool return | Native channel and original-question hook research is documented below; those transports are not implemented here. |
| Hermes | Cooperative shell/MCP tool return; conditional native gateway attachment | Native attachment requires the public discover-only attach command and the same gateway-owned live session. Older standalone Hermes remains unavailable. |
| Antigravity | Cooperative shell/MCP tool return where the source supports that tool | Vendor Remote Control has no verified third-party local attachment API. |
| Gemini CLI | Cooperative shell/MCP tool return | No verified public attachment endpoint for an arbitrary running CLI. |

## Hermes native gateway control

Select the observed Hermes session, expand **Control original Hermes gateway
session**, optionally enter its profile, and connect. Extalia invokes only the
public discover-only `gateway attach --json` command. It does not start/recover
the gateway or use `session.create`. A returned one-use ticket connects to the
same loopback owner. Runtime identity, exact session and execution generation
are checked before messages and native question/permission replies.

Availability is conditional: the inspected Hermes checkout contained gateway
protocol implementations but lacked the newer public CLI attachment command.
The adapter therefore refuses that version. Its public transport and controller
are tested with synthetic local gateway fixtures; this is not certification of
a real installed gateway or every Hermes release.

## Research sources and scope

Checked against primary documentation on 2026-11-08:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) defines existing
  Unix/WebSocket connections and native thread, turn and question RPCs.
  [Developer commands](https://learn.chatgpt.com/docs/developer-commands) distinguish
  queueing from resuming. Queueing alone is not proof of Desktop delivery.
- [Claude Code channels](https://code.claude.com/docs/en/channels) deliver messages
  into the running CLI when the channel is enabled at startup.
  [Interaction hooks](https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction)
  can supply `AskUserQuestion` answers to the original tool call. These require a
  dedicated synchronous integration, not the current notification-only hooks.
  [Desktop shared configuration](https://code.claude.com/docs/en/desktop#shared-configuration)
  applies to Desktop Code, not ordinary Chat.
- [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
  describes the public attach ticket; [gateway local sessions](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions)
  describes same-owner resume, prompts and generation-bound permission responses.
- [Antigravity Remote Control](https://antigravity.google/docs/remote-control/)
  is a vendor client route. Its [headless CLI](https://antigravity.google/docs/cli/headless/)
  resume flags start another process and are not a live attachment substitute.
- [Gemini CLI session management](https://geminicli.com/docs/cli/session-management/)
  restores saved context; [hooks](https://geminicli.com/docs/hooks/reference/)
  do not establish a spontaneous inbound message endpoint.

No real application configuration, source conversation, permission or credential
was changed to validate this feature. Native Computer Use inspection of Codex
Desktop was denied by the tool's application access policy; it was not bypassed.
