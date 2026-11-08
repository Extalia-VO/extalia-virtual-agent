# Knowledge graph interaction

User-requested visual direction, 2026-10-30. Tracking:
[V2-17A / #59](https://github.com/Extalia-VO/extalia-virtual-agent/issues/59).
This increment extends the existing graph and does not close knowledge ACL,
shared-vault, evidence or learning acceptance.

## Luminous node and path styling

The v0.4.191 visual refinement follows the user-supplied
[Advanced Graph View reference](https://github.com/n23eos/advanced_graph_view).
That increment retained Extalia's own renderer and indexed topology without
importing upstream code or assets. The later Explore adoption below adapts
selected MIT logic and appearance math; decorative links remain excluded.

Nodes are camera-facing procedural discs with a compact emissive centre and
antialiased edge. Their screen diameter stays within 2.4–12 CSS pixels, including
at the shared low-DPR budget levels. Zero-scale filtered instances remain hidden.
Connectedness still controls size, colour lift and the separate soft halo. Each
core uses two triangles in the existing instanced draw; the graph retains its
three draw calls and on-demand frame loop. Core depth writes keep overlapping
stars consistent with the front-most projected hit target.

Cluster colours favour blue, cyan, violet, rose and gold. Fine, neutral-tinted
paths adapt to visible link density, with stronger contrast for sparse graphs
and focused neighbours. Dark paths fade with scene depth. Light paths retain
their contrast without fog; they use a higher density floor against the pale
backdrop. The background retains the active app canvas tint, deepened in dark
mode, and remains aligned with the renderer's compositing and fog colours.
Control panels and the legend use the theme's opaque surface so bright points
do not bleed through their text on glass templates.

## Explore and galaxy appearance adoption

Explore follows indexed links between visible notes, with an explicit starting
note, a bounded back trail, choose-another action and an explicit open-note
action. Navigation alone does not read note content. Search and list selection
can jump to another visible note. Active time, facet and neighbourhood masks
apply to every route; a missing or filtered anchor stays unavailable until the
user chooses another visible note. History never bridges a hidden note.

The camera travels in 3D while preserving the user's orbit and zoom across
subsequent hops. The previous 2D/3D preference returns on exit. Simulation and
dragging pause during Explore, preventing layout drift. Fit frames the current
neighbourhood; manual camera movement cancels an in-progress flight. Reduced
motion completes travel immediately. Visible neighbour buttons and a text
trail provide keyboard navigation alongside canvas picking.

This adoption pins Advanced Graph View at
`17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d`. The galaxy palette, deep dark
backdrop, compact cores and layered soft halos follow the reference. Extalia's
paths interpolate the category colours at their two endpoints: same-colour
nodes produce a single-colour path, and different categories produce a smooth
gradient. Density and focus control path strength; light mode darkens the hue
to retain contrast on a pale canvas. Layout and actual indexed links remain
Extalia's, so a different dataset does not reproduce the reference screenshot's
topology.

Only suitable pure navigation and appearance math are adapted. Three.js, the
existing worker and host-owned note operations remain in place; no Pixi.js or
Obsidian plugin dependency is introduced. Updates are reviewed against the
pinned revision rather than pulled automatically. The full upstream MIT notice
ships in `apps/web/public/THIRD_PARTY_SOFTWARE.md`.

Selection rings have a minimum screen size even when decorative glow is off.
Picking uses projected centres and a six-CSS-pixel target in every orbit
orientation, selecting the nearer star when centres overlap. Theme changes and
graph refreshes initialize the current core/halo/path materials without changing
the active camera or replacing the canvas. Indexed counts, accessibility lists,
filtering and note permissions are unchanged.

## Elastic drag and restore

The whole-vault view keeps Three.js and `d3-force-3d`. On the first actual drag,
the simulation captures all current positions. Linked neighbours respond during
the gesture. Releasing with **Return after drag** enabled returns every node to
that snapshot in about 600 ms and stops the simulation. Interrupting a return
with another drag preserves the same restore point. Reduced motion restores
immediately.

With return disabled, physics settles into a new layout. **Restore layout**
restores the positions before the latest gesture. These actions preserve the
camera and do not alter notes, links or persisted vault data. Filtering or a
vault refresh clears the old restore point. The interaction preference is
temporary view state, not a persisted profile setting or node pin.

Simulation remains in a worker with bounded slices, capped position messages
and a main-thread fallback. Hidden tabs pause; view disposal terminates the
worker. Graph/filter changes, pointer cancellation and lost capture release the
held node and restore camera controls. Final rendering reaches the exact target
rather than stopping slightly short. The accessible list and local SVG graph
remain available without WebGL.

## Bounded neighbourhood focus

Select a note from the canvas, search or accessible list, then explicitly choose
**Focus selected note**. One, two or three link steps are available. Traversal
uses only indexed links in the bounded loaded graph, in either direction, and
cannot pass through notes hidden by the active filters. It neither fetches hidden
notes nor invents semantic edges. A truncated overview remains labelled as such;
this focus is not a completeness claim about the vault.

The anchor is a stable note ID, resolved again after overview changes. Selecting
another note opens it without silently moving the anchor. Closing the note with
Escape likewise leaves focus intact. A filtered or missing anchor gives an empty
graph with an explanation and a clear action; even a zero-note refresh retains
that state. **Clear focus** removes only the neighbourhood filter and preserves
the time window, search text, palette and camera. Focus and depth remain temporary
view state and are discarded when the whole-vault view is closed.

Counts, search results, hub list and colour legend use the intersected mask;
legend colours and tag membership remain assigned from the original overview.
Note sizes retain vault-wide connectedness; list link counts describe visible
links within the loaded graph.
Camera flights toward hidden targets are refused, and graph/filter refresh
cancels an old flight. Like other visibility changes, focusing clears the
previous drag restore point. No runtime authority, ACL, persistent pin or note
content is changed.

## Explicit folder, kind and tag filters

The whole-vault toolbar now offers one selection per folder, note kind and tag.
Dimensions intersect with the time mask before neighbourhood traversal; tag
matching considers every actual tag, independently of the representative tag
used for colouring. All is distinct from vault root, no kind and untagged.
Folder matches are exact, without silently including descendants.

Options derive from the complete bounded overview. A selected value disappearing
on refresh remains an explicit unavailable choice and yields no matches until
changed or cleared. Clear filters removes these facets only; time and focus have
their own controls. Counts, visible links, list, search, legend and note-panel
visibility use the same mask. A hidden selected note retains its identity, with
an explanation and close button instead of mounting its content. Prepared graph
identity, colours, simulation and camera stay unchanged during facet changes.

These controls filter loaded data, not an exhaustive vault search. The existing
overview truncation notice remains. No new daemon API, vault writes, saved
presets, pins, model access or `.obsidian` configuration changes are introduced.
Pure/EN-ID component tests and browser checks cover secondary tags, combined
dimensions, hidden intermediary links, disappearance on refresh, clear, selected
note visibility, phone layout and the accessible list without WebGL.

## Visual reference and subsequent increments

The user's reference is
[Advanced Graph View](https://github.com/n23eos/advanced_graph_view). Its README
describes metric-based appearance, community grouping, focus/explore navigation,
pins and presets. It lists MIT licensing. It is an Obsidian plugin with a
Pixi.js renderer; it is a design reference here, not a new Extalia dependency.
No upstream source or assets are copied in this increment. Its published
performance numbers do not establish Extalia performance.

Potential later increments, each requiring its own scope and verification:

- Tune folder/tag colours, glow and density for both light and dark themes.
- Add explicit saved pins/layout presets with stable note identities and reset.
- Extend bounded neighbourhood focus with explicit navigation along indexed links.
- Explore community grouping and diagnostic overlays without treating inferred
  similarity as an authored link or verified task evidence.
- Benchmark real vault sizes and reduced hardware; retain adaptive quality,
  bounded graphs and the accessible list rather than claiming unlimited scale.

Mermaid flowchart preview is a separate Markdown-rendering feature. Graph
gestures do not install an Obsidian plugin or modify `.obsidian` configuration.
