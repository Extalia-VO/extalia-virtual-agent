# ADR 0024: Profiles, ACL and vault roots

Status: Accepted (2026-10-22) with the recommended defaults: every existing workspace starts
in one `default` profile and the vault lives under the data directory, with an optional
validated folder later. The owner can still add profiles and move workspaces (gap-map
decision 2).

## Context

PRD v1.1 §17 and FR-17/FR-20 isolate knowledge per **profile** (for example `work`,
`personal`, `client-a`): separate vaults, ACL on graph nodes **and** edges, an optional
shared vault that only receives explicitly published knowledge, no implicit cross-profile
lookup (AC-24, AC-30). Blueprint §4 makes "a profile/workspace a security boundary for
queries, indexes, events, memory, vaults and caches". The gap map (§1 "Profiles") calls a
profile model the prerequisite for FR-15, FR-17, FR-20 and AC-10/AC-24.

Repository facts (working tree, 2026-10-21):

- **"Profile" means five different things today.** (1) The data directory:
  `resolveDataDirectory` (`packages/platform/src/dataDirectory.ts`) documents `~/.extalia-vo`
  (or `EXTALIA_HOME`) as "the Extalia profile", and `packages/host/src/lock.ts` allows one
  host per data directory. (2) `config/profile.json` (`packages/host/src/profile.ts`,
  `extalia.profile.v1`): display name and UI preferences only. (3) `HostConfig.profile`
  (`service.ts` `emptyConfig()`): a single `{ id: 'default', name }`, never more than one.
  (4) `Profile` in `packages/core/src/models.ts` (id, name, defaults, `environment` for an
  Office building) and `Workspace.profileId`, which `saveWorkspace` always sets to
  `config.profile.id`. (5) Runtime and provider profiles (`runtimeProfileId` for Hermes,
  `providerProfileId` = connection id).
- **Isolation is per workspace, not per profile.** Workspace data lives in
  `<data>/workspaces/<id>/` (`paths.ts` `dataLayout`), including Markdown memory notes in
  `<data>/workspaces/<id>/memory/<name>.md` (`MemoryStore`, `packages/host/src/memory.ts`:
  flat files, name pattern `^[a-z0-9][a-z0-9-]{0,63}$`, 20 000 characters, credentials
  masked by `redact`, no front matter, scope, id or provenance) and the W0
  `skill-consent.json`. `deleteWorkspace` removes the folder. User skills (`<data>/skills`),
  connections, observations and the mission database (`<data>/state/missions.sqlite`) are
  global to the data directory.
- `DATA_LAYOUT` (`dataDirectory.ts`) already lists a `profiles` folder, but the host's
  `dataLayout` does not create it. Every folder is private (0700/0600, `paths.ts`).
- Protocol `MemoryScope` (`packages/protocol/src/orchestration.ts`) has `mission`,
  `workspace` and `global` (with `exportApprovalId`), no profile. v0 events carry
  `sessionId` but no workspace or profile; observed sessions are not bound to a workspace
  unless matched (`observedWorkspace.ts`).
- The Rust core will own `<data>/state/core.sqlite` with `profile_id` on each table
  (ADR 0019, audit PR 5); ADR 0019 left open whether knowledge tables share that file.

## Options considered

**Profile boundary**

| Option | For | Against |
| --- | --- | --- |
| A. One data directory per profile (`EXTALIA_HOME`) | Physical isolation for free; already works | One host per data directory: two profiles cannot run at once; connections, Office and observations duplicated; no shared vault path |
| **B. Profiles inside one data directory; each workspace belongs to exactly one profile** | Matches `Workspace.profileId`; one host, one Office; isolation enforced by the core on every query | Isolation is a code property, so it needs denial tests on every query path |
| C. Many-to-many workspaces ↔ profiles | Flexible | A workspace's memory, events and skill approvals would have no single owner; every ACL check becomes a set intersection. Rejected |

**Vault root (owner decision 2)**

| Option | For | Against |
| --- | --- | --- |
| V1. Always `<data>/vaults/<profile-id>` | Private (0700), inside erase/backup scope, no path validation surface, works without Obsidian | Users who already keep an Obsidian vault elsewhere must open a hidden folder; cloud-sync folders are not used |
| V2. Always a user-chosen folder | Fits existing Obsidian habits | Every profile needs a choice at setup; roots can overlap, move, sit in a synced or shared folder, or inside a repository |
| **V3. Default V1; a user-chosen root per profile as an explicit, validated setting** | Safe default with the V2 escape hatch | Two code paths for path validation; must re-validate on every start |

**Edge ACL**: filter edges by "both endpoints visible" only, vs **edges as first-class rows
with their own `profile_id`**. Endpoint-only filtering leaks existence when a profile B
note links `[[A-only title]]` and the resolver tells B the target exists.

## Recommended decision

1. **Profile = security boundary (option B).** A profile has a stable id
   (`^[a-z0-9][a-z0-9-]{0,63}$`, for example `work`, `personal`, `client-a`), a display
   name and its own vault root, knowledge index, caches, skill activations, approvals and
   learning records. The existing `HostConfig.profile` `default` becomes the first profile;
   no other profiles are created automatically. "Profile" in v1.1 code means only this;
   `config/profile.json` is renamed in docs to *user preferences* (no security meaning) and
   the data directory is called the *data directory*.
2. **Workspace binding.** `Workspace.profileId` is required and fixed at creation. Moving a
   workspace to another profile is an explicit user operation that revokes the workspace's
   skill activations, session grants and pending approvals and does not move knowledge
   (open question 3). A session, mission, task, event, approval and evidence record
   inherits the profile of its workspace; the profile id is **resolved by the host/core from
   the workspace**, never taken from model, skill, note or observed input. Observed sessions
   not matched to a workspace have no profile and are excluded from knowledge and learning
   until the user assigns them.
3. **Scope token.** Every core query (SQLite, vault reader, graph, memory, skill router,
   caches) takes a `ProfileScope { profileId, workspaceId? }` built by the core from the
   session. No query API accepts a raw path or a profile id from a tool argument. Caches are
   keyed by `(profileId, policyVersion, indexGeneration)`. Every row in `core.sqlite` and
   every knowledge index row has `profile_id NOT NULL`; cross-profile foreign keys are
   rejected by constraints.
4. **ACL on nodes and edges.** Nodes (notes, skills, tasks, projects, agents) and typed
   edges (`related_to`, `learned_from`, `depends_on`, `supersedes`, `used_by`, plus
   wikilinks) each carry `profile_id` and a visibility (`profile`, or `workspace` for
   workspace-scoped memory). A query returns an edge only if the edge row and both endpoints
   are visible in the scope. Link resolution runs **only inside the source note's profile
   (plus the shared vault)**; an unresolved target is reported as "missing" whether or not
   another profile has that title, so ACL denial and non-existence are indistinguishable
   (AC-24). Content, title, aliases, backlink counts and graph degree are all filtered.
5. **Vault roots (V3, answers decision 2 if accepted).** Default
   `<data>/vaults/<profile-id>/` (created 0700). A profile may instead name a user-chosen
   folder, accepted only if it is absolute, exists, is not a symbolic link, resolves
   (`realpath`) outside the data directory's other folders and outside every other profile's
   vault root (no nesting either way), and is not inside a workspace's project folder
   (warning, override needs confirmation). Roots are re-validated at every start; a missing
   or moved root disables that vault (read-only "unavailable"), never falls back to another
   path. Files are read through canonicalized paths below the root; symlinks inside a vault
   are not followed. The knowledge index is a **per-profile rebuildable SQLite file**
   `<data>/profiles/<profile-id>/knowledge.sqlite` written only by the core (ADR 0019 single
   writer); deleting it triggers a rebuild from Markdown. Authoritative state (skills,
   approvals, evidence) stays in `core.sqlite` with `profile_id`.
6. **Shared vault, publish only.** `<data>/vaults/shared/` (or a validated user root) is
   off by default. Content enters it only by an explicit user action per note revision:
   redaction pass, preview of the exact bytes, confirmation, then a copy with provenance
   (`published_from` profile, source revision hash, publisher, time). Profiles read the
   shared vault; nothing in it links back into a private profile (outgoing links to private
   notes are stripped or turned into plain text on publish). No automatic federation and no
   agent-initiated publish; a `global` `MemoryScope` requires its `exportApprovalId`.
7. **Memory note migration (W5).** One-time, idempotent import per workspace:
   `<data>/workspaces/<id>/memory/<name>.md` → `<vault>/Projects/<workspace-id>/Memory/<name>.md`
   with front matter `id: mem.<workspace-id>.<name>`, `kind: memory`, `profile`,
   `scope: workspace`, `verification: unverified`, `source: legacy-memory`, and the source
   SHA-256. Originals are left in place read-only and never deleted by the migration; a
   marker records source digests so a rerun skips unchanged notes and turns changed ones
   into conflict copies. Imported notes are untrusted agent output (ADR 0027) until
   verified. `memory_*` tools keep their names and read/write the vault location after the
   cutover, still restricted to the session's workspace scope.

## Consequences

- W5 needs a profile CRUD API, a profile picker on workspace creation, a `profiles`
  folder in the host layout, and denial tests for every query path (node, edge, backlink,
  search, cache, memory tool, skill router) before any vault code ships.
- Single-profile users see no change except the vault folder.
- Profile isolation is enforced by the core, not by the OS; a process running as the same
  user can still read every vault. This is stated in `security.md`, not implied away.
- Erasing a profile removes its vault (only if under the data directory), index, caches and
  `core.sqlite` rows; a user-chosen vault folder is never deleted by Extalia.

## Open questions for the owner

1. **Decision 2:** accept V3 (default under the data directory, optional validated
   user-chosen folder), or V1/V2 only?
2. Which profiles to start with, and which existing workspaces belong to each (all to
   `default` is the proposed migration)?
3. Can a workspace move between profiles at all; if so, does its workspace-scoped memory
   move with it or stay behind as read-only?
4. Are connections (provider credentials) shared by all profiles, or can a profile
   restrict which connections it may use?
5. Should the Office show one building per profile (`Profile.environment` exists) or one
   campus for all profiles with profile labels?

## Amendment (2026-10-23): knowledge index schema and link resolution (W5 slice 1)

W5 slice 1 (`crates/extalia-core/src/knowledge/`, schema
`crates/extalia-core/src/knowledge/schema/0001_index.sql`) fixes decisions 3–5 for notes as
follows; the module documentation is the normative text. Markdown stays the authored truth:
the indexer never writes a note.

- **Index file.** `<data>/profiles/<profile-id>/knowledge.sqlite`, separate from
  `core.sqlite`, with its own `user_version` (schema 1) and migrator following ADR 0019:
  sibling lock `knowledge.sqlite.lock` taken before the file is read, WAL,
  `synchronous=FULL`, foreign keys, exact-schema and integrity check on open, `0600` files in
  a `0700` directory, fail closed on a newer or foreign schema. It is derived data: no
  pre-migration backup; `KnowledgeStore::recreate` discards it and a full rebuild restores it.
  `knowledge_index_state` names the single owning profile (opening it for another profile
  fails) and a `generation` that increases with every graph change (cache key, decision 3).
- **Tables** (every row `profile_id NOT NULL`, children reference parents by composite keys
  including `profile_id`): `knowledge_documents` (path, size, mtime, SHA-256, `indexed` or
  `skipped` with reason, claimed id of a duplicate); `knowledge_nodes` (`node_id` = front
  matter `id` or `path:<path>`, path and lowercase resolution keys, kind, display title, tags,
  `visibility` = `profile`, and ADR 0027 provenance: `origin` = `vault`, `trust_status` =
  `untrusted`, source SHA-256, source mtime (`occurred_at`), `observed_at`, and the front
  matter `verification`/`revision`/`source_task_ids` as `declared_*` mirrors that never grant
  trust); `knowledge_aliases`; `knowledge_edges` (one row per link occurrence: type
  `links_to | related_to | learned_from | depends_on | supersedes | used_by`, embed flag, line,
  written and normalized target, heading, display text, resolved `target_node_id` or
  `missing`/`ambiguous`, `visibility`, source SHA-256); `knowledge_edge_candidates` for
  ambiguous links; view `knowledge_backlinks`; contentless FTS5 `knowledge_fts` (title,
  aliases, body; the bundled SQLite enables FTS5, no new crate). Workspace-scoped visibility
  (memory import) arrives with a schema change and a rebuild.
- **Vault root (decision 5).** Default `<data>/vaults/<profile-id>/` (`0700`), a real
  directory whose canonical path is inside the data directory, re-validated before every
  sync; a user-chosen root is a later setting. The walker never follows symbolic links,
  ignores names starting with `.` (`.obsidian/`, `.trash/`, `.git/`), treats only `*.md` as
  notes, refuses (reports) symbolic links, special files, hard-linked files, non-UTF-8 names
  and too-deep folders, reads a note only through the inode the walk saw, skips notes over
  1 MiB or not UTF-8, and fails the whole sync (index unchanged) above 20 000 notes,
  200 000 entries or 256 MiB of notes. Owner may change these caps.
- **Front matter.** A strict YAML subset (scalars, flow and block sequences of scalars);
  typed keys `id` (`^[a-z0-9][a-z0-9._-]{0,127}$`), `kind`, `profile`, `verification`,
  `source_task_ids`, `revision`, `aliases`, `tags`; other keys are kept by name and ignored.
  Invalid front matter skips the note (`invalid_front_matter`). A `profile` other than the
  vault's skips it (`profile_mismatch`); it is never indexed, so links to it are `missing`.
- **Wikilinks.** `[[T]]`, `[[T|display]]`, `[[T#Heading]]`, `[[T#^block]]`, `[[folder/T]]`,
  `[[./T]]`, `[[../T]]`, `[[/T]]`, embeds `![[…]]` (links with `embed`), `\|` as separator in
  tables. Not links: fenced code, inline code spans, `\[[`, empty targets (`[[#Heading]]`).
  A line labelled `Related:`, `Learned from:`, `Depends on:`, `Supersedes:` or `Used by:`
  gives its links that edge type; other links are `links_to`.
- **Resolution (decision 4).** Targets are normalized (`.`/`..` applied, `./`, `../` relative
  to the source folder and `/` vault-absolute are *path-only*, `.md` removed) and compared by
  Unicode lowercase. Tiers, first tier with candidates wins: (1) exact vault path, (2) unique
  path suffix for `folder/Note` forms, (3) title = file name without `.md`, (4) front matter
  alias. Several candidates in a tier resolve only when exactly one matches the written case;
  otherwise the link is `ambiguous` and keeps its candidates (sorted by path), and lower tiers
  are not consulted. No candidate: `missing`. Only same-profile indexed notes are candidates,
  so a denied link is stored and returned exactly like a missing one. Cycles and self-links
  are allowed; the local graph query is bounded (depth ≤ 3, ≤ 500 nodes).
- **Sync.** Incremental by file: unchanged size and mtime → not read (except within 2 s of
  the sync start); otherwise SHA-256 decides. Duplicate front matter ids go to the smallest
  path (others `duplicate_id`), re-evaluated whenever a claimant changes. Renames are detected
  by content hash and reported; a `path:` id follows the path, so notes that need identity
  across renames carry an `id`. Every edge whose key matches a key of a changed note is
  re-resolved; a rebuild runs the same steps from empty and yields the same rows.
- **Queries** take a `ProfileScope` (decision 3); another profile's scope sees nothing, and
  edges, backlinks, candidates, search hits and local graphs are filtered by profile and
  visibility. Returned note data is untrusted (ADR 0027).

## Note (2026-10-23): safe note writes and memory import (W5 slice 2b)

`crates/extalia-core/src/knowledge/write.rs` and `import.rs` (core only; no daemon wiring
yet) implement the PRD sync contract and decision 7; the module documentation is normative.

- **Writes** are compare-and-swap: the caller passes `Absent` or the SHA-256 of its read;
  the note is hashed before and again right before an atomic rename (temporary hidden file
  in the same folder, `fsync`, rename or no-replace hard link for new notes, folder
  `fsync`). On a mismatch nothing is replaced: the proposal becomes a conflict copy
  `Name (conflict <yyyymmddThhmmssZ> <8 hex>).md` whose `id`, `aliases` and `managed_by`
  are renamed `conflict_*` and which gains `conflict_of`/`conflict_base_sha256`, so it is
  indexed as a separate note. Paths follow the walker's rules; symbolic links, special
  files and hard links on the path refuse the write. A change landing between the second
  hash and the rename (one system call) is a documented residual race.
- **History**: `<data>/profiles/<profile-id>/knowledge-history/` keeps every replaced and
  written version content-addressed (`objects/<sha256>`) and an append-only
  `journal.jsonl` (create, update, rollback, conflict = review record); `0600` files in
  `0700` folders. `rollback` restores a version from the note's own history through the
  same compare-and-swap path. Nothing deletes or moves notes; retiring a note is left to an
  explicit user action in a later slice.
- **Ownership**: Extalia may only create notes marked `managed_by: extalia` and only replace
  notes that are still marked; otherwise its update becomes a conflict copy. A front matter
  marker is used instead of an `Extalia/` folder because decision 7 and the PRD taxonomy
  place Extalia-written notes beside user notes, and it survives renames; deleting the line
  hands the note to the user. The marker grants no trust (ADR 0027).
- **Memory import** (refines decision 7): target `Projects/<workspace-id>/Memory/<name>.md`,
  `kind: knowledge` instead of `kind: memory` (not in the PRD taxonomy; legacy notes carry
  no task evidence for `experience`), plus `scope: workspace`, `workspace_id`,
  `verification: unverified`, `managed_by: extalia`, `source: legacy-memory`,
  `source_path` (data-directory label), `source_sha256`, `imported_at`,
  `masked_credentials`. Originals are only read, not made read-only (the host keeps writing
  them until the cutover), and never deleted. The marker is
  `knowledge-history/memory-import.json`: unchanged sources are skipped, changed sources
  become a new revision when the vault note is still what the import wrote and a single
  conflict copy otherwise; notes the user removed are not recreated. Bodies pass a Rust
  port of the host's `redact` patterns; masked values stay masked.

## Note (2026-10-23): knowledge index on the daemon wire (W5 slice 2a)

The index is served read and sync only over daemon contract v1, additively
(`packages/protocol/src/daemonKnowledge.ts`; `crates/extalia-daemon/src/knowledge.rs`):
`knowledge.status`, `knowledge.sync` (`incremental | rebuild`), `knowledge.node` (by node id
or vault-relative path), `knowledge.links`, `knowledge.backlinks` (paginated by offset),
`knowledge.search` (query ≤ 200 characters, ≤ 50 hits, bounded single-line snippet) and
`knowledge.graph` (depth ≤ 3, ≤ 500 nodes). A daemon advertises them only with a data
directory and serves its one `--profile`; the wire carries no profile id and no absolute
path (the root is reported as the label `vaults/<profile>`).

- `knowledge.sqlite` is opened lazily with its own lock; failure reports `unavailable` with a
  reason (`index_locked`, `index_corrupt`, …) and never stops the daemon. Only an explicit
  `rebuild` discards an index that failed its schema, integrity or owner check.
- The default vault root is created on the first sync only. A root that disappears after
  notes were indexed is `vault_unavailable` and is not recreated empty (decision 5: never
  fall back).
- `knowledge.node` returns the body after the front matter only, ≤ 256 KiB, read with the
  write path's reader (walker path rules, no links); `bodyStatus: changed` when the file no
  longer matches the indexed revision. Pages and graphs stop at a byte budget so every frame
  stays below 1 MiB.
- Known gap: the walker indexes file names containing control characters; such notes cannot be
  addressed over the wire (their ids fail the node id pattern) and are left out of lists.
  The walker should report them `invalid_name`.

## Note (2026-10-24): whole-vault overview on the daemon wire

`knowledge.overview` (`{ nodeLimit? ≤ 2000, edgeLimit? ≤ 8000 }`, both defaulting to the cap)
returns a bounded whole-vault graph for a lightweight 3D view, profile-scoped like every other
query: `generation`, `totalNodes`, `totalEdges`, `truncated`, `nodes` (`nodeId`, `title`,
`path`, `kind`, `folder` — the vault-relative parent, `""` at the root — at most 8 tags of at
most 64 characters, `degree`/`inDegree`/`outDegree`, `modifiedAt` from the source mtime) and
`edges` (`source`, `target`, `type`).

- Edges are resolved links between two different visible notes, one per (source, target,
  type); ambiguous, missing and self links are left out. Degrees count that edge set over the
  whole vault.
- When it does not fit, notes are kept by degree descending then node id, and edges among the
  kept notes by the summed degree of their ends descending (then source, target, type).
- Ranking is one aggregate SQL query per list (the kept ids pass as one JSON parameter to
  `json_each`); no per-node reads. The daemon stops nodes at 576 KiB and edges at 928 KiB of
  JSON so the result stays below the 960 KiB result cap; `truncated` is set whenever either
  list is shorter than its total.

## Note (2026-10-24): note writes, history, memory import and custom vault roots on the wire (W5 slice 2c)

The slice 2b write path is served over daemon contract v1, additively
(`packages/protocol/src/daemonKnowledge.ts`; `crates/extalia-daemon/src/knowledge.rs`):

- `knowledge.read { path }` → `{ path, sha256, managed, body, truncated }`: the whole file
  exactly as stored (front matter, BOM and control characters included), at most 256 KiB of
  UTF-8 and of the JSON budget; `sha256` covers all bytes and is the `expectedSha256` of a
  later write. A truncated body must not be written back.
- `knowledge.write { path, content ≤ 1 MiB UTF-8, expectedSha256?: hex | null, author: 'user' }`
  → `{ outcome: written | unchanged | conflict, path, sha256?, previousSha256?, conflictPath?,
  conflictReason? }`. Absent and `null` both mean "must not exist". Only `user` is a wire
  author; Extalia-authored writes stay daemon-internal. On a conflict `sha256` is what is on
  disk now.
- `knowledge.history { path, limit ≤ 50 }` → entries newest first: `write`, `rollback`,
  `conflict` (`sha256` = the copy, `conflictPath`) and `external`, derived when a journal
  entry's previous content differs from what Extalia last left at the path (author
  `external`). `knowledge.rollback { path, toSha256, expectedSha256: hex | null }` restores a
  version of the note's own history through compare-and-swap.
- `knowledge.importMemory { workspaceId, dryRun? }` reads only
  `<data>/workspaces/<workspaceId>/memory/` (the host's `MemoryStore` folder); `dryRun`
  (core `preview_memory_import`) predicts every outcome without writing a note, the journal
  or the marker. Results list at most 500 notes (byte-budgeted, `truncated`) with counts of all.
- After a write, rollback or import that changed the vault, the daemon runs an incremental
  sync. The default root is created by a write only under the first-sync rule; a root that
  vanished after indexing stays `vault_unavailable`.
- **Custom vault root (decision 5, V3).** `extalia-daemon --vault-root <absolute dir>` (with
  `--data-dir` only; a relative path exits 2). Core `Vault::open_custom`: an existing real
  directory (the root itself not a symbolic link), never created, not the file system root,
  not the data directory or an ancestor of it, not inside it except below the profile's own
  default root (so never `<data>/state`), canonical path pinned for the process; the daemon
  also refuses the home directory and its ancestors. An invalid, missing or moved root makes
  the vault unavailable (never a fallback) and never stops the daemon. `knowledge.status`
  reports `vaultRoot` as `custom:<last folder name>` (sanitized, ≤ 128 characters), never a
  path. Overlap with another profile's root or a workspace project folder is the host's check
  (one daemon sees one profile). The journal and index are per profile, not per root:
  switching roots re-indexes and keeps history keyed by vault-relative path.
- Refusals: `invalid_request` (`invalid_path`), `capacity_exceeded` (`too_large`), `denied`
  (`not_utf8`, `unsafe_path`), `not_found` (`note_not_found`, `unknown_version`),
  `storage_failure` (`history_unavailable`, `vault_unavailable`, `io_failure`).
