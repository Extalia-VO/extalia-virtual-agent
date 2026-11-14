# ADR 0084: Source-project session browsing

Status: Implemented and verified locally through v0.4.301 — 2026-11-12.

Observe, History and Import retain agent-app roots (Codex, Claude Code,
Antigravity and other detected sources). Each app contains source-project
folders and a separate expandable section for sessions without a source folder.
Connected branch lines make the app/project/session hierarchy visible. A folder label is its
source basename; its identity retains the normalized full source path. Equal
basenames in different directories stay separate. Session titles and source
provenance remain unchanged. Grouping does not copy folders, register managed
workspaces, grant filesystem permissions or change a saved workspace link.

Harness roots, project groups and their sessions sort by latest source activity,
descending, with stable
identity tie breakers. The UI initially requests twelve metadata groups and
twelve sessions in the first expanded folder. Collapsed harnesses do not request
child folders or rows. Closed sections refresh bounded aggregate metadata so
activity counts remain current without fetching their session bodies. More projects and older sessions
require explicit expansion or pagination. Selected conversation content remains
separate from the navigation page. Native import discovery uses the same visual
tree over its discovered metadata; import preview and commit remain explicit.

`sessionBrowserGroups` and `sessionBrowserSessions` validate bounded requests.
Opaque authenticated cursors bind a short-lived immutable metadata snapshot to
the profile, query and group. Updates arriving during pagination do not reorder
already-issued pages. Expired or evicted pages require refresh. Snapshot lifetime
is five minutes and at most twelve snapshots are retained. No transcript is
opened by a browser-page request.

Bridge and Desktop UI polling prefer `getStateSummary`, omitting the imported
library array and providing library/observed counts. The full legacy `getState`
contract remains available. Explicitly unsupported methods permit compatibility
fallback; authentication and network errors remain visible. All observed session
metadata remains in state for the cross-workspace 3D Office. The legacy library
store still loads persisted content into host memory at startup, and mutation
responses retain their full-state compatibility shape. This change bounds normal
UI list traffic and mounted rows, not the storage engine's total startup memory.

The host supervises metadata pagination; platform code contains only pure DTO
grouping, and React owns expansion, request lifecycle and presentation. No model
inference, external harness configuration edit or authorization change is needed.

For the requested main-host rollout, build and validate matching CLI, web and
native artifacts first. Stop only the main host, preserve a complete stopped
profile backup and verify existing identities and history after startup. Keep
the previous runtime for rollback; restore the profile backup together with its
runtime if a data migration must be reversed. Never validate destructive cases
or scratch imports against the real profile.

Validation: the frozen production source passes the complete `pnpm check`
(9,643 application tests, 610 Rust tests, lint, boundaries, types and all builds).
An actual temporary Bridge/browser verifies metadata pages of twelve, older-row
and extra-project requests, search, collapse, retained conversation content,
import preview and narrow/wide layouts. Discovery retains its existing source
scan bound; this is not streaming transcript discovery. Local rollout evidence is kept in ignored `output/harness-tree-rollout` and
`output/playwright/harness-tree`. Actual browser checks cover multiple harnesses
sharing a source folder, source-filtered older pages, current/running markers,
compact laptop headers and fully visible phone composers in all three themes.
The owner deliberately removed the main data and backup folders during rollout;
the final main host therefore correctly opens first-run setup with no saved
workspaces, connections or history. Existing remote harness data is not reset by
this application update.

The original v0.4.299 view used selection marks on the viewed harness, project
and session. The v0.4.301 refinement below supersedes those ancestor marks.
Green Observe counts represent recent accepted source activity, not the imported
library's archival state. The host caches bounded per-actor activity only for
new hooks/transcript deltas in the current run, with a two-minute liveness window.
Waiting, terminal events, pause/unavailability, stale reports and host restart
clear execution indications without deleting stored history. Future clock skew
is bounded and tolerated timestamps are clamped to local receipt time. These
counts confer no permission or tool-control capability.

Observe uses one compact page toolbar and independent transcript scrolling.
The session heading owns title, source/status and folder metadata; its icon
actions occupy a separate column. Smaller outer insets and viewport-based
height leave more room for messages while keeping the composer visible.


## v0.4.301: Project identity and minimal unread indicators

The host resolves verified Git metadata without executing Git or project code.
Main checkout, linked worktrees and nested folders share the repository common
directory identity. Separate clones retain separate identities even with equal
folder names. Bounded metadata files, ancestry depth, concurrency and cache
lifetime limit each resolution; the first cold project request still inspects
its unique source paths. Cursor pages reuse their captured metadata snapshot.

Without Git, registered workspace roots group their nested source folders.
Canonical filesystem paths account for platform aliases; the most specific
registered root wins. Without either verified repository metadata or a
registered root, the exact normalized source folder remains the identity.
Matching folder names alone never merge projects. Observe, History and import
candidate/preview metadata use this identity without changing source working
paths, workspace permissions or portable session contents.

Observe ancestors use no selected-link styling. Each currently working session
has a spinner; an ancestor summarizes running children with one spinner. New
assistant output adds a dot, also aggregated on ancestors. Status, tools and user
prompts do not create unread assistant output. Imported history has no live
activity indication. The selected session keeps a neutral keyboard-accessible
row. Hover/focus edit actions occupy the timestamp line so they cannot hide the
spinner or unread dot.

Output revisions and read markers persist as hashes. Initial history establishes
a read baseline. A read acknowledgement requires the exact output revision,
the actual matching assistant output rendered at the latest scroll position,
a visible Messages panel and a focused visible document. Opening older history,
Files, a background tab or an unfocused window does not clear unread output.
A stale acknowledgement cannot clear a newer revision. Transcript/hook output
arriving in either order is deduplicated.

Validation: the integrated v0.4.301 source passes the complete `pnpm check`
(9,714 application tests, 58 optional skipped; 610 Rust tests; lint, types and
production builds). A production Bridge/browser over temporary fixture data
shows one repository group with three simultaneously running sessions and a
separate non-Git workspace group with two nested-folder sessions. Actual new
assistant output produces a visible unread dot, retained while reading older
messages and cleared after the latest output is visibly read. The final
production bundle retains spinners and dots while row actions are available.
No model requests or source-app configuration edits are needed for these checks.


## v0.4.302: Terminal tree branches

The shared tree draws each elbow on its node, with a vertical continuation only
when another rendered sibling of the same level follows. Singleton and final
section, project and session nodes stop at their header even when their
subtree is expanded. Parent containers keep transparent spacing borders rather
than full-height visible spines. Loading more rows or filtering updates sibling
relationships directly through CSS; no extra session state or backend work is
needed. Bounded import candidate lists let their elbows remain visible outside
the list edge and use the containing navigation scroll region.
