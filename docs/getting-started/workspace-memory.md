# Workspace memory

Choose **Extalia** as the connection's memory owner to use persistent workspace
notes in Native Chat and Teams. Notes stay in that workspace's existing memory
directory under Extalia's data folder. Choosing **Off** removes both the catalog
and tools from the model; the built-in skill library can remain enabled.

The initial prompt contains a small preview, not every note. A typical recall is:

```text
memory_search({"query":"migration decision","limit":3})
memory_read({"name":"migration","offset":0,"limit":2000})
```

Search returns ranked metadata and short excerpts, not complete bodies. Read
pages report `offset`, `nextOffset`, `totalCharacters`, `truncated` and
`offsetUnit: "unicode-code-points"`. Continue at `nextOffset` when needed;
offsets refer to the masked text and never split an emoji. Name-only reads still
return complete normal notes up to 20,000 characters. Use pages for larger
externally edited notes. Pages default to 2,000 and allow at most 8,000 code points.

`memory_list` supports `offset`/`limit` metadata pages. Search supports
`scan_offset` to continue a partial source scan. First exhaust `nextHitOffset`
by passing it as `hit_offset` with the same query and `scan_offset`; this retrieves
ranked matches omitted by the result limit or JSON budget. Then advance to
`nextScanOffset`. Excerpts are NFC-normalized lowercase text for matching, not
verbatim citations; read the note page for original wording. Follow the returned continuation
offsets rather than assuming an omitted note is absent. Searches use up to eight
literal terms, rank name matches before summary/body matches, and cap responses
at 4,000 characters. List responses cap at 6,000 characters. Discovery and file
read limits can leave a result incomplete, explicitly reported in the result.
Keep the store unchanged while paging to avoid shifted source offsets.

The lead can save durable notes with `memory_write`; workers receive list,
search and read tools only. Credentials are masked before matching, summaries
and page boundaries, including notes edited outside Extalia. Memory remains
advisory: verify important facts against current files, cite the actual note and
range read, and keep uncertainty visible.

The built-in `memory-recall` skill describes this workflow. The optional
`caveman` skill gives concise replies when explicitly requested, preserving
code, conditions, uncertainty and requested detail. It does not install a proxy
or create a saved global mode. See [Built-in skills](builtin-skills.md).

Installing Extalia does not install Claude-Mem, Caveman's upstream CLI or the
Obsidian application. These are Extalia-owned implementations and instructions,
inspired by selective recall and concise communication. No transcript is
automatically captured or summarized by this feature, no external vault is
written, and no token-saving percentage has been measured.
