# Reply in the original Codex conversation

## Send a normal prompt

Open **Observe → Sessions**, select the original Codex conversation and type in
the visible **Message Codex** box. Press **Enter** or **Send**; **Shift+Enter** adds
a line. There is no special prompt to paste into Codex and no control socket to
configure for messaging. The same box appears in the observed lead's Office
conversation and when that observed conversation is selected in Chat.

Your first explicit send enables and saves the exact source/profile association
in Extalia. Opening a page does not enable or send anything. Messages go through
the public `codex queue` command to the original native UUID, without `--resume`
or another agent conversation. Codex reads them after its active turn finishes.
**Sent** confirms acceptance by that queue; it does not confirm the model has read
or answered. Replies arrive through the watched source transcript.

**Codex connection settings** contains advanced enable/disable and receipt
information. Uncertain outcomes keep the draft and block another send until you
check Codex and explicitly reset the connection settings/reload; messages are
never automatically resent. Pause observation to disable the prompt box. Other
observed apps and observed worker characters remain unchanged.

The verified CLI 0.167.0 path supports text messages up to 16,000 characters,
without attachments, local model changes, source stop controls or permission
decisions. Setup/receipt metadata live in
`~/.extalia-vo/state/observed-codex-queue.json`; message content is not persisted
there. Source changes revoke the saved binding. Hook approval is a separate setup
below and is not required for ordinary prompts.

## Character message dialog layout

The Office character's message dialog keeps conversation history and the normal
prompt box in its main column. **Conversation tools** sits alongside it on wide
screens, with its own scroll area for the prompt queue, connections and permission
controls. Hide or reopen that panel without losing unsent drafts or queue edits.

On narrow screens the tools panel starts closed. Choose **Show conversation tools**
to open its drawer; close it or press Escape to return to the conversation. A second
Escape closes the dialog. The Agents & sessions board keeps its manual expansion
state when a message dialog opens or closes. The dialog remains centered in the
3D Office area, excluding the application sidebar and top bar, regardless of the
board's expansion state. Its frosted translucent surface
keeps the Office visible behind it; reduced-transparency preferences use an opaque
surface instead.

## Edit or reorder prompts before sending

Open **Prompt queue** below the normal message box in Observe or Chat. In the
Office, open the lead's **Conversation tools** panel. The same queue is available
for managed Native and Hermes conversations. Add text with the queue's add icon, then use **Edit prompt**,
**Move up**, **Move down** or **Delete pending prompt**. Entries start paused.
Choose **Start queue** to send them in order when that session is ready;
**Pause queue** holds the remaining entries. Stopping a managed turn also pauses
its remaining queue; pausing observation holds the observed queue. Queued prompts use the session's
current settings at handoff. Queue text does not include attachments.

The normal Send icon still sends through its existing message route. The editable
list contains prompts you add to **Prompt queue**, not messages already accepted
by Codex's native queue. Once sending begins, an item becomes a read-only receipt.
An uncertain outcome pauses dispatch. Check Codex, then explicitly acknowledge
the local record before continuing; acknowledgement neither cancels nor resends
anything in Codex. Restart also leaves queues paused.

Already accepted native Codex messages cannot currently be edited from this
connection. The installed experimental API defines persisted-queue operations, including
access to stored threads without resuming them. This adapter does not yet expose
that path, and the inspected default public shared endpoint is unavailable.
Isolated persisted-queue CRUD works, but an independent process cannot guarantee
serialization against a prompt already starting in the active Desktop. Those
source-queue mutation controls remain unavailable on this connection.
See [ADR 0064](../adr/0064-extalia-pending-prompt-queue.md).

## Pending shell permissions without a control socket

Open **Permissions in the same Codex conversation** in Observe or the observed
lead's Office panel. Choose **Review permission setup**. Review the exact native
conversation, configuration diff, backup location and undo command; then explicitly
install the reviewed hook. A changed preview must be reviewed again. This creates
a separately authenticated synchronous hook, scoped to this native conversation.
Other chats do not forward their permission payloads.

In Codex use **Review hooks** or **Settings > Hooks** to review and trust the new
definition. Codex must use a permission mode that asks for approval. Extalia does
not change that mode, trust a hook, refresh private Desktop state or create a new
conversation. An already loaded chat may need a supported configuration refresh;
installation is displayed as awaiting review/live requests until you verify it.

When a supported shell request arrives, Extalia displays its complete native JSON,
original conversation/turn, digest and expiry. Explicitly choose **Allow this
request**, **Deny this request** or **Answer in Codex**. Choices apply once to the
original pending call. The payload may omit shell and detailed permission scopes;
answer in Codex if those omissions prevent review. Unsupported tool contexts offer
deny/pass only. The separate `request_permissions` tool is not covered by the
verified hook; answer it in Codex or use the original-server connection below.

If the caller disconnects, observation pauses, the source changes, or the decision
expires after 55 seconds, Extalia releases it back to Codex. Closing Extalia has
the same effect. No decision is automatically repeated or saved as a grant.
**Review removal** provides revision-bound undo, preserving notification hooks.

For command-line setup, preview with
`extalia connect codex-permission --session <native-UUID> --dry-run` and apply only
the exact reviewed revision with `--apply <revision>`. Add `--undo` to review
removal. Run undo with the same `EXTALIA_HOME` environment used for installation;
a missing original receipt requires manual review. CLI setup installs the hook; explicitly review setup in the selected
Extalia source to save its observation binding. Existing `hooks.json` must be
migrated or configured manually; the installer will not overwrite it.

Isolated native 0.167.0 shell allow/deny and cancellation checks pass. Real Desktop
activation and the user's direct manual test remain pending. See
[the hook decision](../adr/0063-codex-synchronous-permission-hooks.md) and
[official hook review instructions](https://learn.chatgpt.com/docs/hooks).

## Native questions and permissions

Extalia can attach to a Codex conversation that is already running on a Codex
app-server with a supported, explicitly exposed local Unix socket. Observation
through transcripts or notification hooks alone does not provide this RPC capability.

1. Open **Observe → Sessions** and select the observed Codex conversation.
2. Expand **Control original Codex conversation**, enter the socket path supplied by
   that conversation's existing Codex server and choose **Connect existing Codex
   server**. Extalia does not start a server or create a conversation.
3. Check the displayed original thread. Send a message, select/type answers on a
   new question, or review a native approval received after connecting. Native
   approvals show exact command/input, file preview or permission scope before
   any choice. Active-turn messages use steering through this connection.
4. **Disconnect**, pause observation or remove the observation to revoke control.
   The original Codex app continues to own execution and permissions.

The same controls are available under the original-conversation section in an
observed lead's Office panel. Worker characters do not receive them.

Answers are never preselected. Secret answer fields are masked. **Submitted**
means the transport wrote the answer; **Request resolved** can also mean another
client answered or Codex cleared it. If delivery is uncertain, check Codex before
submitting again. Reconnect explicitly after a disconnect or restart.

## What is not available

- A Desktop session without a published, supported control endpoint cannot use
  this native question/approval connection. Queue messages and the separately reviewed synchronous shell hook above remain available.
  The inspected ChatGPT Desktop session has this limit. The separate native
  App Server experiment used CLI 0.167.0.
  Internal Desktop IPC sockets are not interchangeable with app-server sockets.
- Questions already pending before attachment were not replayed by the tested
  Codex server. Answer them in Codex; connect before subsequent questions appear.
- Generic notifications, transcript-derived waiting states and unsupported native
  schemas cannot be answered. Persistent grants and policy amendments remain in
  Codex. File requests with a broader root grant allow only decline/cancel here.
- Another server that only has a saved copy of the thread is rejected. Starting
  a second engine or copying conversation history does not establish attachment
  to the original live session.

The socket connection does not install hooks, write trust, edit external configuration,
create a managed session or make automatic permission decisions. Extalia does not ask for model credentials
for this connection. Native testing uses isolated temporary data and a local mock
model, not the user's Desktop chat.

See [ADR 0060](../adr/0060-observed-codex-same-server-control.md) and the
[queue and permission extension](../adr/0062-codex-queue-and-native-permissions.md), plus the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server).
