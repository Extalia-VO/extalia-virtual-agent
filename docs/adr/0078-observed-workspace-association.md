# ADR 0078: Observed workspace association

Status: Accepted — 2026-11-12

Observed sessions can report a project folder without an Extalia workspace ID.
Chat and the lead character let the user choose an existing workspace whose own
primary or additional folder contains the reported project. If no candidate
exists, register the folder under Workspaces and refresh the association.

Automatic association prefers the deepest physical folder. Equal-depth matches
across workspaces require a choice. The host preserves literal path bytes,
resolves symlinks and rejects unsafe or ambiguous project paths. Each explicit
association records the observed source identity, workspace ID and resolved
project and root. If those no longer match, the association becomes invalid
until reviewed again. The user can restore automatic matching.

The host validates a revision before committing an association, persists it
atomically and refreshes observed state. Existing continuity records remain
scoped to their original workspace. The association changes grouping and
handover eligibility. The source app keeps its conversation and working
directory. External Knowledge, skill retrieval and write access require
separate capabilities.

Host tests cover ambiguous and nested roots, additional folders, restart,
stale revisions, continuity scope and changed or dangling symlinks. A source
path with trailing spaces or a literal POSIX backslash stays distinct from the
registered folder.

The combined v0.4.287 check passed with 9,198 TypeScript and 576 Rust tests,
formatting, Clippy, lint, type checks and production builds. React fixture
browser checks cover Chat and the lead character, stale review and the
Indonesian 390-pixel layout.
