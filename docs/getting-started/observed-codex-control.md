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
information. Uncertain outcomes keep the draft and block another send. Recheck
delivery, inspect Codex and explicitly acknowledge before retrying; an unresolved
host receipt must still be handled in its queue/source controls. Messages are
never automatically resent. Pause observation to disable the prompt box. Other
observed apps and observed worker characters remain unchanged.

The verified CLI 0.167.0 path supports text messages up to 16,000 characters,
without attachments, local model changes, source stop controls or permission
decisions. Setup/receipt metadata live in
`~/.extalia-vo/state/observed-codex-queue.json`; message content is not persisted
there. Source changes revoke the saved binding. Hook approval is a separate setup
below and is not required for ordinary prompts.

## Source model and reasoning effort

The observed prompt box displays the model and reasoning effort reported by the
original conversation. Source reports take priority over configured defaults;
unreported effort stays hidden. Visible choices refresh periodically and when
source metadata changes, while unsent drafts remain with their conversation.

Codex model/effort controls become editable only on an attached original-server
connection that positively advertises the native settings API. Extalia validates
the connection and settings revision, sends the settings change to that same
thread, then reads it back. These settings apply to subsequent messages. An
uncertain result disables further changes until reconnection; inspect Codex
before retrying. No new thread, turn or global configuration edit is involved.
The separate CLI queue messaging path alone does not provide this capability.

Antigravity, Claude Code, Gemini CLI and Hermes display available source metadata
read-only until a verified native settings API is integrated. Extalia does not
simulate setting changes by adding model or effort instructions to prompts.
Configured catalog defaults are fallbacks, not evidence of an active source
selection. Some integrations do not report reasoning effort.

## Character message dialog layout

The generic observed sender also uses an ordinary prompt input with an icon
send button. Press Enter to send and Shift+Enter for a new line. Delivery action,
connection capabilities and pairing live in **Conversation tools**: a separate
tab in Observe/Chat, or the Office's tools panel (closed initially for this
sender). Each tool type has its own tab; switching within tools preserves pending
tool form inputs. Switching tools or closing the dialog keeps the same conversation draft.
A normal send prefers an available queue, then an unambiguous native start or
paired action. It never automatically steers, retargets a changed source or retries
uncertain delivery. Ambiguous connections require an explicit choice in tools.

Unsent prompt text stays with its conversation when hooks refresh metadata,
you close/reopen the dialog, or you switch between Chat, Observe and the Office.
Each conversation has its own draft. Text is kept only while this application
window remains open; it is not saved to browser storage or the host. Restart and
browser-unload protection still apply when a draft's dialog is closed.

Sending immediately shows progress near the input. After a longer wait, a short
explanation confirms that Extalia is still waiting. **Queued in Extalia** means
Extalia accepted the text; **Submitted to Codex** means its source handoff returned
a receipt, not that Codex has read or answered it. Feedback stays visible even
when queue details are collapsed. You can continue typing the next draft without
an older receipt clearing it. Uncertain results keep the text and require source
inspection before an explicit retry; Extalia never retries them automatically.

The Office character's message dialog keeps conversation history and the normal
prompt box in its main column. **Conversation tools** sits alongside it on wide
screens, with its own scroll area for connections and permission
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

The separate **Queue in Codex** section near the Chat/Observe input shows pending prompts already
saved in the original Codex conversation's persisted queue. Expand it to inspect
formatted text and clickable web links, passive attachment names/thumbnails,
the last snapshot time, or refresh. Only small inline PNGs already supplied by
Codex have thumbnails; path-only images show their filename without reading the
file. Empty queue panels disappear and reappear automatically when items arrive. It updates
while this view is visible, with a short shared cache. No source edit/delete/
reorder controls are offered, and reading it does not start or resume a turn.
In the Office character dialog, find it in **Conversation tools**, so the main
message area keeps its space. Hidden tools do not poll the source queue.

This snapshot can include messages queued outside Extalia. Prompts held only in
Codex Desktop's local UI and not persisted by Codex cannot appear through this
API. Empty, unsupported, unavailable and labels-only privacy states are distinct;
an unavailable read is never shown as an empty queue. This experimental source
reader requires a compatible installed Codex CLI. Reading the queue does not
enable message submission or change permissions. It remains separate from
**Prompt queue**, the editable waiting list owned by Extalia.

Use the normal input in Observe, Chat or the Office. While work is active,
submitted text joins Extalia's queue automatically. Open **Prompt queue** beside
the composer to use **Edit prompt**, drag-and-drop, **Move up**, **Move down** or
**Delete pending prompt** before handoff. The same queue is available for managed
Native and Hermes conversations. If paused, choose **Start queue** to send entries
in order when that session is ready;
**Pause queue** holds the remaining entries. Stopping a managed turn also pauses
its remaining queue; pausing observation holds the observed queue. Queued prompts use the session's
current settings at handoff. Queue text does not include attachments.

The editable list contains prompts waiting inside Extalia, not messages already accepted
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

## Questions from Codex

Structured Codex questions appear above the normal message input in Chat,
Observe and the Office character dialog. The global input alert opens the
requesting character's conversation; an admitted character is framed on its
current floor. Outstanding questions also enter the existing automatic camera's
attention list without changing an asynchronously working agent to Waiting.

Codex asynchronous questions (`request_user_input_async`) are metadata on async
agent messages. Extalia reads them through the existing watched transcript path.
When the source call identity is verified, Extalia prefers an already-connected,
verified attachment to that original thread. Active work receives the answer
through **Steer**; an idle original thread receives it directly through its
existing native connection. Blocking native questions keep their own callback.
The card shows which delivery route is available before you send.

If only the public Codex queue is available, the answer enters that exact
conversation's queue. Its status explicitly says reading is not confirmed and
may wait until the active turn finishes. You can use **Steer** in Codex for an
already-queued answer. Do not resend it from Extalia. A failed or uncertain native
submission is never automatically repeated through the queue.

No source application configuration or permission policy changes. Protocol
question IDs remain internal transport metadata so answers can be correlated;
Extalia displays and copies clean question/answer text. An exact reply later
observed in Codex removes the question, including replies entered in Codex itself.
Identity-less legacy question mirrors remain visible read-only without raising pending-input alerts.

Blocking native input requests retain the original-server callback described
below. Answers are never selected or submitted automatically. Source changes,
pausing and labels-only privacy revoke answering; uncertain handoffs stay blocked
across restart. Native option descriptions and secret fields remain intact.

Question notifications use the existing **Settings → agent request notifications**
preference. Desktop and permitted browsers can notify while Extalia is running
in the background. Clicking a question notification routes to that request's
character, while approval notifications keep their existing inbox behavior.
Question/answer text is excluded from system notifications. The first settled
snapshot is a startup baseline, so historical unanswered questions show the
in-app alert without a burst of system notifications. This is not an offline
cloud push service; browser permission and operating-system settings still apply.

The source behavior is established by [Codex's structured async-input change](https://github.com/openai/codex/pull/42178)
and the [official Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).

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
- Blocking native questions already pending before attachment were not replayed by the tested
  Codex server. Answer those in Codex; connect before subsequent blocking questions appear.
  Structured asynchronous questions follow the metadata/queue path described above.
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
