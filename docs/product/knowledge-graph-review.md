# Knowledge graph explorer review

The visual brief follows the supplied Obsidian graph screenshot and the
[Advanced Graph View reference](https://github.com/n23eos/advanced_graph_view),
alongside the earlier [Neo4j Graph View reference](https://community.obsidian.md/plugins/neo4j-graph-view).
Extalia retains its own indexed Markdown graph, host contracts and renderer;
no external graph database or plugin installation is required.

The graph is the primary Knowledge view when overview is supported. Vault
settings, sync/note tools and explanatory text remain available in compact
sections. Search and display controls overlay the canvas; selected notes open
in a side panel without shrinking its width. Expand, fit and zoom operate on
the same graph. The accessible list and older-host local view remain available.

Structural communities derive from actual loaded edges using bounded,
deterministic modularity moves. Layout groups influence forces without adding
links. Community colors cycle through the palette; bounded legends count exact
keys rather than reused hues. Folder, kind and tag coloring remain available.
2D uses a real two-dimensional force simulation and zero z coordinates; 3D
retains depth, orbit and dragging. Filtering remains a view operation over the
bounded overview and cannot widen profile access.

The background, tool panels, inputs, labels and controls use Extalia's theme
and material tokens. A root-theme observer updates renderer compositing and
fog without replacing the graph. Light mode uses normal alpha compositing and
background-aware edge colors; dark mode uses additive glow. Individual edges
receive stronger contrast in sparse graphs, while dense graphs retain quiet
lines. Line width uses screen-space segment geometry. Small visible points keep
usable pointer targets; idle pulse timers stop and restart on interaction.

Verification uses a temporary real Bridge/profile/index with 61 synthetic
Markdown notes and exactly 76 resolved links, matching the size of the reported
sparse graph. This is separate from the earlier dev-only 1,000-note dense test;
neither test uses or changes a real user vault. Light/dark captures, actual node
selection and layout/filter controls are checked against the real index route.

The v0.4.179 full repository gate passed: 5,520 TypeScript tests (23 optional
cases skipped), 453 Rust tests, lint, typecheck, builds, version consistency
and asset checks. Production Chrome confirmed visible lines in the real 61/76
fixture, same-canvas dimensional/preset/link-toggle changes and real Note010
content with its resolved outgoing links/backlinks. All three surface styles
were exercised in both themes at 390 px in Indonesian with no horizontal
overflow. A subsequent refinement measures the expanded view's actual top to
keep bottom camera controls visible below mobile navigation.

After the mobile height refinement, production camera controls remained within
the 844 px viewport for Standard, Liquid glass and Liquid glass pro at 390 px.

Final v0.4.180 validation: `pnpm check` passed with 5,520 TypeScript tests
(23 optional cases skipped), 453 Rust tests, lint, typecheck, all builds,
version consistency and asset checks. No commit or publication was performed.

The v0.4.181 navigation update adds focus and close actions at the top of visible
selected-note panels. An independent focus trail retains depth and clear actions
when appearance controls or the selected note are closed. The trail uses generic
messages for filtered/missing anchors; filtered selected content stays unmounted.
The expanded grid reserves room for the trail without replacing the canvas.

Production navigation QA on the isolated real 61/76 index focused Note010 to five
notes/four links at depth one and ten notes/twelve links at depth two. Closing
the note kept focus recoverable. Filtering out the anchor showed generic guidance
without its title; clearing focus retained the folder filter and canvas identity.
Indonesian phone controls stayed within the viewport without horizontal overflow.

Knowledge now opts into a full-width main column. At a 1,920 px viewport, the graph
measured about 1,608 px in Standard, 1,601 px in Liquid glass and 1,580 px in Liquid
glass pro. Symmetric main-column gutters measured 32/32/40 px respectively; no
horizontal overflow occurred. The 390 px phone view retained a 346 px graph with
22 px outer margins in the pro template. Expanded mobile navigation keeps its
natural rail height, and selected-note sheets anchor inside the graph body so
focus/close controls remain visible across glass containing blocks.

Sidebar modules are Workspace, Library, Activity and System. Knowledge and
Grimoire live together in Library; observation moves ahead of managed actions in
the observe workflow. Capability gates, pending badges, compact/hover behavior,
static-host availability and Office landing behavior remain unchanged.

Final v0.4.181 validation: `pnpm check` passed with 5,570 TypeScript tests
(23 optional cases skipped), 453 Rust tests, lint, typecheck, all builds,
version consistency and asset checks. No commit or publication was performed.

The v0.4.186 contrast refinement replaces additive path blending with normal
compositing in both themes. Linear-RGB edge colours combine endpoint hues with
neutral theme contrast and adapt to visible edge density. The new presets use
readable screen-space widths; focused links stand out while unrelated links dim.
Filtered geometry still collapses. Paths do not receive fog, so distant real
links remain visible. Halos retain their theme-specific compositing.

Nodes use a small view-space shading shader with soft directional highlights,
light-theme rim depth and existing instancing/geometry. Selected, hovered and
active search nodes receive a separate ring contribution in the existing Points
draw, including when decorative glow is off. No texture, scene light, extra
geometry or additional draw call is introduced. Fog uniforms are explicitly
provided for the shaded core material.

Regression tests measure the actual edge-buffer colours against both theme
backgrounds and compare normal, focused and muted links. They also cover fog
uniforms, ring selection without glow, mask suppression and the existing gesture,
layout and worker lifetime contracts. Production WebGL QA uses a temporary real
Bridge/index with 61 notes and 76 resolved links: visible paths, shaded cores,
2D/3D, selecting and reading a note, glow-off ring and link visibility checked.
All three surface templates switch light/dark on the same canvas without errors.

The v0.4.191 refinement replaces pearl shading and icosphere geometry with
camera-facing emissive star discs. Each core uses two triangles, stays within
2.4–12 CSS pixels, preserves assigned hues and writes depth so the visible front
star agrees with projected picking. Smaller procedural halos and a cool
blue/cyan/violet/rose/gold palette follow the supplied Advanced Graph View image.
The existing three graph draws, worker layout, bounds and idle frame lifecycle
remain in place. Lower shared DPR levels are honoured instead of forcing 1×.

Paths are finer, antialiased and quieter at high link density. Dark paths fade
with depth; light paths keep a stronger density floor without fog, so pale
backgrounds do not erase them. Sparse paths retain their theme-aware contrast.
Backdrops retain the app canvas tint, deepened in dark mode. Controls and legends
use opaque theme surfaces on glass templates. Selected rings keep a bounded
minimum screen size even with decorative glow off. Refreshing a graph initializes
materials in the current theme, including light mode.

Real temporary Rust indexes exercise 1,000 notes with 3,970 resolved directed
links (3,940 rendered undirected segments after normal pair deduplication), plus
61 notes with 76 links. The renderer adds no decorative topology. Production
browser checks cover all three materials in light/dark on the same canvas,
actual note selection and content, glow-off selection, link visibility, 2D/3D,
and Indonesian 390 px layouts with camera tools inside the viewport and no
horizontal overflow. These fixtures do not read or change a real user vault.

Final v0.4.191 validation: `pnpm check` passed with 6,246 TypeScript tests,
23 optional cases skipped, 474 Rust tests, lint, typecheck, all builds, version
consistency and asset checks. Independent review findings for material refresh,
overlapping core depth and shared DPR were resolved with regression coverage.
The final built UI confirms opaque controls on the pro glass template and keeps
expanded phone camera controls inside the viewport. No commit or publication.
Indonesian 390 × 844 expanded views keep camera controls within the viewport and
have no horizontal overflow. Full `pnpm check` passed with 5,945 TypeScript tests
(23 optional skips), 474 Rust tests and all builds. No commit or publication.

## Explore and endpoint gradients, 2026-11-08

The v0.4.204 increment adapts bounded Explore navigation and galaxy appearance
from Advanced Graph View revision
`17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d` under MIT. The full copyright and
license ship with the renderer. Extalia retains Three.js, its worker, indexed
links, visibility masks and host-owned note operations. Upstream updates remain
reviewed changes to a pinned reference.

Explore freezes layout while the camera travels to visible linked notes.
Accessible neighbour controls, Back, choose another, explicit open and exit
accompany canvas interaction. Search/list actions can jump deliberately. The
previous dimension preference returns on exit; reduced motion skips animation.
Missing or filtered anchors never expose their note content or create a bridge
through hidden history. Escape remains scoped away from note editors and
unrelated dialogs.

Galaxy cores, layered halos, palette and backdrop follow the reference. Paths
now interpolate the colours of their endpoints, producing a single tint within
a category and a gradient across categories. Density keeps overview paths
quiet; local focus increases their strength. Light mode darkens category tints
against its pale background.

Focused validation passed 139 tests across 14 graph suites, including renderer
pause/late frames, deferred travel, manual cancellation, 2D depth seeding, drag
release, actual neighbour picking, filtered-note suppression and keyboard
editing boundaries. An isolated preview mounted the real graph component with
1,000 synthetic notes and 2,787 generated links. Edge screenshots, travel/Back,
explicit opening, search Escape, dimension restoration, reduced motion, both
themes and Indonesian at 390 px were checked. There was no horizontal page
overflow. This was a component/browser check rather than another host/index
integration run, and is not a performance benchmark or a pixel-identical layout
claim. No real vault or external application configuration was changed.

Integrated v0.4.206 validation: `VITEST_MAX_WORKERS=4 pnpm check` passed with
6,603 TypeScript tests (23 optional skipped), 474 Rust tests, lint, typecheck,
all builds, version and asset checks. The uncapped first run timed out on four
archive/Office tests during concurrent full suites; the bounded rerun passed
without changing those tests. The built renderer's `THIRD_PARTY_SOFTWARE.md`
was compared byte-for-byte with its complete source notice. No commit or
publication was performed.
