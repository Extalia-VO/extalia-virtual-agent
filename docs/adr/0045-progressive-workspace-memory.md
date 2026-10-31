# ADR 0045: Progressive workspace memory and concise-response guidance

Status: Accepted for Native Chat and Teams; automatic learning remains separate.

## Context

The user requested Claude-Mem-style selective recall and a built-in Caveman
skill. The legacy Native memory path read every note just to build the initial
catalog and offered only list/full-read/write tools. Its metadata grew with the
store and externally edited notes were not masked on reads.

## Decision

- Keep Extalia's existing workspace Markdown store and single memory owner
  (ADR 0005). Do not install Claude-Mem hooks, its worker, a Caveman proxy or
  another application's configuration as part of installing Extalia.
- Inject at most eight note summaries in a tagged JSON catalog of at most
  2,000 characters after escaping. Include known omissions and incomplete scan
  status. Treat metadata, snippets and bodies as untrusted source claims.
- Add literal `memory_search`: small ranked metadata/excerpt results, followed
  by optional `memory_read` pages. Search and list expose source continuation
  offsets and output omissions; partial scans never prove absence.
- Retain normal name-only reads for existing notes up to 20,000 characters.
  Explicit pages use Unicode code-point offsets after masking, with the next
  offset and total length. Larger external notes require paging.
- Bound discovery (4,096 directory entries), per-file reads (80 KB) and each
  scan's accumulated reads (2 MiB), independently of model output budgets.
  Refuse links and nonregular files using bounded no-follow handles where
  available. These checks assume a trusted, quiescent store root; they are not
  a general hostile-filesystem sandbox or profile ACL implementation.
- Offer read tools to team/tier workers; retain `memory_write` for the lead.
  Connections with memory off expose neither notes nor memory tools.
- Bundle independently written `memory-recall` and `caveman` instructions.
  Caveman requires the user's explicit style request, honors requests for
  detail and preserves technical meaning. Reading a skill does not activate a
  persisted mode or execute anything. Existing user/project overrides remain.

## Consequences

Recall needs no vector database or extra summarization model. Small catalogs
and selected pages reduce what this path sends for large note stores, but
character limits are not measured token/cost savings. Conversation history
and legacy name-only reads have their existing independent costs.

This does not implement automatic transcript capture, observation summaries,
fact promotion, Obsidian writes, automatic upstream updating or ADR 0029's
learning loop. The native mission runtime is unchanged. Extalia maintains its
own code and instructions through reviewed releases; optional upstream packages
would need their own compatibility and update policy.

Concept references, not copied implementation dependencies:
[Claude-Mem](https://github.com/thedotmack/claude-mem#how-it-works) and
[Caveman](https://github.com/JuliusBrussee/caveman).
