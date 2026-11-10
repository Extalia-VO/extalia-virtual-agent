# Message agents from Observe

Observe and Office character dialogs use the same message controls in Extalia.
The available action depends on the exact session and its connected transport.

## Existing observed sessions

1. Open **Observe → Sessions** and select a conversation, or open its character
   dialog in the 3D Office.
2. Inspect the offered connection capabilities. Native setup and native questions
   or approvals remain in their dedicated connection/tools panels.
3. Select the intended action explicitly, enter a message and send it. A queue
   action waits for its consumer; a steer action targets the current native turn.
4. Read the receipt. **Queued** confirms admission only. **Submitted** confirms
   the transport accepted it. **Unknown** needs inspection in the source app;
   Extalia does not retry it automatically.

Existing Codex and conditional Hermes attachments retain their original
requirements. Observing a transcript or receiving a hook does not enable native
control. An unavailable action cannot be activated by choosing a different avatar.

## Tool-enabled CLI or MCP conversations

Use a cooperative inbox when the source can run a shell command or call an MCP
tool. This can work with Claude Code, Gemini CLI and other tool-enabled clients;
it is separate from a provider-specific native integration.

1. For a watched session, open **Tool pairing controls → Cooperative inbox
   pairing**. For a conversation without an observer, use **Observe → Tool
   pairing → Pair any tool-enabled CLI**, give it a label and create a manual
   inbox.
2. Choose **Show pairing instructions**. Paste the instruction into the intended
   source conversation. Its CLI/MCP consumer must run on the same computer as
   the Extalia host. The token is temporary and should not be shared elsewhere.
3. Ask that agent to poll at safe work boundaries with the displayed `extalia
   inbox` command or MCP `poll_inbox` tool. There is no always-running injected
   consumer; a source that never polls cannot receive an inbox message.
4. In Extalia, choose **Paired inbox → Send to paired inbox** and send your
   message. The agent's next poll takes one queued message.
5. After receiving that message, the source calls again with its returned
   `messageId` as `--ack` or MCP `ack`. An acknowledgement without `waitMs` only
   acknowledges; add an explicit `waitMs` to also poll for another message.
6. Close the inbox when finished. It also expires after thirty minutes. Re-pair
   explicitly if another channel is needed; do not replay an uncertain message.

Manual pairing establishes possession of the token, not the identity of a
native application or session. It creates no observed session or Office avatar.
CLI presence, native control and cooperative polling are separate capabilities.
The source agent keeps its own permissions, approvals and execution policy.

## Limits and privacy

Each message is at most 16,000 characters and 16 KiB UTF-8. An inbox queues up to
sixteen messages and admits up to 128 operations during its lifetime. Status
shows the latest thirty-two receipts. There are at most thirty-two channels,
with one waiting poll per channel and a maximum twenty-five-second poll wait.

Tokens and queued text are memory-only in Extalia and disappear at host close.
Source apps may retain the copied instruction and tool results in their own
history. **Written to tool connection** does not prove an agent read or acted on
a message; acknowledgement records what the paired caller reports. Pause,
removal, re-pair or a source change revokes the old channel and cancels unread
messages. Existing one-use reply channels remain available separately.

The [PRD and issue plan](../product/prd-observed-agent-control.md) distinguish the
implemented foundation from real-provider/platform acceptance and future
managed CLI/PTY/ACP feasibility work.
