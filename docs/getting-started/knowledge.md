# Knowledge (preview)

The Knowledge page shows the Markdown notes in your profile's vault. You can
search them, read them with their links and backlinks, and explore them in a
local graph or a 3D graph of the whole vault. It is part of the preview Rust
native core, so it appears only when that core is on. See
[Native core (preview)](native-core.md) to turn it on. With the TypeScript core
the page stays hidden.

The page is read-only. Notes are untrusted text. Nothing in a note is run, and
anything a note declares, such as `verified` in its front matter, is shown as
declared, never as checked.

Open **Knowledge** under **Work** in the sidebar.

## Where the vault lives

Each profile has its own vault folder, `vaults/<profile>`, inside your Extalia
data folder (`~/.extalia-vo` by default). Put `.md` notes in that folder.
Obsidian is optional, and `[[wikilinks]]` work in any editor.

The page reads an index, a file at `profiles/<profile>/knowledge.sqlite` in the
same data folder. The index is derived from the Markdown. The Markdown stays the
source, and the index never writes to your notes. If you delete the index, the
next sync rebuilds it.

Only `.md` files are notes. Hidden folders such as `.obsidian` are ignored.

## Sync

- **Sync now** reads the vault and updates the index. If the vault folder does
  not exist yet, Sync now creates it.
- Opening the page refreshes an index that is more than 5 minutes old. The
  refresh reads only files that changed, and it never creates the vault folder.
- The sync status shows when the last sync ran and whether it was changes only
  or a full rebuild.
- A sync stops and leaves the index unchanged if the vault has more than 20,000
  notes, 200,000 entries or 256 MiB of notes.

If the vault folder disappears after notes were indexed, the page reports the
vault as unavailable. Extalia does not create it again empty.

### Skipped files

The sync status shows how many files were not indexed. The list of skipped files
comes from the latest sync. Sync now lists them again.

| Shown as | Happens when |
| --- | --- |
| Symbolic link (never followed) | The file is a symbolic link. Links are never followed. |
| Not a regular file | The entry is a special file. |
| Hard-linked file | The file is hard-linked. |
| Unsupported file name | The file name is not supported. |
| Folder nesting too deep | The folder is nested too deeply. |
| Larger than 1 MiB | The note is larger than 1 MiB. |
| Not UTF-8 text | The note is not UTF-8 text. |
| Invalid front matter | The front matter cannot be read. |
| Front matter names a different profile | The note's `profile` is not this vault's profile. |
| Another note already uses this id | Two notes use the same `id`. The one with the smaller path is indexed. |

## Notes and front matter

A note is Markdown, with optional front matter at the top. Extalia reads a
simple YAML subset: simple values and lists of simple values. Other keys are
kept but ignored. These keys are recognised:

- `id`: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or
  digit, up to 128 characters.
- `kind`, `tags`, `aliases`: shown on the note.
- `profile`: must match the vault's profile, or the note is skipped.
- `verification`, `revision`, `source_task_ids`: shown as declared.

A note without an `id` is identified by its path. A note that must keep its
identity across renames needs an `id`.

```markdown
---
id: deploy-checklist
aliases: [Release checklist]
tags: [ops, release]
verification: verified
---
# Deploy checklist
```

The note header shows its kind, tags, aliases, note id (or that it follows its
path) and modified time. A claim such as `verification: verified` appears as
`Declared “verified” · not verified`. Revision and source tasks appear as
declared values too.

Long notes show only their first part. If a note changed after it was indexed,
the page says so, and Sync now shows the current version and its links.

## Links

Links use Obsidian-style wikilinks.

| Written as | Meaning |
| --- | --- |
| `[[Note]]` | Link to a note |
| `[[Note\|text]]` | Link with display text |
| `[[Note#Heading]]` | Link to a heading |
| `[[Note#^block]]` | Link to a block |
| `[[folder/Note]]` | Link by path suffix |
| `[[./Note]]`, `[[../Note]]` | Path relative to the note's folder (path only) |
| `[[/folder/Note]]` | Path from the vault root (path only) |
| `![[Note]]` | Embedded note |

Links inside fenced code blocks and inline code are not links. Neither are
`\[[` or an empty target such as `[[#Heading]]`.

A line labelled `Related:`, `Learned from:`, `Depends on:`, `Supersedes:` or
`Used by:` gives the links on that line that edge type. Other links are plain
links.

### How links resolve

Matching ignores case. Extalia tries these tiers in order, and the first tier
with a match wins:

1. Exact vault path.
2. Unique path suffix, for `folder/Note` forms.
3. Title: the file name without `.md`.
4. Alias from front matter.

If several notes match in one tier, the link resolves only when exactly one of
them matches the written case. Otherwise the link is **ambiguous**. The page
shows the number of matches and a candidate picker. A link with no match is
**not found**, and the page shows it muted. A link to a note in another profile
is also shown as not found.

Outgoing links show their status and line number. Backlinks list the notes that
link to the open note, or say that no other note links here.

## Search

Search finds notes by title, alias and text. The query can be up to 200
characters, and up to 50 results are shown. Select a result to read it here. If
a result is no longer in the index, sync the vault and search again.

## Local graph

On a note, **Show local graph** shows the notes linked to it. Choose depth 1 or
2. The graph shows at most 60 notes and loads when you ask for it. If notes are
left out, the page says how many.

## Whole vault graph

**Graph view** switches between **Local** and **Whole vault**. The whole-vault
graph shows the profile's notes and the links between them. It shows at most
2,000 notes and 8,000 links. When the vault is larger, it shows the most
connected notes and says how many of the total it shows.

Notes are coloured by folder, kind or tag. The most connected notes are larger,
and they glow and pulse gently. These controls are available:

| What | How |
| --- | --- |
| Rotate | Drag |
| Zoom | Scroll |
| Move a note | Drag the note. Its neighbours react and the links follow. |
| Return after dragging | **Return after drag** is on by default. On release, all notes return to their positions before the gesture. Turn it off to let the graph settle freely. |
| Restore positions | **Restore layout** restores the positions before the last drag without changing your camera. Filtering or refreshing the vault starts a new layout and clears the previous restore point. |
| Focus linked notes | Select a note, then **Focus selected note**. Choose 1, 2 or 3 hops through links in the loaded graph. The time filter still applies, including to intermediate notes. |
| Leave focus | **Clear focus** keeps your time filter, search and camera. Reading another note or closing its panel does not move the focus anchor. |
| Highlight a note and its neighbours | Hover over the note |
| Read a note | Click the note. It opens beside the graph, or as a bottom sheet on phones. |
| Search | Press `/` and type. Use ↑ and ↓ to move through matches, Enter to open one, and Esc to close the note. |
| Time filter | Modified in the last 1D, 1W, 1M, 1Y or All. Notes outside the window are not shown, and the page says how many. |
| Colour by | Folder, Kind or Tag |
| Labels and glow | Toggle note labels and the glow |
| List view | The same notes as an accessible list |

The 3D graph needs WebGL. Where WebGL is not available, use the list view or the
local graph.

Positions are temporary view state; moving notes does not edit Markdown or
wikilinks. With reduced motion enabled in your system, return/restore finishes
immediately. A hidden tab pauses the simulation; leaving the graph stops its
worker. No persistent pins or saved layout are added by these controls.

Focus is temporary and ends when you leave the whole-vault view. If its note is
removed from the loaded graph or hidden by the time filter, the graph explains
why it is empty; change the time filter or clear focus. Counts and legend show
only visible notes/links, while note size and list degree reflect vault-wide
connectedness. Focus follows actual loaded links, including backlinks, and
does not infer relationships or expand beyond the displayed overview limit.

## Profiles

Each profile has its own vault and index. The page shows only the current
profile's notes. A link to a note in another profile looks the same as a link to
a missing note. A note whose front matter names a different profile is skipped,
and links to it show as not found.

## When Knowledge is not available

If the index cannot be used, the page says that Knowledge is not available right
now, with a reason code, for example `index_locked`. The daemon keeps running.

## Where to go next

- [Native core (preview)](native-core.md)
- [Skill Security Center (preview)](skill-security-center.md)
- [ADR 0024: profiles, ACL and vault roots](../adr/0024-profiles-acl-and-vault-roots.md)
- [Getting started](README.md)
