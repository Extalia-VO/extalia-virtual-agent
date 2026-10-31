# Knowledge graph interaction

User-requested visual direction, 2026-10-30. Tracking:
[V2-17A / #59](https://github.com/Extalia-VO/extalia-virtual-agent/issues/59).
This increment extends the existing graph and does not close knowledge ACL,
shared-vault, evidence or learning acceptance.

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
