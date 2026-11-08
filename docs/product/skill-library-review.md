# Skill Library visual review

Initial library implemented in v0.4.177 alongside the Knowledge entry fix (ADR 0051). In-place book interaction refined in v0.4.178.

The supplied Bookshelf and Ashen Press exports inform the bookshelf and book
inspector interaction. Extalia uses its installed Three.js with original
procedural book geometry, local CanvasTexture covers and existing host data.
The exported demo renderers, fixed sample collections, embedded artwork, remote
fonts and extra Three.js versions are not bundled. This is an adaptation of the
visual concept for the Skills page.

- Bundled definitions, local project review entries and exact registry revisions
  retain distinct identities, sources, status and hashes. Unknown external
  categories remain uncategorized; absent instruction bodies remain unavailable.
- Search, source and category filters share the accessible book index. Shelves
  contain at most eighteen entries, with pagination over the received catalog.
- Selecting a cover pulls that same volume forward, opens its hinged cover and renders actual metadata/instructions on local page textures. A curved two-sided leaf turns forward/backward; closing folds the cover before returning the volume to its original slot. There is no separate inspector or automatic scroll.
- Desktop spreads show two pages; compact shelves show one page. Copyable text, list mode and 3D failure use the same scene area. Focus remains within the book/index without scrolling; Escape, arrow keys, page clicks and horizontal swipes are supported. Registry import/review/activation and workspace consent stay in skill management.
- The renderer is lazy, uses demand frames and capped pixel density, pauses when
  the document is hidden and disposes geometry, textures, materials and listeners.
  StrictMode canvas reuse and context-loss fallback are handled explicitly.

Browser verification used local mock data and a production Bridge with a
synthetic temporary profile, the default TypeScript mission backend and a real
Rust index sidecar. The host started no daemon before Knowledge use. Directly
connecting a synthetic Obsidian folder indexed its two notes and resolved a
wikilink, without changing its `.obsidian/app.json`. Switching back to the
profile vault cleared the selected note and search.

The Skills bookshelf, selection, search, list switch, literal instruction spread,
context-loss fallback and restoration were exercised in Chrome. English and
Indonesian layouts were checked in light/dark themes and at 390 px width without
horizontal overflow. The mock Office emits existing React cleanup warnings;
the production Bridge flow recorded no browser errors. Unit and full repository
checks cover data identity, filters, instruction preservation, queue ordering,
failed settings saves and unresolved work guards.

Final validation: `pnpm check` passed at v0.4.177 (5,499 TypeScript tests passed, 23 optional cases skipped; 453 Rust tests passed, plus lint, typecheck, builds and asset checks).

The v0.4.178 motion model is time-based, finishes the current leaf before changing books, retains the latest selection through rapid clicks and stops requesting frames when settled. Tests verify ordered pull/open/close/return transitions, frame-rate independence, reduced motion and literal Unicode text preservation with bounded word-wrapped pages.

Production Chrome verification for v0.4.178 opened a canonical bundled five-page skill, turned a curved leaf from pages 1–2 to 3–4 and closed it back into the shelf. The canvas identity and every ancestor scroll offset stayed unchanged, with no page errors. Mobile (390 px) exercised single-page reading, page-surface clicks, next/previous controls and Escape; it retained the same scroll offsets and had no horizontal overflow. A short desktop capture is stored with the local review artifacts.

Final v0.4.178 validation: `pnpm check` passed (5,504 TypeScript tests, 23 optional cases skipped; 453 Rust tests, lint, typecheck, builds, versions and asset checks).

The production mobile review also checked Indonesian controls in light/dark themes, reduced-motion opening and copyable literal text. A simulated context loss removed the canvas while retaining the same reader text and scene position.

The v0.4.180 refinement names the collection **Grimoire** in navigation and
page headings while retaining skill terminology in instructions and management.
Physical volumes use deterministic local foil artwork, cloth weave, binding,
layered paper edges and a ribbon. The same in-place reader uses editorial serif
prose, monospaced code and a lit curved leaf. The viewpoint is fixed; reading
requires no orbit controls. Scene background and overlaid tools follow the
application's theme and material tokens; paper retains its physical warm tone.
No upstream artwork, runtime or external font is bundled.

Production v0.4.180 Chrome review opened a real bundled volume by clicking its
cover, turned forwards/backwards and closed it, preserving canvas identity and
every ancestor scroll offset. The local video captures the full sequence.
English/Indonesian and light/dark phone layouts retain controls below the paper.
Secondary clicks leave the page unchanged; cancelled/secondary pointer gestures
are ignored. Reduced motion settles without an ongoing loop. Forced WebGL
context loss removed the canvas and retained literal selectable text in exactly
the same 316 × 562 px scene area at the same viewport position, without horizontal
overflow. No browser errors were recorded in the production flow.

Final v0.4.180 validation: `pnpm check` passed with 5,520 TypeScript tests
(23 optional cases skipped), 453 Rust tests, lint, typecheck, all builds,
version consistency and asset checks. No commit or publication was performed.

The v0.4.181 reader update makes **Book** and **List** mutually exclusive. Book uses
only a bounded physical shelf and native keyboard picker; List uses only its
bounded text index and same-area text reading. Catalog pages show 18 books or
12/24/48 list entries, with direct page jumps. An index normalizes received
metadata once per catalog change. Selecting a book retains literal source text;
contents and in-book search map source offsets across visual page boundaries,
ignore fenced/indented code as headings, and use bounded Unicode-safe snippets.
Navigation closes on a jump so the physical page-turn stays visible.

The optional platform/host metadata page method continues the initial exact
500-raw-row report in pages of at most 99 raw rows, excluding builtin rows from
registry display. Cursors use existing daemon semantics and are not snapshots.
The reader compares every response generation to the initial report, checks
cursor progress, and appends at most five pages atomically per user action.
Host/profile/workspace/refresh replacement invalidates late responses. Counts
refer to loaded volumes, not an unknown whole-registry total, and each exact
revision retains its identity. Older hosts keep the explicit truncation warning.
No instruction bodies or scanner/activation operations are requested by paging.

Collapsed management does not mount its heavy sections until explicitly opened.
Its native disclosure keeps mounted form state after first use. The built-in
catalog anchor opens and mounts the section before revealing its target.

Production browser scale QA used synthetic RPC metadata for 1,000 quarantined
registry revisions plus eleven canonical bundled skills. The initial 500 and
subsequent 495/5 rows loaded successfully; the last revision was searchable.
List rendered exactly 24 or 48 catalog cards and the last page had three rows;
Book kept eighteen volumes with no visible card index. An open canonical book
retained the same canvas and reading phase while loading more metadata. A forced
generation change left the original 511 loaded volumes intact and showed the
refresh guidance. Backend tests separately cover 1,207 synthetic rows, transport
validation, exact bounds and existing real-daemon regressions.

English/Indonesian phone QA verified in-book result/page jumps, exclusive modes,
literal fallback and no horizontal overflow. Closed management contained only its
summary; its built-in link opened, mounted and revealed the target heading.

A final partial-shelf regression exercised seven visible volumes on catalog page
29, opened the final volume, and appended the remaining metadata. The same canvas
and reading phase retained seven visible volumes; after the close/return animation,
the shelf revealed eighteen. The picker and visible-range count follow that
snapshot until it rests, while loaded totals continue to update.

Final v0.4.181 validation: `pnpm check` passed with 5,570 TypeScript tests
(23 optional cases skipped), 453 Rust tests, lint, typecheck, all builds,
version consistency and asset checks. No commit or publication was performed.
