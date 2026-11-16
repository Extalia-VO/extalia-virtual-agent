# Settings, Observe and Import

These pages serve different tasks. They share source discovery, but do not share
configuration editors or start each other's operations automatically.

| Page | Use it for |
| --- | --- |
| Settings | Durable application, model, project and agent-app configuration. |
| Observe | Follow selected live conversations and use the source's supported reply/control channels. |
| Import | Preview and save historical conversations into History. |

## Settings sections

- **General:** appearance, language, workflow and approval notification preferences.
- **Models & connections:** provider/router connections and their available models.
- **Agent profiles:** shared team defaults and individual roles, personality,
  models and delegation preferences.
- **Projects:** workspace folders and project settings, including integration gates.
- **Agent apps:** connect source applications, configure automatic observation and
  ignored folders. Configuration changes retain their existing preview, consent
  and recovery steps.
- **Storage & knowledge:** storage and knowledge configuration. Skills remain on
  their own page.
- **System:** available host update and restart controls.

Sections appear when supported by the connected host. Editors load when first
opened and retain their drafts while moving between Settings sections. Changing
the connected host, profile or data directory clears those private editor drafts.
Office's Connect button and the Manage agent connections shortcuts open
**Settings → Agent apps**.

Choose project, vault and ignored folders with **Choose folder**. Desktop uses
the system folder picker; Web browses folders on the connected host. Confirmed
locations remain visible and can be copied. Project saves wait for folder
validation to finish. Cancelling a picker keeps the existing folder.

Model selectors accept custom model IDs. Command fields and relative permission
paths remain editable text. Pending saves lock the affected editor; a failed
save retains its draft for correction or retry. Vault loading errors offer
**Retry** without leaving Settings.

## Observe a conversation

In **Observe → Sessions**, choose native sessions, scan the available sources,
select up to ten conversations and give permission to read and follow them.
This enables observation without creating an imported History copy. Ignored
folders cannot be selected for observation. Existing per-conversation controls
remain available only where the source supports them.

**Observe → Tool pairing** provides a cooperative reply channel for a
conversation without a transcript observer. It is distinct from configuring the
source application. See [observed replies](observed-replies.md).

Messages follow new output while you are at the bottom. Scroll up to keep your
reading position, or use **Latest messages** to resume following. Refreshes,
streaming text, file-scope updates and switching between Messages and Files keep
that position. The main conversation and subagent preview scroll independently.
A failed authoritative refresh does not replay cached older history; recovery
restores the viewport without retaining stale message contents.

### Empty automatic channels

Automatic entries for Codex, Claude Code, Antigravity, Gemini CLI and Hermes
with a generated app-and-ID title and only lifecycle metadata stay out of Observe
until there is conversation or live work evidence. Records are retained. Genuine
prompts, attachment-only requests, tool work, approvals and child work remain
visible. Manual observations, deliberate renames, cached conversations and real
prompt/output/model evidence are preserved; an unavailable transcript alone is
not a reason to hide a conversation.

A readable source containing only injected setup or source-marked metadata input
(such as Claude meta rows) is also omitted from automatic observation. This
classification requires a complete supported read; ambiguous or large-window
reads, assistant/tool output and actual work are retained. Source histories and
manual import previews are unchanged. If work appears later in an approved
auto-watched location, Extalia reuses its existing observation ID. A user pause
remains in effect.

### Read subagent messages

Working children appear first. Finished, failed and stopped children are kept in
a separate **Finished** group, collapsed by default. Expand it to revisit earlier
work; closing the group does not close a child transcript you are reading.

On desktop, Observe uses three columns: sessions on the left, the main agent's
conversation in the center, and conversation tools on the right. A Subagents
list appears in the right panel when the source reports actual children. Choose
a name there, or click its delegation card in the main transcript, to read that
child's recorded prompts, replies, tool output and results in the right panel.
Nested agents retain their parent label and can be selected separately.

The child preview has no prompt input, steering or approval controls. New agents
and recorded updates arrive without replacing the child you are reading.
Changing session or host clears the previous child selection. On narrow screens
the right panel becomes a drawer that can be closed or dismissed with Escape.

Raw child conversation reads are currently available for Codex and Claude Code.
Other harnesses display only the child or task activity their source actually
provides. A task label or background command alone does not create a child
conversation; missing source content is stated in the panel.

### Internal prompt-suggestion sessions

Codex can create separate internal conversations to predict the next user
message. Recognized helper-only sessions are omitted from native scans and the
Observe list, including legacy cached observations and their counts. This does
not delete native source histories or existing portable History imports.

Detection uses the specific app-generated header at the start of Codex prompts,
not a broad title keyword or substring. Quoted examples, ordinary conversations,
other harnesses and genuine user continuations remain visible. Incomplete or
ambiguous source reads are kept visible; there is no universal internal-session
marker shared by every harness.

### Images viewed by tools

Supported Codex tool results now show image thumbnails beneath the tool activity,
including results that arrive after their hook row. A run containing a captured
image opens automatically unless you explicitly folded it. Text output keeps its
own disclosure. Click the thumbnail to view the original; Escape closes it and
returns keyboard focus.

Explicit image content in the source is copied into private session storage. For
a successful, matched `view_image` call that records only a local path, Extalia
may copy a supported image from the observed project's folder or the system's
temporary folder. It does not fetch remote image URLs or interpret ordinary tool
text as a file-read instruction. Labels-only observation suppresses image storage
and delivery. Choosing a conversation already grants observation access; viewing
these captured copies does not rerun a tool or call a model.

If the source did not retain image bytes and its file disappeared before capture,
or the image falls outside the supported scope/size limits, its literal filename
is shown with **Preview unavailable**. Previously captured copies can survive
deletion of the original file. The source history must remain readable to rebuild
the tool rows. These previews belong to observed sessions; portable History
imports do not automatically include their private image files.

Passive thumbnails are resized to at most 192 pixels. Original images are opened
only on demand, and offscreen/closed previews release their display resources.
See the [implementation and limits](../architecture/observed-tool-images.md).

## Import conversation history

In **Import**, scan sources, choose conversations and give permission to read
their history. Choose Copy or Linked, review the preview, then import into
History. Portable Extalia JSON exports can also be imported here.

Copy creates an independent historical copy. Linked lets later import scans
update that historical copy; it does not start an agent or enable live
observation. Use **Open Observe** for live activity. Importing and observing
leave the original source histories unchanged.
