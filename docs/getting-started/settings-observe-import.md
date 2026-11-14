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
