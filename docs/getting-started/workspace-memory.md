# Workspace memory

Choose **Extalia** as the connection's memory owner to use persistent workspace
notes in Native Chat and Teams. Notes stay in that workspace's existing memory
directory under Extalia's data folder. Choosing **Off** removes both the catalog
and tools from the model; the built-in skill library can remain enabled.

## Automatic work memory

Saved Native sessions can also preserve a bounded operational record after each
completed, failed or cancelled turn. This requires **Extalia memory**, **history
retention**, and enabled **automatic learning** on the workspace's vault profile.
The record retains attributed user instructions, recent corrections, assistant
reports, tool evidence and outcome. Failed work stays labelled failed. Hidden
reasoning, attachment bytes and complete transcripts are not captured by this
recording path.

On later requests, Extalia searches the local operational index and the selected
Knowledge vault. Relevant bounded excerpts enter the Native model context
automatically; detailed evidence remains available through `work_memory_search`,
`work_memory_read` and `knowledge_read`. Each worker follows its selected
connection's memory/history settings. Mandatory skill instructions are prepared
first; optional recall cannot displace them from the input budget.

Records survive ordinary restart, with an exact local outbox for interrupted
storage acknowledgements. A workspace's profile or boundary change does not move
its old records into the new scope. Separate workspaces sharing one profile still
have separate operational records. A crash before capture reaches the journal
can leave a turn uncaptured. Storage and source coverage are bounded and reported;
there is no automatic retention cleanup or semantic relevance guarantee.

Observe has a separate opt-in. Linked observations belong to their registered
workspace; explicitly unbound sources belong to the default/global scope.
Revoked sources are excluded from subsequent recall. Extalia captures newly
observed eligible frames, without analyzing all pre-existing history or injecting
context into the external application's next prompt. See
[Automatic learning](automatic-learning.md) for consent and routing.

## Authored workspace notes

The initial prompt contains at most four positively matching metadata entries,
selected by bounded literal relevance to the composed request. Unrelated notes
do not fill an unmatched preview. Descriptive filenames can be selected
beyond the first alphabetical page. The preview cannot inspect every distant
summary; an incomplete preview does not establish that a fact is absent. A local
cache reuses redacted metadata after fresh file checks, while content reads,
searches and revision guards stay fresh. A typical recall is:

```text
memory_search({"query":"migration decision","limit":3})
memory_read({"name":"migration","offset":0,"limit":2000})
```

Search returns ranked metadata and short excerpts, not complete bodies. Read
pages report `revision`, `offset`, `nextOffset`, `totalCharacters`, `truncated` and
`offsetUnit: "unicode-code-points"`. Continue at `nextOffset` when needed;
offsets refer to the masked text and never split an emoji. Pass the returned
revision as `expected_revision` on subsequent pages so a changed note refuses
instead of joining different revisions. Name-only reads still
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

New model writes require `expected_revision`: pass `null` to create only, or
read the current page and pass its exact revision to replace. A conflict leaves
the newer note intact; reread and reconcile it rather than removing the guard.

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
inspired by selective recall and concise communication. Authored workspace notes
remain separate from the operational records described above and from Knowledge
learning writes. Local capture and retrieval require no model request; actual
curation still uses the configured provider. No token-saving percentage has been
measured for complete tasks.


Open **Memory & context** below Native Chat to inspect the effective connection,
workspace memory/skill owner and latest context reading. The note browser reads
metadata first and bodies only when selected. You can create a confirmed note,
edit a complete revision or explicitly delete a read revision. Conflicts keep
your draft available for copying/reconciliation. Human inspection does not turn
agent recall on; Knowledge imports remain separate copies. Unsent drafts are
kept in app memory in up to eight slots per host, isolated by profile/workspace;
finish or discard one before opening more. Restart/unload warns while retained
text is dirty, including when another page is open. Drafts are not saved to disk.

Official Anthropic Messages connections offer **Reuse prompt prefixes with
Anthropic**, off by default. Cache creation can cost extra and hits depend on the
model/provider and unchanged prefix. Cache usage lines show only supplied counts;
missing values are not zero, and no universal saving percentage is inferred.
Replayed responses cannot enable caching when the connection has it off or does
not support this setting.

The optional **Estimated input token limit** applies to Native requests using
that connection, including workers and planning. A request over the explicit
estimate or the independent text safety ceiling is held before the next model
call. When operational memory and a supported local archive are available, older
large tool results can first be replaced in the request by exact excerpts and
recoverable archive references. Persisted history, user instructions, assistant
text, tool arguments and tool/result pairing stay intact. A worker has its own
archive; it does not inherit the lead's reader. Archive publication is currently
disabled on Windows. If the request cannot be reduced safely, it remains held.
Review a brief for a fresh conversation or deliberately adjust the limit.
Estimates do not guarantee
fit in a provider's model window. Latest-context readings and per-turn usage are
separate; a request held before sending does not acquire reported usage.

See [Chat orchestration](chat-orchestration.md) for the per-prompt context routine.
See [ADR 0089](../adr/0089-operational-work-memory-and-context-reuse.md) for exact
capture, index, archive and recovery limits.
