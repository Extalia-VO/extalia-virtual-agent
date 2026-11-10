# Built-in skills

Open **Grimoire** in the sidebar for the skill bookshelf. Each skill is presented as a clothbound volume with local cover artwork, a spine, paper edges and a bookmark. Search and filter real built-in, project and registry entries; each exact registry revision has its own book. **Book** shows only the physical shelf; **List** shows only the text index. The shelf also has a native book picker for keyboard access. Switching modes keeps the selected volume in view. Select a cover to animate that same volume out of the shelf and open it in place. Its page surfaces show real metadata and literal instructions. Click a page, swipe horizontally, use the arrow keys or the Previous/Next controls to turn a leaf. Close book or Escape closes the cover and returns the volume to its shelf slot, without automatically scrolling the app.

**Contents & search** opens navigation inside the same reader. Choose a literal Markdown heading, search page text or enter a page number; selecting a result closes navigation and turns the same book to its spread. Escape closes navigation first, then the book. Search input arrow keys remain available for editing.

For a growing collection, Book renders at most eighteen volumes and List renders twelve, twenty-four or forty-eight entries per catalog page. The catalog pager can jump directly to a page. Catalog search indexes loaded metadata once and never searches instruction bodies; in-book search operates only on the selected book's available text.

A supporting host provides **Load more skills** when its initial bounded registry report has more revisions. One action fetches at most five continuation pages of ninety-nine raw rows. Counts and filters cover loaded volumes, including each exact revision separately; they are not an unknown registry-wide total. A changed generation rejects the incoming batch and asks you to refresh. Older hosts keep their explicit truncated-report warning. Opening books never imports, inspects, approves or activates a skill.

**Skill management & security** mounts its heavy sections only when first opened; it retains the existing scanner and consent workflow.

Small shelves show one readable page at a time. **Readable text** provides selectable text inside the same scene area; unavailable 3D and List mode use that same-area fallback. Reduced motion goes directly to the open/closed state. External metadata is shown without inventing instruction bodies or categories.

Hover over a closed book to see its title and category in a cursor-following
preview with a short fade, without a flying or sliding entrance. List entries
also reveal this information on keyboard focus. Escape dismisses the preview.
Changing filters, scrolling or opening a book clears it.
On first opening Grimoire, changing filters or paging the catalog, books fly
from outside the shelf view along curved paths and settle into their slots one
in a flowing sequence. Teal and gold magic dust follows the flying books, and a
category-colored smoky aura rises and curls around the hovered volume until the
cursor leaves; brief sparkles add an accent. Faint wisps cross the front lower
edge while leaving the title clear. Both smoke layers stop at the book foot
and shelf surface, so they cannot spill below the rack. The animation runs only
during hover and stops after the exit fade. All three shelf rows
remain visible for every filter, including an empty result. Decorative
motion finishes at rest, pauses when hidden and respects reduced motion; the
book reader and skill review permissions are unchanged.

The visual concept follows [Bookshelf](https://threeui.com/three-js/bookshelf) / [Ashen Press](https://threeui.com/ashen-press); the implementation uses Extalia’s installed Three.js with procedural covers, local canvas text, demand rendering, bounded shelves and complete teardown. No external runtime, fonts or artwork are downloaded.

**Skill management & security** retains import, review and consent controls. **Browse built-in skills** opens that section and jumps to the existing catalog.
It is available with both the TypeScript host and the preview Rust core; it does
not require importing a package or configuring a scanner.

The current app bundles twelve instruction sets:

| Category | Skills |
| --- | --- |
| Planning | `plan-feature`, `memory-recall`, `orchestrator` |
| Development | `debug-issue`, `refactor-safely` |
| Quality | `code-review`, `write-tests` |
| Security | `security-review` |
| Documentation | `explain-codebase`, `update-docs`, `caveman` |
| Delivery | `commit-changes` |

Search matches names, descriptions and category labels. Multiple search words
must all match. Category buttons show counts for the entire received catalog;
the match count shows how many remain after both filters. **Clear filters**
returns to the whole catalog. Search does not inspect instruction bodies.

**Read instructions** opens the bundled text as a read-only disclosure, with
ordinary keyboard controls. It is displayed literally: Markdown, HTML and code
inside instructions are never executed by the preview. The text is supplied by
the host and is not translated when you change interface language.

An older host can still list names and descriptions without extra metadata.
Such entries appear under **Uncategorized** and the disclosure explains when
instructions are not included. Unknown categories and malformed/oversized body
metadata are omitted rather than invented or silently truncated. Catalog
filters and open disclosures are temporary view state.

This is a catalog of the bundled definitions, not a report of the exact skill
revision offered to an individual agent. Agent offerings now use canonical
shipped definitions: an external file cannot replace one by using the same name
or claiming a builtin source. External instructions require the scanner-gated
registry workflow. Reading text and choosing a category do not run a skill, select
it for a task, change permissions, import a package, or approve an activation.

`orchestrator` explains persistent team checks, role-based delegation and compact
briefs. Native enforces the saved team state independently of whether skill tools
are enabled; reading this skill does not create a team or activate delegation.
See [Chat orchestration](chat-orchestration.md).

`memory-recall` guides selective metadata search and paged reads of relevant
[workspace memory](workspace-memory.md). It tolerates memory being disabled.
`caveman` is independently written concise-response guidance inspired by the
[upstream project](https://github.com/JuliusBrussee/caveman), activated only by
an explicit user request. Technical precision and requests for detail win over
brevity. Neither installs upstream hooks/proxies or automatically receives
upstream updates; changes ship through reviewed Extalia releases.

Imported/project skills retain their existing review and scanner requirements.
Native provides bounded lexical category hints for its initial metadata preview.
Imported and explicitly learned candidates use the pinned SkillSpector integration
on verified macOS 14+ ARM64 builds. A complete inspection still requires separate
user approval and activation; unavailable or incomplete inspection keeps candidates
quarantined. See [Skill Security Center](skill-security-center.md). General
manifest/dependency routing remains separate work under
[V2-16 / #54](https://github.com/Extalia-VO/extalia-virtual-agent/issues/54).

## Native discovery in a growing Grimoire

When Extalia owns the connection's skills, Native starts with canonical built-in
metadata selected for the prompt and a small relevant external preview. The initial
preview contains at most four matching built-ins and eight matching external
references; unrelated prompts can have no preview. Discovery still covers the
full authorized turn inventory. It does not insert every book's
instructions into the prompt. It can discover more metadata and then read the
selected procedure:

```text
skill_search({"query":"review","limit":3})
skill_read({"name":"code-review"})
```

`skill_list` and `skill_search` return at most ten metadata entries per page.
Use their returned `nextOffset` and `snapshot` to continue; keep the same search
query. These tools use a private inventory for the current turn. A newly
activated skill needs a new turn, and revoked or changed revisions fail fresh
verification rather than returning cached instructions. External metadata and
instructions still require the registered scanner workflow. Scanner failure
does not authorize a file/URL fallback.

The Native inventory considers at most 2,048 raw registry rows, including inactive
revisions, separately from the paged Grimoire UI. A truncated inventory is
explicitly incomplete; discovery cannot see beyond that turn's bound. Startup
reads eligible files sequentially for verification, then retains external
metadata and private digests instead of all instruction bodies. This bounds
retention and prompt growth; it does not establish constant startup I/O or
measured token savings.

## Preview routing for imported skills

With a supporting Rust core, the Security Center also offers **Skill routing
preview**. This compares registered revisions; it does not route the built-in
catalog or run a skill.

1. Enter category or intent identifiers from the skill's manifest, separated by
   commas. Parent categories also match declared descendants.
2. Select exact candidate revisions, at most one per package. Optionally choose
   a workspace to check approval applicability.
3. Add exact dependency pins yourself, then choose **Preview matches**.

The report explains matches and exclusions. A tie stays ambiguous even when the
result limit displays only one candidate. Quarantined or inactive revisions,
missing pins, unknown compatibility and permissions outside the empty diagnostic
ceiling can prevent a match. A partial catalog is labelled. No matching result
grants permission or activates anything; the existing scanner and consent rules
still apply. Changing inputs or the host clears old results.

## Related guides

- [Project skills](project-skills.md)
- [Skill Security Center](skill-security-center.md)
- [Native core (preview)](native-core.md)
