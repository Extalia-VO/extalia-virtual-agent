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

## Observe a conversation

In **Observe → Sessions**, choose native sessions, scan the available sources,
select up to ten conversations and give permission to read and follow them.
This enables observation without creating an imported History copy. Ignored
folders cannot be selected for observation. Existing per-conversation controls
remain available only where the source supports them.

**Observe → Tool pairing** provides a cooperative reply channel for a
conversation without a transcript observer. It is distinct from configuring the
source application. See [observed replies](observed-replies.md).

## Import conversation history

In **Import**, scan sources, choose conversations and give permission to read
their history. Choose Copy or Linked, review the preview, then import into
History. Portable Extalia JSON exports can also be imported here.

Copy creates an independent historical copy. Linked lets later import scans
update that historical copy; it does not start an agent or enable live
observation. Use **Open Observe** for live activity. Importing and observing
leave the original source histories unchanged.
