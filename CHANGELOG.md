# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/):

- **Major (1.0.0)**: Production General Availability (Milestone: `v1.0.0-ga: Extension SDK & Production Release`) with stable public API contracts and extension SDK.
- **Minor (0.X.0)**: Milestone releases representing significant architectural stages:
  - `0.1.0`: Milestone 1 — Public Foundation & Vertical Slice
  - `0.2.0`: Milestone 2 — Workspaces & Session Hub
  - `0.3.0`: Milestone 3 — Import Center & Agent Console
  - `0.4.0`: Milestone 4 — Subagents & Project Orchestration (Current Active Milestone)
  - `0.5.0`: Milestone 5 — Durable Control & Knowledge Vault (Upcoming)
  - `0.6.0`: Milestone 6 — Evolve & Autonomous Learning (Upcoming)
- **Patch (0.X.Y)**: Incremental iterations, bug fixes, visual improvements, and subsystem refinements within the active milestone.

## [Unreleased]

## [0.4.109] - 2026-10-27

### Added

- Read-only Rust mission snapshots and a localized recovery inspection action in Missions. New runs retain explicit backend ownership and recovery provenance; canonical task states and unresolved leases can be inspected without replaying work.

### Fixed

- A host-restart checkpoint can adopt an already-terminal Rust mission only after exact identity checks, terminal task states, no leases and no local activity. Genuine execution uncertainty remains quarantined, missing results remain missing, and failed checkpoint writes leave recovery pending.
- Late mission status polls and responses after unmount cannot overwrite a recovery refresh. Interrupted missions retain manual retry, while active missions continue their normal polling.
- Board rows and character shortcuts locate the avatar again, including its current floor; direct avatar clicks and popup inspection preserve the user's camera.

## [0.4.108] - 2026-10-27

### Added

- Local Blender architecture libraries for glazed partitions, plaster walls, framed glass/wood/automatic sliding doors and detailed stair treads, stringers, landings and rail fittings. Moving leaves and walking contacts retain their app-owned geometry contracts.
- Warm cached light spill beneath every indoor stair tread, six parking luminaires and four short, shadow-free headlights for moving road vehicles.

### Changed

- F1–F3 and All floors use fitted overview framing. Building zoom-out is bounded by the circular ground coverage while preserving its desktop default framing.

### Fixed

- Selecting a character or opening its details preserves manual camera position and zoom; Locate and Follow remain explicit camera actions.
- Parked vehicles keep their lamps off. Light Off preserves natural daylight and daytime fill; night dimming follows the solar phase.
- Full-height glazed door openings no longer overlap a low transom. Right-hand frame fittings mirror with their leaves, sliding tracks support full travel, and nested static batches refresh safely after local models load.

## [0.4.107] - 2026-10-27

### Added

- Blender-authored outdoor planting with flower parterres, fern/agave clusters, blossom trees, cypresses, a reflection pond and a bench pergola. Close grass uses bent Blender blades, while distant tree crowns retain a cheaper shared silhouette.
- Organized conventional parking, three EV charging bays, covered bicycle parking and sparse road traffic. Distinct local Blender vehicles include sedan, SUV, Jeep-style off-road, MPV, hatchback, single-cab truck, double-cab pickup and EV, with complete procedural backups and restrained night lamps.
- Idle outdoor visits to 28 seats, an automated café pickup and a garden-art viewing point. Guests physically arrive before drink preparation, collect their order and walk to a free café seat; real work, removal and reduced motion cancel visits and release reservations.

### Changed

- The twelve nearby district buildings gain physical window mullions, transoms and glazed lobby recesses using four shared role batches. Distant skyline silhouettes and time-driven window lighting remain lightweight.
- Repeated loaded Blender parts now share render instances without changing their world transforms, collision sources or live materials. Unreadable distant screens pause live repainting until zoomed in; compact animated portraits use a lower display cadence while larger portraits keep their existing timing, reducing overview work without replacing their images or characters.

### Fixed

- Outdoor furniture and navigation share one canonical blueprint; clearer picnic/patio spacing, structural collision proxies and lamp positions keep the exterior pedestrian routes and seating approaches open.

## [0.4.106] - 2026-10-27

### Fixed

- Prevent transient white Office frames when adaptive resolution or the window size changes. The current 3D scene is redrawn immediately after the drawing buffer is resized, before the browser can present its cleared contents; character animation and adaptive quality keep their normal timing.

## [0.4.105] - 2026-10-27

### Fixed

- Wired normalized Blender instanced geometries (`bakeExteriorInstancedGeometries` and `useExteriorInstancedGeometries` in `ExteriorPart.tsx`) into the instanced boulevard, side-lawn, corner-grove, and civic park batches (`CampusLandscape.tsx`, `CivicForecourtPark.tsx`, and `CampusSkyline.tsx`) so all foreground boulevard trees, park trees, park benches, and pedestrian lamps upgrade to sculpted Blender meshes as soon as `exterior-landscape.glb` loads, and decoupled `CampusSkyline.tsx` geometry/material disposal effects while keying `<instancedMesh>` instances on geometry UUID and matrix count so async `district-buildings.glb` loading cleanly replaces procedural district building boxes without disposing shared skyline materials.

## [0.4.104] - 2026-10-27

### Changed

- Expanded the Blender exterior asset pipeline (`tooling/blender/create-exterior-assets.py`, `ExteriorPart.tsx`, `CampusExterior.tsx`, `exteriorPart.test.ts`, and `exteriorAssets.test.ts`) to 23 zero-anchored models (`39,204` triangles across `132` material-batched meshes), rebuilding the pedestrian pole luminaires (`exterior-walk-lamp`), louvered pathway bollards (`exterior-bollard-light`), ground-recessed tree uplights (`exterior-tree-uplight`), wayfinding directory monolith (`exterior-wayfinding-pylon`), Campus Cafe kiosk pod (`exterior-cafe-kiosk` with slatted honey-oak apron, honed stone counter, back-bar shelving, twin-group espresso machine, burr grinder, pastry display case, POS terminal, and cups), timber terrace deck (`exterior-cafe-deck`), festoon support masts (`exterior-festoon-mast`), Sheffield loop bicycle station (`exterior-bike-rack` and tintable `exterior-bicycle`), and sculpted stone lantern & terracotta garden vignettes (`exterior-garden-decor`), with solar-driven `Exterior lamp diffuser` emission and full preservation of avatar seating and `outdoor.cafe-counter` interaction clearances.

## [0.4.103] - 2026-10-27

### Changed

- Authored a lightweight Blender outer-shell architectural library for the 12 surrounding district buildings (`tooling/blender/create-district-buildings.py`, `districtBuildingModels.ts`, and `CampusSkyline.tsx`) with colonnaded stone podiums, entrance canopies, chamfered corner piers, twin-core skybridge towers, notched sky-garden terraces, brise-soleil fins, cantilevered residential balconies, and rooftop mechanical penthouses merged into 4 world-space role geometries (`20,420` triangles, 4 draw calls) that preserve the procedural day/night window-grid shader (`FACADE_COLOR` / `FACADE_EMISSIVE`) and > 40 fps render budget, while adding pedestrian crosswalk markings, outer avenue sidewalks, district forecourt aprons, and formal parterre garden beds in `CampusNeighborhood.tsx` and `CivicForecourtPark.tsx`.

## [0.4.102] - 2026-10-27

### Changed

- Authored a Blender exterior landscape and outdoor seating library (`tooling/blender/create-exterior-assets.py`, `ExteriorPart.tsx`, `CampusExterior.tsx`, and `CampusGrass.tsx`) with sculpted multi-branching shade trees, multi-stem ornamental blossom trees, multi-mound shrubs, tiered lavender clumps, honed limestone arrival planters with river pebbles and timber bench edges, cast-alloy park benches, chamfered stone plinth benches, A-frame picnic tables with ribbed square parasols, bistro patio sets, rear garden understory planting, and expanded close-zoom turf tufts while preserving all `OUTDOOR_FACILITIES_BLUEPRINT` seat contact heights, `officeSeat` clearance tags, and procedural fallbacks.

## [0.4.101] - 2026-10-27

### Changed

- Reorganised ceiling light grids across Floors 1, 2, and 3 (`RoomShell.tsx`, `Floor1.tsx`, and `CirculationLighting.tsx`): arranged room ceiling downlights into orthogonal `2×2`, `3×2`, and `4×2` grids so wide labs (`multi-engine`, `fitness`, `mission-control`, `meeting-a`, `meeting-b`, `architecture`, `research`, `entertainment`) have balanced two-row coverage clear of central pendants and linear meeting-table fixtures, excluded duplicate `RoomCeilingDownlights` housings inside executive suites that already mount `ExecutiveSuiteLighting`, pulled `TeamWorkspaceCeilingLights` perimeter wall washers inside the `32 × 19.6 m` Engineering Hall envelope (`x = ±15.25`) oriented parallel to the west/east walls, expanded `LobbyCeilingLights` to a symmetric two-row `8×2` downlight grid framing the central chandelier, centred the Stair Arrival Plaza chandelier between circulation rows, and removed the overlapping south-end stop in F1 `east-circulation`.

## [0.4.100] - 2026-10-27

### Changed

- Reorganised the Floor 1 Open Lounge & Pantry and adjacent East Wing breakout lighting (`LOUNGE_FURNITURE_BLUEPRINT`, `BarPendantCluster`, `DiningLinearPendant`, and `Floor1.tsx`): raised the bar pendant cluster (`drop = 0.45`) and high-top dining linear pendant (`drop = 0.85`) above avatar head height, centred the reading-lounge coffee table directly beneath its pendant light (`[0.05, 0, 0]`) with flanking sofa lamp/plant and full front-apron clearance, removed floating wall sconces from transparent glass partitions and the open reception hall, and anchored lounge corner stand lamps symmetrically (`[±6.35, 0, 8.8]`).

## [0.4.99] - 2026-10-27

### Changed

- Reorganised the Floor 1 QA / Test Lab and adjoining Source Control Lab (`8.2 × 7.6 m`) so storage cabinets and the equipment console sit flush against the west and east partition walls (`x = ±3.76` / `3.82`), wall displays, whiteboards, and artwork mount on the solid south wall instead of the north glass partition, and corner plants/lamps occupy the perimeter corners while preserving workstation seat and IK anchors.

## [0.4.98] - 2026-10-27

### Changed

- Reorganised the Floor 2 Archive room (`9.5 × 8.4 m`) so all display cabinets, bookshelves, and the console table sit flush against the west and east perimeter walls (`x = ±4.44` / `±4.48`), keeping the north glass entrance and central window aisle unobstructed while aligning `OFFICE_OBSTACLES`, archive interaction points, corner plants/lamps, and Knowledge Room west-wall bookcases.

## [0.4.97] - 2026-10-27

### Changed

- Anchored Floor 3 perimeter furnishings flush against their actual room envelopes in the 12.0 × 10.0 m Research Area (four side-wall bookcases, south-wall whiteboard and storage cabinets, and corner plants/floor lamps) as well as the adjoining Knowledge Sanctuary, Flex Work, and Sky Lounge rooms, while preserving workstation seat and aisle coordinates.

## [0.4.96] - 2026-10-27

### Changed

- Reorganised the Floor 1 Entertainment room around a shared spatial blueprint (`ENTERTAINMENT_LAYOUT`), splitting the 12.6 × 7.6 m room into a west TV lounge (wall-mounted screen on the solid north wall, sofa, armchair, coffee table with console controllers, and west minibar) and an east game corner (north-wall arcade cabinets and foosball table) with matching seat/station targets, navigation waypoints, and corner lighting.

## [0.4.95] - 2026-10-24

### Added

- Learning loop, first W6 slice in the Rust core (ADR 0029, proposed; core schema 6): finished native missions become bounded, credential-masked experiences (idempotent per mission). Evidence trust is fixed by kind: Extalia test gates and user confirmations are verified, native reports unverified, observed claims always untrusted. Knowledge and skill candidates stay `insufficient_evidence` without at least two verified successes; only the local user can accept or reject them, citing the proposal digest. Accepted knowledge is written only to Extalia-managed notes through the compare-and-swap path (user notes get conflict copies); accepted skills are only staged into the profile's skill import inbox for the normal quarantine, inspection and approval flow. All learning records are append-only and isolated per profile. Not on the daemon wire or in the UI yet.

### Changed

- The daemon runs knowledge requests on their own thread, in arrival order, so a long vault sync no longer delays mission, permission, health or skill requests on the same connection. Answers are matched by request id; a knowledge request whose deadline passes while it waits is answered `deadline_exceeded`; on stdin EOF, knowledge requests already received finish before the daemon exits.

### Fixed

- The intermittent `index_locked` test failure: spawning the daemon binary briefly copied the test process's lock descriptors into the child. Tests that spawn the binary now run separately from tests that hold store locks in the test process.

## [0.4.94] - 2026-10-24

### Added

- Knowledge editing: edit notes in place (Markdown editor with preview; Ctrl/Cmd+S saves, Esc asks before discarding unsaved changes). Saves are compare-and-swap: if the note changed meanwhile, your version goes to a conflict copy and a panel explains why, compares side by side and reloads the current version. New notes, per-note version history with confirmed rollback, a "Managed by Extalia" chip, and "Import memory notes" with a dry-run preview before confirming. Editing appears only when the native core serves it.
- Choose your own Knowledge vault folder (for example an existing Obsidian vault) in Settings → Knowledge vault. Extalia checks the folder, restarts the native core with it and rebuilds the index. It never deletes or rewrites your notes, edits automatically only notes marked `managed_by: extalia`, and leaves `.obsidian` untouched. A chosen folder that goes missing makes the vault unavailable instead of falling back to another folder.
- Notes edited outside Extalia are indexed automatically while the native core runs (native file watching on macOS and Windows, light polling elsewhere, debounced, with back-off on errors); the Knowledge page refreshes when an outside edit was indexed.
- Daemon operations `knowledge.read`, `knowledge.write` (user compare-and-swap; conflicts become copies), `knowledge.history`, `knowledge.rollback` and `knowledge.importMemory` (idempotent, credential-masked, with a dry run), and `--vault-root` for a validated user-chosen vault folder reported only as `custom:<folder name>`.
- Guide for the Knowledge page and the 3D graph.

### Changed

- Test timeouts are 15 s per test and hook, because host suites spawn the real daemon and Git during a full parallel run.

## [0.4.93] - 2026-10-23

### Added

- Knowledge "Whole vault" 3D graph next to the local graph: notes coloured by folder, kind or tag; the most connected notes are larger and glow, and hubs pulse gently. Hover highlights a note and its neighbours, a click flies to the note and opens it beside the graph (a bottom sheet on phones), and notes can be dragged. Search with `/` and arrow keys, filter by modification time (1D–All), toggle labels and glow, or use the accessible list view. The layout runs in a Web Worker (`d3-force-3d`) and the canvas draws only while something moves; 3 draw calls at any size, 60 fps at 2,000 notes on the development machine.
- The Knowledge page reads the real vault index through the Rust core daemon (`nativeCore: "rust"`): status, sync with the skipped files of the latest sync, notes, links, backlinks, search, local graph and the whole-vault overview. Opening the page refreshes an index older than 5 minutes (incremental, never creating the vault). With the TypeScript core the page stays hidden.
- Daemon `knowledge.overview`: a bounded whole-vault graph (at most 2,000 notes and 8,000 links, profile-scoped) with folder, up to 8 tags, in/out degree and modification time per note; distinct resolved links only. The most connected notes are kept when the vault is larger, within the frame limit.

## [0.4.92] - 2026-10-23

### Fixed

- Standby characters resume from their actual position after closing or handing off a door. Route joins replace stale curve origins/progress, consume dense crossed markers without losing destination contacts, and wait for verified clearance instead of walking through an obstruction.

## [0.4.91] - 2026-10-23

### Fixed

- Hand-operated door interactions now follow each character's current walking speed: clear-apron steps, turns, grip/release timing and opening/closing swing stay coordinated as trip pace changes. Contact steps use measured travel for gait, so stationary swings no longer animate walking feet; swept clearance, handoff and automatic sliding-door timing are preserved.
- The sample Knowledge host implements the graph-overview contract, keeping support detection and bounded graph results consistent with the native host.

## [0.4.90] - 2026-10-23

### Fixed

- Static sofas, armchairs and benches now use clear front approaches, turn before lowering and rise forward before leaving. Seated neighbors remain physical obstacles; shared sofas use independent front lanes with safe yielding, retries and cancellation. Target-cushion contact preserves other furniture collisions, and dining chairs leave space to stand and turn.

## [0.4.89] - 2026-10-23

### Changed

- Skills have their own page in the sidebar (Extalia group, next to Settings), with a badge counting skills waiting for review or approval. With the preview native core it holds the Skill Security Center; with the TypeScript core it lists project skills for every workspace with the same Allow and Revoke. Both modes list the built-in skills read-only (they ship and update with the app), through a new read-only `builtinSkills()` host method. Settings points to the Skills page, each workspace shows a "N project skills waiting — Review" link, and the Chat notice button now says "Review skills".

## [0.4.88] - 2026-10-23

### Added

- Knowledge page (W5) under Work: search the profile's vault, read notes with clickable wikilinks (resolved, ambiguous with a candidate picker, missing shown muted), see front matter as declared and never as verified, outgoing links with status, backlinks, a bounded local graph (depth 1–2, at most 60 notes, loaded on demand) and the sync status with skipped files and reasons. It appears only when the host serves the new optional knowledge methods (validated in `@extalia/platform`); the host implementation follows in the next slice. The mock host has a sample vault. English and Indonesian.
- Knowledge index on the daemon wire (W5): additive contract v1 operations `knowledge.status`, `knowledge.sync` (incremental or rebuild), `knowledge.node`, `knowledge.links`, `knowledge.backlinks`, `knowledge.search` and `knowledge.graph`, with JSON Schema and 52 shared fixtures. Each profile's `knowledge.sqlite` opens lazily with its own lock; an unusable index reports `unavailable` instead of stopping the daemon; the vault root is created on the first sync and never recreated empty. Only vault-relative paths cross the wire, note bodies are capped at 256 KiB and every frame stays under 1 MiB.
- Safe note writes in the Rust knowledge core: compare-and-swap with atomic rename and no-replace create, conflict copies instead of overwrites, symlinks and hard links refused, an append-only revision journal with rollback, and Extalia may only update notes marked `managed_by: extalia`. Workspace memory notes can be imported into `Projects/<workspace>/Memory/` with provenance front matter and the same credential masking as the host; originals stay untouched. Not on the wire yet.

## [0.4.87] - 2026-10-23

### Improved

- Board, character-card and message-dialog portraits now render the same 3D body, face, hair, wardrobe and saved appearance as the Office. Visible duplicates share one portrait scene and a single WebGL renderer, with offscreen/background pause, reduced-motion support and illustration/model fallbacks.
- Office characters and portraits share seeded blinks, gaze, gentle idle yawns and work/wait expressions through one cosmetic clock and live character activity. Canonical local faces gain cached runtime eyelid, mouth and brow shapes; procedural characters use the same expression controls.

## [0.4.86] - 2026-10-23

### Fixed

- Following a character now switches the displayed floor during travel across F1–F3, stairs and elevators while preserving camera framing and zoom. Through-trip elevator cabins and passengers remain visible at intermediate floors. Explicit floor/view selection or dragging returns control to the user and cancels pending camera movement.

## [0.4.85] - 2026-10-23

### Fixed

- Night lighting now covers the east room-side circulation strips on F1–F3, the floor beneath the returning stair flight and the rooftop terrace walking paths. Added physical downlights and shielded terrace posts provide overlapping local coverage; interior overrides, exterior dusk control and coverage on lower render budgets remain consistent.

## [0.4.84] - 2026-10-23

### Fixed

- Floor finishes on F1–F3 now meet the character and furniture ground plane, with their thickness below the walking surface. Flush borders, thinner grounded rugs, lobby inlays, server rack origins and Blender console-table legs correct buried or floating contacts; slab undersides, rounded edges and stair openings remain aligned. An editable Blender floor panel preserves the same datum with a procedural fallback, and the fitness aisle no longer overlaps another finish.
- Smooth walking preserves velocity and unused frame time across short curve samples, removing repeated slowdowns. Personal and per-trip pace variation now gives clearer relaxed, normal and hurried walks, with distance-driven footsteps and safe passing retained.

### Removed

- Ground status and selection rings beneath agents and facility characters. Character picking, hover names and information panels remain available.

## [0.4.83] - 2026-10-23

### Improved

- Office characters use varied, clearance-checked walking curves and safe open-space shortcuts instead of tracing every aisle waypoint. Nearby walkers adjust their lateral position and pace to pass or follow with space; doorway, chair, stair and elevator contacts remain exact. Rendered furniture and partitions supply body clearance, upper-floor support prevents shortcuts across stair voids, and walking animation follows actual travel.

## [0.4.82] - 2026-10-23

### Improved

- Shared interior furniture now uses a 46-part Blender library: cabinets and bookcases, print/copy stations, decorative tables, pantry equipment and swivel stools, server racks, entertainment furniture, fitness equipment, plants, artwork and lamps. Editable local models retain procedural backups; live screens and physical illumination remain active, and pendant cords extend without stretching the shades.
- Pantry guests wait for food/drink service at their stool-aligned counter positions before eating or sipping; the bartender walks between preparation and handoff points. Stool and seated character rotations stay synchronized. Two idle characters can share a local console rally on the TV, with held controllers and cancellation when work resumes.
- Server racks face the inspection aisle with restrained activity LEDs and improved service-room details. Fitness visits include running, cycling, weights, yoga, bench curls and cable rows; moving equipment and avatar contact targets share their motion phases.

## [0.4.81] - 2026-10-23

### Added

- Knowledge foundation, first W5 slice (Rust core, ADR 0024 amended): each profile has a rebuildable index `<data>/profiles/<profile>/knowledge.sqlite`, separate from the core store, built from Markdown in `<data>/vaults/<profile>`. A safe vault walker (no symlinks, hidden folders such as `.obsidian` ignored, size caps, UTF-8 only), strict front matter, an Obsidian-compatible wikilink parser (aliases, headings, block refs, embeds, relative paths, typed `Related:`/`Learned from:` lines, code excluded), deterministic case-insensitive resolution (path, path suffix, title, alias; ambiguous and missing links kept), incremental sync with rename detection, and profile-scoped queries (node, links, backlinks, full-text search, bounded local graph) where a link to another profile's note looks the same as a missing one. Markdown stays authoritative; the index never writes notes. Not yet exposed in the app.
- Per-workspace integration test gate (W4, ADR 0028) in Settings → Workspaces, with a suggestion from the project's files that is never applied automatically. Integration proposals use it when none is given and record where it came from; the Changes panel pre-fills it and links to the setting. Without a gate a proposal stays `gate_missing` and cannot be applied.
- Skill daemon `skill.scanner` reports the installed inspector (pinned, version, policy version, status); the Skill Security Center banner follows it instead of guessing. Skill operations accept the host's workspace ids, so project-skill consent is shown as "Allowed in project X on <date> (input only)". Core store schema 5 rebuilds the affected skill tables, keeping every row, index and append-only rule, with a backup first.
- Guides for the Skill Security Center and mission changes.

### Fixed

- The "Inspection was interrupted" reason now says to inspect again; interrupted inspections are never replayed.

## [0.4.80] - 2026-10-23

### Fixed

- Characters now take visible backward/forward steps while pulling or pushing work chairs. Chair handling no longer cancels its walk animation each frame, and its shortened gait follows actual body travel through the eased chair slide/swivel instead of a fixed timer. Seated scooting, stand-up contacts and chair-side selection are preserved.

## [0.4.79] - 2026-10-23

### Fixed

- Characters entering through inward-opening room doors now close with a short tug from the reachable handle face and move clear inside as the leaf shuts, instead of circling behind it. Already-open door closing duties use the same reachable-face selection. Existing exit and queued handoff behavior is retained, and foot-limited swings settle exactly at their open/closed endpoints.

## [0.4.78] - 2026-10-23

### Added

- Skill Security Center (W3): with the Rust native core enabled, Settings shows the skill registry. Import a skill folder or a project skill into quarantine; see lifecycle states, reasons, declared permissions and hashes; review; approve exactly the shown package hash and permission digest (expires after 10 minutes); activate, deactivate, roll back or revoke. Until a verified scanner is configured, imported skills stay quarantined. Agents receive user and project skills only from active, daemon-verified revisions; when the native core is unavailable only built-in skills are offered. With the TypeScript core, project-skill consent (W0) is unchanged.
- Native core store schema 4 adds append-only skill reviews, review inputs and built-in registrations. The daemon serves `skill.review` (accept → validated, reject → quarantined, bound to the shown tree hash); W0 consent is recorded as review input and never changes a state; built-in skills are re-verified on every daemon start.
- Missions → Changes panel (W4, ADR 0028): per write task, the worktree branch, ahead/dirty status and diff summary; propose an integration with a test gate, see conflict paths and gate logs, apply only after confirming the exact diff digest, remove a worktree only with its reviewed fingerprint, and review orphaned worktrees. Worker edits appear in the mission journal, Office and timeline as bounded activity (paths only, never file contents), admitted by one table shared by the TypeScript and Rust stores. English and Indonesian.
- `AgentHostApi` gains optional, validated skill-registry and worktree methods, forwarded by Desktop and the Bridge; worktree methods are never available to agents.
- Getting-started guides for project skills and the preview Rust native core.

### Fixed

- `skill.list` with the maximum page size of 100 no longer fails with `limit_invalid`.

## [0.4.77] - 2026-10-23

### Improved

- Ordinary and touchdown workstations now use Blender-authored oak tops, slim legs, refined displays, laptops and input devices, plus coordinated books, organizers, shelves, flowers and lamps. Live screen content and seated hand contacts remain aligned; local models have procedural backups and decorative lamps follow interior lighting.
- Dual and triple external monitors now form level panoramic banks with equal screen sizes, matching side angles and narrow, consistent bezel gaps across ordinary, team, executive and reception desks. Mixed laptop/monitor workstations retain their independent arrangement.

## [0.4.76] - 2026-10-23

### Improved

- Four-person team desks now use a Blender-authored structure with larger inward seating bays, slim steel legs and a recessed frame, low rounded glass dividers and compact clamps. Seats and input devices move together to preserve hand reach; monitors and laptop stands sit farther inward with verified input clearance. A matching procedural structure remains available without local models.

## [0.4.75] - 2026-10-23

### Improved

- Blender-authored task and executive office chairs with contoured upholstery, rounded arm pads, gas lifts and five twin-wheel casters. Local chair models replace both static and moving chairs while retaining shared sitting/contact anchors, instanced motion and a procedural backup when assets are unavailable.

## [0.4.74] - 2026-10-23

### Fixed

- Characters pulling a door open step to the latch side, opposite the hinge, after an initial handle tug. Solo passage uses only the opening needed to regrip and close while exiting; queued traffic keeps a full opening and hands it off directly. Swing motion respects foot speed, leaf/jamb clearance and fixed opening intent when another walker arrives late.

## [0.4.73] - 2026-10-23

### Fixed

- Free-roaming characters no longer miss closed doors when rendered portal coordinates differ slightly from authored route thresholds. Door crossings use a small plane tolerance; characters already stranded inside a shut leaf’s clearance area walk back on their approach side before retrying. Regression coverage uses all 28 rendered portals and actual leisure routes, plus mirrored recovery, goal-change and traffic cases.

## [0.4.72] - 2026-10-23

### Added

- Rust core daemon skill operations (W3 slice 2, ADR 0025): contract v1 gains `skill.import`, `skill.list`, `skill.inspect`, `skill.approve`, `skill.activate`, `skill.deactivate`, `skill.rollback`, `skill.revoke` and `skill.read` (additive, advertised only with an open core store), the error codes `denied` and `integrity_failure` and an optional error `reason`, with JSON Schema and shared fixtures checked by Vitest and `cargo test`. Imports read only the profile's `skill-imports` folder and stay quarantined while no scanner is pinned. Only the local user (`user:<id>`) can approve, against the digests shown; approvals expire after 10 minutes by default (at most 24 hours). Reads return verified files of the active revision only. A revision interrupted during inspection returns to quarantine on start. W0 workspace consent is shown as review input and never activates anything. Built-in skills are registered only inside the daemon, content-hashed and exempt from the scanner gate. `skill.review` is defined but not served until its storage migration lands. No UI yet.
- Write-capable native mission workers, first slice of W4 workspace isolation (ADR 0028, proposed): a task marked `access: "write"` edits only inside its own Git worktree under the data folder (pinned base commit, branch `extalia/worker/<id>`), never the project checkout; read-only tasks and default missions are unchanged. A serial integration queue merges a finished worker onto the current target in a throwaway worktree and runs the configured test gate (exit code and a bounded, redacted log as evidence). Conflicts are reported with their paths and never resolved automatically; applying needs the user's approval bound to the diff digest and never forces. Worktrees left by a crash are reported as orphans and never deleted automatically. Non-Git folders, repositories without commits, submodules, Git LFS and custom filter/merge drivers are refused. Host API only (`AgentHostRuntime.worktrees`), no UI yet.
- CI runs the host mission suites against a real daemon build in the Rust job, plus a non-blocking benchmark smoke on Linux.

### Changed

- Event commits no longer slow down as a mission's journal grows: both mission stores keep exact running per-mission totals in the same transaction (core.sqlite migration 0003, missions.sqlite schema 3, backfilled on upgrade). Caps, sequences and errors are unchanged. Commit p95 at 7,000–8,000 events falls from 2.77 ms to 0.15 ms (Rust daemon) and from 3.52 ms to 0.64 ms (TypeScript); see `docs/benchmarks/native-core-2026-10-22-totals.md`.

### Fixed

- Corrected workstation handedness using the avatar’s actual facing direction: the mouse and active hand are anatomically right, full-keyboard number pads face that side, and cups sit opposite. Mouse position within its pad varies independently per seat; deeper single/touchdown desktops leave palm space before the keyboard without extending the arm targets.
- Door closing turns beside the free-edge handle without the former far-apron round trip, preserving mirrored push/pull contact and leaf/jamb clearance.

## [0.4.71] - 2026-10-22

### Added

- Rust core secure skill registry, first W3 slice (ADR 0025): core store schema 2 adds the skill tables (packages, immutable content-addressed revisions, files, permissions, dependencies, conflicts, compatibility, categories, intents, append-only inspections, evaluations and history, approvals bound to hash and permission digest, one activation pointer per profile and package); a schema 1 store is backed up and upgraded in place. `extalia-core::skills` stages packages into a per-profile read-only object store with the canonical tree hash `extalia.skill-tree.v1` (symlinks, hard links, special files, hidden or non-portable names and oversize packages refused), validates `extalia-skill.json` against `SKILL.md`, enforces the lifecycle table, and keeps every package quarantined through a fail-closed `UnavailableInspector` until a verified scanner pin exists. Activation, deactivation, rollback and revocation are audited, with the hash re-verified at seven points. No daemon operations or UI yet.
- Benchmark `tooling/bench/native-core.mjs` (audit PR 10): measures the TypeScript mission journal against the Rust daemon through the real host code paths (commit latency at 1/3/8 missions, throughput, mission creation, cold start, restart recovery, memory, binary size) and records hardware, OS, toolchain, revision and daemon hash. First results and proposed default-on thresholds: `docs/benchmarks/native-core-2026-10-22.md`.

### Fixed

- Restarting the host no longer marks every task of an interrupted native mission as unknown. Only work that may have been in flight (assigned, running, waiting, awaiting approval, verifying) becomes `unknown`; completed, failed and cancelled tasks keep their results, and queued or blocked tasks stay as they were. The mission is still `recovering` and nothing is replayed (ADR 0013 amended, matching the Rust store). The Missions page shows a task left queued in a recovering mission as "Not started".

## [0.4.70] - 2026-10-22

### Added

- Rust core daemon client (audit PR 8, flag off by default): with `nativeCore: "rust"` (`config/extalia.json`, or `EXTALIA_NATIVE_CORE=rust`) new saved native missions route to the `extalia-daemon` sidecar, started lazily and stopped with the host. Missions are created with `mission.create`, runtime events are acknowledged through `task.transition`/`event.commit`, and worker tool calls are decided by `permission.check`. When the daemon is missing, crashes, times out or answers malformed frames, tool calls are denied (`policy_unavailable`, reads included), running missions become `recovering`, new missions are refused, and nothing falls back to the TypeScript policy (ADR 0026). A second process holding the daemon lock is reported clearly and never retried. History-off and existing missions stay on the TypeScript path; `getState()` reports the daemon status when the flag is on. `pnpm check` builds the debug daemon so the host mission suites also run against it.
- Self-contained installers: Extalia Desktop bundles the `extalia-daemon` binary for each OS and architecture (`<resources>/daemon/`, about 2.5 MB, signed with the app on macOS); release CI builds it for macOS arm64/x64, Windows x64 and Linux x64/arm64 (glibc 2.35+). A "clean machine" gate in CI and releases runs the packaged app and an `npm install -g` of the CLI with no Rust, Python, Node or npm on `PATH`. The CLI's per-platform daemon packages (`@extalia/daemon-<platform>-<arch>`) are generated and packed by the release workflow but not published until the npm scope is reserved.
- Shared task and mission transition tables in `@extalia/protocol` (`TASK_TRANSITIONS`, `MISSION_TRANSITIONS`), generated to `packages/protocol/schemas/transitions.json` and covered by the drift check. The Rust daemon loads its rules from that file at compile time; runtime mission tests fail if an emitted state change is missing from the tables.

## [0.4.69] - 2026-10-22

### Added

- Settings → Workspaces shows each workspace's project skills (`.extalia/skills/*/SKILL.md`). Skills waiting for review list their description, source, reason ("New in this project" / "Changed since you allowed it") and short SHA-256, with Allow and Allow all; allowed skills can be revoked one by one or all at once, and skipped files are listed. Allowing sends the exact hash shown, so a skill edited in the meantime is refused and the list refreshes. Chat shows a small notice with a link while the active workspace has skills waiting. English and Indonesian.
- Rust core slice A, one durable task (audit PR 6): `extalia-daemon` serves `mission.create`, `task.transition` and `event.commit` from `state/core.sqlite` for one profile (`--profile`, default `default`). Each operation commits in one transaction or writes nothing; per-mission sequences start at 1; an identical duplicate event id returns the original acknowledgement and conflicting reuse is refused; ADR 0014 caps apply (4 KiB per event, 8,192 events and 8 MiB per mission, 64 tasks); only native control metadata with checked task, assignee and workspace ownership is accepted. Running work holds a lease; on restart in-flight tasks become `unknown` and their missions `recovering`, never replayed (ADR 0013). An exclusive lock admits one daemon per data directory; a second exits with status 4 before reading any frame.
- Rust `permission.check` (audit PR 7, ADR 0026): a pure port of the runtime's `decide()`; a 2,560-case matrix generated from TypeScript (`node tooling/generate-permission-matrix.mjs`) must give identical decisions in Vitest, the Rust function and the daemon. A type-level test fails typecheck if the protocol's permission enums drift from the runtime's. The host does not call the daemon yet.

## [0.4.68] - 2026-10-22

### Fixed

- Workstation layouts leave more space between avatars, keyboards and displays across PC, laptop, pod, executive and reception desks. Mice stay on the sitter’s right with stable per-seat position and angle variation; hand targets follow the physical devices. Executive inputs rest on the leather blotter, laptop companions use a raised stand, and reception has supported keyboard/mouse hardware.

## [0.4.67] - 2026-10-22

### Fixed

- Workstation sit/stand choreography now follows the same signed chair swivel, pivot and slide as the rendered chair. Each maneuver varies its opening side, keeps hand contacts attached, walks around that side to the open front and releases the armrests before stepping away. Scripted chair movement stays synchronized with the avatar instead of adding a second damping lag.

## [0.4.66] - 2026-10-22

### Fixed

- Office hinged doors open a full quarter turn into rooms, with mirrored hinges where needed. Characters follow the handle while pushing or pulling, walk around the free edge, turn back to close, and wait outside the leaf sweep for other users. Open-door route handoffs and scene cleanup preserve clearance and release reservations.

## [0.4.65] - 2026-10-22

### Fixed

- Detailed formal shirts: isolated sleeves follow the upper arm and forearm instead of pulling cloth from the waist when typing, using the mouse or lifting a hand. Shoulder and cuff contacts blend smoothly; sleeveless vest panels follow the torso rather than the moving arm. Source geometry, hand poses and shoes are preserved.

## [0.4.64] - 2026-10-21

### Fixed

- Antigravity observed sessions: resolve transcript path mapping from hooks (`transcript_full.jsonl` → compact `transcript.jsonl`) so the session links properly to history rather than remaining an empty-path hook-only stub.
- Antigravity image attachments: read prompt user media (`USER_INPUT` `media: [{ mime_type, uri }]`) via bounded base64 reader in `nativeImport`, populating image attachments/thumbnails and user messages directly in Extalia's Messages tab.

## [0.4.63] - 2026-10-21

### Fixed

- Antigravity hooks: the forwarder (`forward.mjs`, now v2) no longer prints `{}` for `PreToolUse`. Antigravity requires a `decision` there and treated `{}` as a deny, blocking every tool call with an empty reason. `PreToolUse` now gets no output, so Antigravity's own permission flow applies; other Antigravity events still receive `{}`.

## [0.4.62] - 2026-10-21

### Changed

- Connect agent apps (`ConnectAgentAppsCard`): clicking **Connect** now applies the local hook configuration, installs/updates `forward.mjs`, enables transcript auto-watch and verifies the local hook endpoint in one click.
- `ConnectService`: automatically upgrades an outdated `EXTALIA_HOME/hooks/forward.mjs` when inspecting connections and detects `~/.gemini/tasks` / `~/.gemini` for Antigravity / Gemini Desktop hook integration.

## [0.4.61] - 2026-10-21

### Fixed

- Detailed avatar feet: fit the formal outfit's exposed ankle/instep and excessive trouser cuffs to the existing shoes, preserving shoe geometry. Measure the active wardrobe's sole for floor contact and keep shoes level during seated transitions without moving the seated hip or desk contacts.

## [0.4.60] - 2026-10-21

### Added

- Zero-config Hermes hook integration: auto-detect Hermes on Desktop and Web Bridge startup and connect outbound webhook (`post_llm_call`) automatically without manual configuration.
- Task-based spatial dispatch to Library / Skills workstation (Floor 1): agents executing `skill_manage` or skill curation tools automatically navigate to the Library desk (`library.laptop` or sofa), sit down with reading animation, and return to their home workstation once the task completes.
- Dual-mode in-scene prompt dock previews (Managed & Observed) and frameless Retina campus architecture screenshots in README.

### Fixed

- Observed session reply reconciliation (`packages/host/src/observations.ts`): dropped restrictive `event.at < hook.since` timestamp boundary so final assistant replies from SQLite history are seamlessly merged and streamed into the Messages tab without hanging on "Thinking...".
- Aligned project versions to Semantic Versioning and milestone hierarchy: Minor versions track project milestones (0.1.0, 0.2.0, 0.3.0, 0.4.0), and patches reflect incremental iterations.

## [0.4.59] - 2026-10-21

### Added

- First Rust code: a Cargo workspace with `extalia-core` and `extalia-daemon`, toolchain pinned to 1.99.1 (rustfmt, clippy, edition 2024). `pnpm check` and CI on macOS, Windows and Linux run `tooling/check-rust.mjs` (fmt, clippy with warnings as errors, tests against the committed `Cargo.lock`). Contributors need rustup; people who install Extalia do not.
- `extalia-daemon` sidecar handshake (ADR 0020): length-prefixed JSON frames on stdio per daemon wire contract v1 with `hello` and `health`; other operations get `handshake_required` before `hello` and `unknown_op` after it. Clean exit on stdin EOF, logs on stderr only. Rust tests read the shared protocol fixtures for parity with TypeScript. Release binary about 2.4 MiB; `hello` round trip about 3 ms (p50) on the development machine.
- `extalia-core` SQLite store (ADR 0019): a daemon-owned `state/core.sqlite`, used only with `--data-dir` and not read by TypeScript yet. Schema 1 holds missions, tasks, events, leases and approvals, each scoped to a profile; migrations tracked by `user_version` with an exact-schema check, fail closed on newer or tampered files, a private backup before each upgrade, one transaction per migration, WAL with full sync and foreign keys, private file permissions.

### Changed

- `pnpm version:patch` and the version check also cover the crate versions and their `Cargo.lock` entries.

## [0.4.58] - 2026-10-21

### Changed

- `@extalia/protocol` generates JSON Schema (draft 2020-12) for the Mission, Task, AgentEvent, Approval and Permission contracts from the same rules its validators use, into `packages/protocol/schemas/`, with golden valid and invalid fixtures. Tests require validator and schema to agree on every fixture; the few checks JSON Schema cannot express are listed in each file. `pnpm lint` fails when the committed schemas drift.
- Daemon wire contract v1 in `@extalia/protocol` (ADR 0020): strictly validated `hello`, `mission.create`, `task.transition`, `event.commit`, `permission.check` and `health` frames with request ids, stable error codes, fail-closed schema versions and length-prefixed framing with a 1 MiB limit. Nothing calls the daemon yet.
- Native missions accept an opt-in asynchronous event acknowledgement (`commitEventAsync`, `commitDeadlineMs`; ADR 0014 amendment). One commit is in flight per mission in emission order; provider calls, read tools and task transitions wait for every earlier acknowledgement, and a rejected, late, malformed or non-monotonic acknowledgement stops the mission like the synchronous path. The synchronous path is unchanged and remains the default.

### Documentation

- ADRs 0024–0027 (proposed): profiles, ACL and vault roots; skill manifest and immutable revisions; one permission enforcement point; evidence and provenance model. ADR 0022 revised: installers are self-contained, so the Python worker is bundled (built with `uv` in CI) and the CLI brings the Rust daemon through per-platform npm packages; users never install Rust, Python or Node themselves.

## [0.4.57] - 2026-10-21

### Security

- Skills that come with a project (`.extalia/skills`, for example in a cloned repository) are no longer given to the agent automatically. Each one waits until you allow it for that workspace, and the consent covers that exact file: when the skill is edited or a new one appears, it waits for you again. Built-in skills are unchanged.
- Your own skills and allowed project skills are shown to the agent as untrusted guidance that cannot grant permissions or override Extalia's safety instructions.

### Changed

- New host methods `workspaceSkills`, `allowWorkspaceSkills` and `revokeWorkspaceSkills` (Desktop and CLI Bridge) list a workspace's waiting project skills and allow or withdraw them. There is no screen for them yet.

### Documentation

- Phase 0 repository audit for PRD patch v1.1.1 (`docs/implementation/REPO_AUDIT.md`) with a staged plan up to the first Rust slice, and accepted ADRs 0019–0023: a separate Rust-owned core database (rusqlite), a stdio sidecar daemon, the strangler integration behind the host API, a `uv`-managed Python worker on consent, and a fail-closed skill scanner adapter whose pin is still unverified.

## [0.4.56] - 2026-10-21

### Documentation

- PRD patch v1.1.1 (technical implementation blueprint and coding-agent handoff) added under `docs/product/master-prd-v1.1/`. It makes Rust the control-plane authority behind contracts, keeps Python an on-demand worker and requires a read-only repository audit first. Gap map §5 adapts the blueprint to the existing protocol package, host-owned SQLite, Bridge transport and TypeScript kernel, and maps its phases onto the upgrade waves.

## [0.4.55] - 2026-10-21

### Fixed

- Seated desk avatars use wider typing contacts, stable mouse contacts and an elbow plane that keeps arms relaxed below the shoulders. Palm orientation follows the posed torso, wrist roll is shared with the forearm, and activity transitions orient hands for typing, thinking, phones and cups.
- Local detailed avatars retain their intended body proportions. Conservative clothing-weight corrections keep forearms and calves straight below the joints; relaxed-hand morphs soften the terminal source hands without changing local model files.

## [0.4.54] - 2026-10-21

### Documentation

- Master PRD v1.1 (secure skills, knowledge vaults and learning: FR-15–FR-24, AC-16–AC-30) added under `docs/product/master-prd-v1.1/`, with private workspace, persona and location names replaced by neutral examples. `docs/product/prd-v1.1-gap-map.md` rates every v1.0 and v1.1 requirement against the code and merges the open work into upgrade waves W0–W8, starting with containing unscanned repository skills.

## [0.4.53] - 2026-10-21

### Changed

- Message details show consecutive tool calls as one compact block, like a chat app's "Ran 6 commands": a summary line ("Ran 3 commands and read 2 files", with failures counted) folds a single card that has one row per call; a row opens its output and changed files. The block grows while the agent keeps calling tools and a new one starts after its next message; it stays open while a call in it runs. Consecutive subagents share one card too.

## [0.4.52] - 2026-10-21

### Changed

- Observe mode: a subagent's message details show its own conversation (the task it was given, its tools and replies) instead of repeating the lead agent's; the lead keeps its own conversation with its subagents as cards.

### Added

- Files attached to prompts in observed sessions are shown in the message details: images as small thumbnails that open full size, other files as a list with their size. The transcript readers recognise attachments in Codex, Claude Code, Gemini CLI and Hermes histories; embedded images (PNG, JPEG, WebP, GIF up to 5 MB) are kept as private copies in the data directory (`observed-files/<session>/`, removed with the observation), and events carry only each file's name, kind, size and a content reference. New host call `attachmentPreview(sessionId, ref)`.

## [0.4.51] - 2026-10-20

### Added

- Local detailed characters: a casual women's outfit (rolled-sleeve shirt, jeans, sneakers) worn by the casual, technical and creative styles; glasses, earrings, an ID badge, headphones and a wristwatch modelled for the new heads and bodies, shown when the look wears them (the watch only with bare forearms); and seven more realistic hair styles built from the hair-pack cards: short fade, side part and undercut for men, bob, medium, low bun and low ponytail for women.

### Fixed

- Scanned outfits on the local characters follow the arms properly: weights now come from the scans themselves, so the blouse and shirt no longer stretch from the armpit to the hip when typing. The blouse's jagged shoulders and back seam, the waistcoat's dark side patches and ragged armholes, and skin specks at collars and cuffs are cleaned up; the hair styles are pushed clear of the new heads so no skin shows above the ears.

## [0.4.50] - 2026-10-20

### Fixed

- Building view trims floor slabs, room finishes, borders and ceiling reveals to the rounded exterior glazing footprint, preventing square corners from piercing the facade. F3 indoor surfaces follow the setback while the terrace retains its full deck; stair openings and standalone floor views remain intact.

## [0.4.49] - 2026-10-20

### Fixed

- Campus view hides room perimeter walls, window frames, sills and skirting where they meet the exterior skin, including the F3 terrace setback. Interior partitions and app-owned doors remain; standalone floor and all-floor cutaway views restore their room walls. Perimeter surfaces have separate batches so switching views leaves no stale merged geometry.

## [0.4.48] - 2026-10-20

### Fixed

- The F3 terrace's old procedural guard no longer remains as merged floor geometry after the Blender balustrade loads. Its isolated fallback batch is removed with the guard, including glass, rails and accent strips.

## [0.4.47] - 2026-10-20

### Changed

- Local Blender building assets now include the reviewed continuous west ribbons, side-door surround, open front-left glazing, rooftop sign supports and entrance reveals. Facade, shaft and guard glass share the authored neutral tint with separate opacity; only facade windows receive the interior night glow. The original neon lettering remains app-owned and aligns to the model's rooftop plinth.

### Fixed

- Loading the Blender maintenance stair now replaces only its static structure. Two traffic-driven gates and five solar-controlled fixtures remain in the app, align to the model's landings and unregister on other floor views. Switching stair layouts also refreshes their baked illumination.
- Building export uses an isolated copy of the authoring scene, excludes preview lights/cameras/actions, resets the eight shared-mesh fan rotor nodes for runtime motion and stages all five parts before publishing them. Local GLBs remain optional and ignored by Git.

## [0.4.46] - 2026-10-20

### Changed

- Local detailed characters use new bodies made in Blender from Character Creator base bodies (male slimmed to an office build, both 1.85 m on the same 20-joint skeleton): realistic skin tinted by the chosen skin tone, detailed eyes and lashes, and for men optional scanned beard, moustache and stubble with fuller brows. They wear scanned outfits retargeted onto them, a shirt, waistcoat, tie, belt, trousers and shoes for men and a bow blouse, trousers and heels for women, whose parts take the wardrobe palette. Hair now uses only the realistic hair-card styles from the hair packs (textured crop and slicked back for men, high ponytail for women), refitted to the new heads with their scalp layer; other styles wear the group's local style and the appearance editor offers only the local ones. The previous bodies and hair stay in the git-ignored `apps/web/local-assets/avatars-previous/`.

## [0.4.45] - 2026-10-19

### Added

- The F3 terrace's glass balustrade, base shoes and top rails can come from Blender (`terrace.glb`, exported by `tooling/blender/export-building-shell.py`, local-only): the rounded guard runs round the deck and opens onto the maintenance stair's landing. Once it is on screen the three.js terrace rails step aside; without it they stay as the backup. Balustrade glass does not take the window glow at night.

### Fixed

- The two west planters on the F3 terrace no longer stand at the foot of the maintenance stair; they now sit between the Blender stair's landing and the backup stair's gate.

## [0.4.44] - 2026-10-19

### Changed

- The exterior skin model now carries the latest Blender front: one continuous mitred ribbon set of uniform 1.42 m width with 3.2/4.6 diagonals, whose zigzag over the atrium runs shelf, diagonal, shelf, diagonal from the two aligned vertical caps; the upper diagonal now sits over the same span as the lower one, mirroring it. The west-side fold, lower band and corner fixes from 0.0.63 are kept.

## [0.4.43] - 2026-10-19

### Changed

- The Blender exterior skin (`extalia-shell.glb`, local-only) follows the mockup more closely. Front: the diagonal ribbons are full band thickness, the warm accent lines run along the lower edge of each band (the window heads) instead of splitting bands in the middle, the ground floor is full-height glass (no ground-level band, no west ground diagonal), and the atrium fold is wider, turning on a new panel between its two diagonals. West: the corner column stops at the lower band, which now runs straight round the corner to the side door; a new diagonal comes down from the top band over the tall corner glass and folds into a glazed U above the old left diagonal, and the right diagonal sits 8 m further back. A misplaced corner glass object that left a hole in the upper front-west corner is back in place.

## [0.4.42] - 2026-10-19

### Added

- The rooftop plant (air handlers, water tanks, louvered screens, service walkways), the maintenance stair to the roof with its landings, and the glass lifts' static frames, rails, glazing and bridges can also come from Blender (`roof-utilities.glb`, `roof-stair.glb`, `elevators.glb`, exported by `tooling/blender/export-building-shell.py`, local-only). The model's eight AC fan rotors are spun by the app's independent motors; lift cabs, doors and lights stay in the app, and in single-floor views the app keeps its per-floor lift landings. Each part falls back to its three.js version when its file is absent or fails; `?building=threejs` forces every backup.

## [0.4.41] - 2026-10-19

### Added

- The campus building can use the exterior skin modelled in Blender: `tooling/blender/export-building-shell.py` exports the scene's "ExtaliaShell" collection (and the canopy sign backing) to the local-only `apps/web/local-assets/building/extalia-shell.glb`, already in world coordinates. When present, the app loads it with live glass and accent materials (night glow follows the sky and the interior lights) and hangs the entrance lettering on the model's canopy sign; when absent or failing to load — or with `?building=threejs` — the three.js shell renders as the backup.

## [0.4.40] - 2026-10-19

### Changed

- Rooftop AC fans run on their own thermostats: each of the eight motors runs 9–45 s at its own speed (±15% per run), stops, coasts down on its inertia, rests 6–24 s and starts again, from its own random stream — so motors stop and restart independently instead of turning in lockstep forever. Reduced motion keeps them still.

## [0.4.39] - 2026-10-19

### Fixed

- Office prompt dock: folding open and shut no longer glitches; the rows above and below the field fold as CSS grid rows (both ways) instead of being measured and hidden in one frame.

## [0.4.38] - 2026-10-19

### Changed

- Office prompt dock: the compact dock folds open and shut smoothly in both directions — the rows above and below the field (workspace, target, team, model, hint) grow from zero height as CSS grid rows while fading, so the dock grows upward from its pinned bottom with no jump; folded rows are inert. Reduced motion keeps the instant change.

## [0.4.37] - 2026-10-19

### Changed

- Campus building skin follows the reference's silver diagonal ribbon frames, long recessed window slots and broad glazed corner. Window openings are part of the panel geometry; the old floating diagonal strips are removed. Diamond cladding, slim mullions, aligned entrance canopy and warm accent edges complete the exterior while retaining the three existing floors and circulation openings.

### Fixed

- Mixed indexed sweep and extruded facade geometry is normalized before batching. Solar-driven cladding materials remain live after static batching, including day-to-night changes.

## [0.4.36] - 2026-10-19

### Changed

- Building exterior: the facade bands are continuous swept solids that wrap the corners on a 1.2 m radius (no seams or loose panels), with continuous glazing, caps and accent lines; openings (lift portals, emergency exit, terrace door) are cut out of the band. The stepped front ribbons are single mitred solids, the roof parapet wraps the roof, and the cladding is light anodised aluminium with a metre-scaled diamond pattern that runs on around corners.
- The large `/>` emblem over the entrance is removed; the entrance keeps the logo-and-name lockup on the canopy.

## [0.4.35] - 2026-10-19

### Added

- Detailed hair-card hair for local avatars: textured crop and slicked back (male), high ponytail and bun (female; bun is a real style again). `tooling/convert-detailed-hair.py` (Blender) fits a licensed hair pack to the canonical head and skeleton with a tintable strand texture; `tooling/register-detailed-hair.mjs` records it and the hair check validates it. Outputs stay local-only.

### Changed

- Hair is kept per gender: the appearance editor offers only the character's own group (male or female styles), and generated looks wear the detailed styles of their group.
- Looks on the business-woman body (a face shell without a skull) wear detailed hair on the whole-head female body.

### Fixed

- Hair cards render as cut-outs instead of blended layers, which vanished from some angles (a bun looked bald) or looked hazy.

## [0.4.34] - 2026-10-18

### Changed

- Keyboards and mice have real sizes: compact (31 × 12.5 cm) and full boards with a number pad (44 × 13.5 cm) at 19 mm key pitch, a 6.4 × 11.6 cm mouse on a 22 × 19 cm pad. The mouse sits 2–5 cm beside the keyboard.
- Every desk is arranged differently and stably per seat (`deskLayout`): keyboard size, offset and angle, left- or right-handed mouse, and its own desktop furniture — mini drawer cabinet for documents, stacked letter trays, file holder with folders, books between bookends, plant, photo, notebook, headphone stand, pen cup, sticky notes. Avatars' hand targets read the same arrangement, so hands land on each desk's own keyboard and mouse.
- Laptops with an external keyboard stand on a laptop stand behind the keyboard and mouse (single desks and pods).
- The Office camera zooms toward the cursor and goes about four times closer (a character can fill the view).

### Fixed

- Typing hands reach the keyboard on every desk kind: single-desk keyboards sit 2.5 cm nearer the sitter and wrists rest at the keyboard's front edge.

## [0.4.33] - 2026-10-18

### Fixed

- The procedural fallback character now has the detailed models' proportions: a head about an eighth of the height (it was about a fifth), legs a little over half of it, thicker limbs, a shorter neck and the same ~1.67 m stature.
- Hair and clothing of seated detailed avatars no longer vanish in close-ups: skinned-mesh culling bounds now cover the seated pose, not only the standing bind pose.

### Changed

- Avatar level of detail uses the same model at every distance (no swap, no change of shape): figures small on screen pose every second or third frame, and tiny ones stop casting shadows.

## [0.4.32] - 2026-10-18

### Fixed

- Avatar spawn no longer briefly displays the procedural body before a local detailed model is ready. Selected body and hair requests start together and reuse their per-URL caches; unavailable or failed source models retain the procedural fallback.

## [0.4.31] - 2026-10-18

### Fixed

- Workstation monitors now use smaller 16:9 panels, shorter stands and feet anchored to actual tabletop heights. Single, pod, executive, touchdown and reception desks share the placement contract; multi-monitor spacing follows the reduced widths.
- Laptops now have a 36 × 25 cm chassis and a hinged, proportionate display. Their decks rest on the desk instead of floating; screen content, independent animation state and existing keyboard/mouse hand targets are retained.

## [0.4.30] - 2026-10-18

### Fixed

- Furniture/avatar fit: slimmer workstation chairs and lower arm pads, shared 46 cm office/meeting/guest cushions, 43 cm sofas and 45 cm armchairs. Chairs move under their sitters while workstation avatar roots and keyboard reach stay fixed; the custom executive sofa matches its semantic height.
- Seated avatars use the actual cushion height and front edge. Thigh support limits also apply to relaxed clip offsets; source leg poses use measured rest-bone lengths and keep shoes from sinking through the floor. The procedural fallback no longer assumes every seat is 45 cm high.
- Chair stand-up and scoot hand targets follow the resized arm pads and seat edge.

## [0.4.29] - 2026-10-18

### Fixed

- Desk animations: typing hands face the keys with palms down and the backs of the hands up. Source-model wrist pronation uses the rig's actual rest basis; source limb tilts and the posed chest frame now match the IK targets, with mouse wrists above the device. Seated roots use chair-local offsets consistently with keyboard targets.
- Observed sessions first reported by hooks keep the same character when their transcript is later selected manually, including after host restart and session resume.
- Native mission persistence: caller option mutation cannot remove an active commit boundary, and read-tool prechecks run only after the tool-start acknowledgement. Transient journal retention also clears its event-ID index and rejects cross-mission duplicate IDs.

## [0.4.28] - 2026-10-18

### Fixed

- Seated characters (model avatars) no longer fold their arms across the chest: each arm now reaches the hand target on its own side (the arms were paired by bone name, and the bundled rig names its +X arm "right").
- Hands reach the keyboard and mouse with bent elbows instead of stretching into the air: single-desk chairs sit 13 cm closer, pod sitters sit forward on the seat, the CEO chair moved from 1.4 m to under 1 m from the desk, and wrists trail the fingertips on the keys.

## [0.4.27] - 2026-10-18

### Added

- Native missions: budgets (duration, mission/task tokens, concurrency) enforced by the scheduler with honest usage (unreported usage is "unknown", never zero); atomic mission control events with an execution acknowledgement before every provider/tool call (ADR 0014, ADR 0015). The OpenAI-compatible adapter now requests token usage when streaming.
- Mission workers appear in the 3D Office as subagents under their lead with mission badge, task title, provider/model and truthful states (queued, working, ready, error, unknown) (ADR 0016).
- Workspace default team: saved on the host and inherited by every new session in the workspace (dock, Chat, Missions, continued sessions); every turn carries the team (Native system prompt, Hermes brief).
- Approval inbox: one place (shield button in the top bar, Alt+A) for every pending approval with who/what/risk and Allow once / Allow for this session / Deny; desktop notifications (web after opting in); inline answers on the board and avatar card.
- Context usage per agent (managed, Claude Code, Codex): "Context 62% · 124k / 200k" on the board, avatar card, session dialog and composer ring.
- Chat composer in the style of Claude Code desktop, shared by the Chat page and the session dialog: up to 10 attachments (pick, drop, paste; images to vision models, text inlined, Hermes gets file paths), model and effort pickers, permission mode (workspace default, ask, accept edits, plan/read-only) enforced by the host, and a context ring.
- ADR 0018 (proposed): observed approval bridge — Claude Code and Codex hooks can return allow/deny; Hermes needs an in-process plugin; Gemini/Antigravity unverified.

### Changed

- Agents & sessions: newest activity on top (leads and their subagents), with animated reordering; animated expand/collapse; tree lines behind portraits, colored by status and flowing for active subagents, with rounded joints.
- Observed agents always show their latest reported model; a continued Claude Code chat (new session file copying the earlier one) keeps the same character instead of adding a new one.
- Seated characters reach the keyboard and mouse with arm IK (single desks seat closer), sip from a mug or look at a phone while idle at the desk; chairs move only when a character pulls or pushes them; hinged doors are opened by hand and closed by the last person through (left open when someone follows).

### Fixed

- Several tests that were flaky under parallel load.

## [0.4.26] - 2026-10-17

### Added

- Saved native mission checkpoints now use host-owned SQLite WAL transactions, committing each checkpoint with its revision/change record. Validated legacy sidecars import once and remain preserved; removal tombstones prevent stale history from returning.

### Fixed

- Interrupted checkpoints are committed as recovering/unknown before startup exposes them, without replay. Missing session metadata cannot hide unresolved connection quarantine; corrupt/newer databases and failed transactions fail closed. History-off missions remain in memory.

### Changed

- Bridge/CLI now require Node.js 22.13+ (Node 23 requires 23.4+) for built-in SQLite. Session JSONL events remain separate; full transactional task/tool recovery and budgets are still pending.

## [0.4.25] - 2026-10-17

### Fixed

- Native mission planning now reserves its session and lead connection before provider preparation, preventing overlapping plans, prompts and missions. Cancellation and the lead-call deadline retain busy capacity until an abort-ignoring provider actually settles, and late replies cannot replace the fallback plan.
- Mission history retains validated task dependencies so reopened runs keep their graph. Older records without edges remain explicitly unavailable; resizing the graph from desktop to phone no longer leaves a wide connector overlay.

## [0.4.24] - 2026-10-17

### Changed

- Characters walk at a natural, brisker pace (about 1.4–1.7 m/s) with a personal pace per character and small per-trip variation; they stroll during leisure and hurry back when real work arrives; corners no longer slow them to a crawl, and stride/cadence scale with speed so feet don't slide.
- Subagents arrive like people: they appear at their floor's elevator/stair arrival point (or the F1 entrance) and walk to their desk, admitted at most about three per second. When their work ends they stay in the office as Ready for 7–20 minutes (idle routine), then walk to the nearest exit and fade out, never back into their lead.

## [0.4.23] - 2026-10-17

### Added

- Missions (PRD v1 Stage 2): a Missions page where a managed Extalia Native session's lead plans a read-only mission (`planNativeMission`: one lead call, strict parse, only workspace-allowed connection/model pairs, at least two providers when two are allowed, deterministic fallback plan) and the user reviews it as a task graph, edits tasks, models and dependencies, launches it, and monitors task states per worker/provider/model; answers are shown as unverified model answers and progress as "N of M tasks completed". Planning never starts anything; missions stay read-only (ADR 0010, ADR 0011).
- Observed agents that go silent in an active state show "No response · since HH:MM" (3 min thinking/planning/compacting, 10 min while a tool runs, 15 min for commands/tests; never while waiting for you); after 30 min they leave. Stop reasons from transcripts and hooks (out of tokens or quota, rate limit, overloaded, auth, context, interrupted) are shown, with "Out of tokens or quota" for exhausted sessions.

### Changed

- Agents & sessions lists only agents present now; earlier observed leads and offline subagents move to a collapsed "Earlier (N)" section (remembered per device, searchable), are not drawn in the 3D office and are not counted. "No response" counts under Errors.

## [0.4.22] - 2026-10-17

### Added

- Google Antigravity (`antigravity`) support in Connect agent apps (`extalia connect antigravity` / `disconnect`), live hook ingestion (`~/.gemini/config/hooks.json` via `/api/hooks/antigravity`) and native transcript discovery/import/observation (`~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`).
- Adaptive light/dark brand logos (`AgentAppLogo` and `OriginMark`) for Codex, Claude Code, Gemini CLI, Antigravity and Hermes across Settings → Connect agent apps, Observe auto-watch locations, the Setup Wizard and the 3D Office board.

### Fixed

- Night spotlight irradiance across F1, F2 and F3: F3 stairwell ceiling downlights (`stair-void-ceiling-f3`) now reach the F2→F3 staircase below (`floorY: 6.4`), F1 under-stair bar soffit downlights stay inside the east building boundary so they are not masked as exterior lights, `BarPendantCluster` mounts beneath the stair mid-landing soffit, and stair flight/landing rails, circulation corridors, team pod halos, wall washers, plinths, sconces and lamps cast visible pools of light.

## [0.4.21] - 2026-10-17

### Added

- Native mission start/status/history through the authenticated host API, with explicit workspace connection authorization, separate provider credentials and read-only file tools.
- Canonical correlated session events and bounded versioned mission results, preserving history-off privacy and marking unfinished work recovering after restart without replay.

### Fixed

- Native mission admission, cancellation and unknown-execution quarantine now protect overlapping prompts, connection policy changes and deletion; storage errors no longer imply persisted mission success.
- Unknown model context capacity can remain unspecified rather than using an invented limit. The observer integration test's outer timeout now accommodates its existing bounded waits.

## [0.4.20] - 2026-10-17

### Added

- A programmatic, read-only native mission supervisor with explicit provider/model bindings, dependency results, bounded concurrency and task deadlines. Local adapter tests exercise three parallel tasks over OpenAI and Anthropic implementations; host/UI integration and durable control remain pending.

### Fixed

- Added regression coverage for specific observed failure reasons, stale activity timestamps and synthetic failed replies, preserving the updated observer behavior.
- Native mission cancellation and failure handling preserve unrelated tasks and report unknown execution when a provider does not acknowledge abort.

## [0.4.19] - 2026-10-17

### Added

- Versioned native orchestration wire contracts and strict validation for missions, task DAGs, agents, models, budgets, scoped approvals, observation provenance and learning candidates; existing v0 events remain compatible. These contracts do not yet run a durable scheduler or enforce runtime policy.
- Native orchestration baseline, requirement/acceptance status and a continuation handoff, including remaining implementation stages and ADR 0007.

## [0.4.18] - 2026-10-17

### Added

- Rich observed statuses for Claude Code, Codex, Gemini CLI and Hermes (hooks and transcripts): Thinking, Planning, Reading, Editing, Running a command or tests, Searching, Browsing, Using an MCP tool, Delegating, Waiting for approval, Waiting for you, Compacting context, Interrupted, Error, Ready, Ended (optional `phase` on `agent.state`/`subagent.state`).
- Characters answer with a short random greeting bubble when picked from the board or lead cards; seated work poses follow the real activity (typing, scrolling, reading, thinking, watching output); idle characters stay at their desk 1–5 min, then spend 6–15 min chatting, at the gym, TV, games, terrace, lounge, pantry or garden, and return as soon as real work arrives. Desk chairs slide out and back when sitting down or leaving.
- Markdown tables in chat and transcripts (GitHub-flavoured, alignment, horizontal scroll).
- Board rows show a compact "time ago" next to the name; tree joints are rounded.
- Settings: model fields (connection model after Test, Complex/Standard/Quick tiers) are combo boxes that list the endpoint's models and still accept typing; max delegations is a select; the agent runtime is chosen from cards.
- Teams: up to 20 members; Plan with AI gives each member the models that fit it (usually 1–3, in fallback order) from the allowed list, plus a generated soul and reasons; a filter box for allowed models; the lead delegates only when a request concerns a member's role or scope.

### Fixed

- Observed Claude Code subagents showed "Ready" while working (they inherited the lead's idle state after background tasks were launched); each agent now has its own state, and an idle lead with working subagents shows "Delegating".
- Observed subagents lost their place under the lead when their announcement fell out of the event window; announcements are kept and unknown hook agent ids are attached to the lead. Hook-announced subagents take labels and models from their transcript files.
- Agents & sessions counters count every agent on the board exactly once (Working, Waiting, Errors, Ready) plus Running and Observed, with explanations.
- Screen light no longer glares on characters, only lights the surroundings at night with room lights off, and no longer leaks behind TVs; elevator cab lights move with the cab; added night downlights around the stair/elevator core on F1–F3.

## [0.4.17] - 2026-10-16

### Added

- Observed subagent trees from transcripts: Claude Code subagent files (`<session>/subagents/agent-*.jsonl` + `.meta.json`) and Codex child threads (`thread_spawn.parent_thread_id`, any depth) are shown under their lead with their label/nickname, role and model; Codex children are no longer listed or watched as separate sessions.
- The board shows where each observed agent comes from (Codex, Claude Code, Gemini CLI, Hermes), how it arrives (live via hook, from transcript, Hermes dashboard) and the model in use; observed leads and subagents get names (source nickname or a generated full name) and matching looks.
- Ignored folders on the Observe page (default `~/.claude-mem`, whose background helper sessions were showing up as characters): never auto-watched, ingested from hooks or shown in the Office; matching scan results are dimmed.
- Large live transcripts (over 4 MB) are observed from their first 512 KB and last 3 MB instead of being skipped.

### Changed

- Board tree lines are thin dashed lines.

### Fixed

- Observed session titles skip injected context (Codex AGENTS.md / environment blocks, Claude agent messages and reminders) and use Claude custom titles and Codex thread names when present.

## [0.4.16] - 2026-10-16

### Changed

- The Building view (the Office's first view) is framed to the office building and its entrance plaza from a slightly higher angle (about 17°), filling the stage area the overlays leave free, instead of a low wide shot of the whole block.

## [0.4.15] - 2026-10-16

### Changed

- Floor views (F1–F3) frame the whole floor plate as large as possible in the stage area the board and bottom overlays leave free, from a slightly steeper angle (`floorOverviewPose`), so the first view no longer cuts the floor off.
- The active agent cards sit at the very bottom of the Office with the prompt dock right above them; without active agents the dock is the bottom-most overlay.
- The outside view tab is called "Building" ("Gedung"), matching Building → F1–F3 → All floors.

### Removed

- The "Drag to orbit · Scroll to zoom" label over the 3D Office.

## [0.4.14] - 2026-10-16

### Removed

- Activity toasts in the 3D Office: what characters do now shows only as the flash bubble over each character (the Activity drawer keeps the full list).

## [0.4.13] - 2026-10-16

### Added

- Observed sessions show their subagents as a tree under the lead also when watched through transcripts only: Claude Code sidechain agents are announced once, labelled by the delegation that started them (hooks already did this for Claude Code, Codex and Hermes).

## [0.4.12] - 2026-10-16

### Added

- Subagent teams work on Hermes workspaces: Plan with AI uses the profile's local router (key sent only to loopback, `${VAR}` keys resolved like Hermes does), teams are saved per session, and an enabled team is briefed to Hermes, which delegates with its own `delegate_task` (one model for all children — the dialog says so).
- Plan with AI no longer needs a goal or ticked models: without a goal it plans a general team for the workspace; without models it chooses from the workspace's models and ticks the ones it used, in priority order. Planning may take up to 45 s before falling back to the heuristic plan.

### Fixed

- The Office prompt dock starts as a single compact field and opens its workspace, target, team, model and effort controls only when used.
- Scrolling over the lead-agent cards (or the empty strip around them) zooms the 3D Office again instead of being swallowed by the strip.

## [0.4.11] - 2026-10-16

### Added

- Every agent has a full name from one office-wide generator (e.g. "Elena Mark"), unique across sessions; a lead's name and gender are assigned when its session starts and saved. Default looks are generated from the full name and explicit gender, so the 3D character, board portrait, card and team dialog match.
- Teams from the prompt: a prompt with subagent blocks (`Subagent A:` or the "Lead Orchestrator" template with `#### Subagent 1:`; English or Indonesian labels: Name/Nama, Gender, Role/Peran, Model, Soul/Persona, Tugas/Task, Batasan) creates or updates the lead's team before the turn; the dock previews it ("Team from prompt · 2") with Review. The lead can also add or change members itself (`manage_team`).
- Write-capable members: a member may edit inside its scope (forbidden paths win; `..` and absolute paths are refused), with command approvals through the normal flow; writers run one at a time. Team members carry gender, soul/persona, access, scope and forbidden paths.

### Changed

- Board tree lines are clearly drawn from a lead to its members, and team members stay listed under their lead (as offline) when they are not working.

### Fixed

- The Extalia logo gradient material failed to compile on geometry with RGBA vertex colours (WebGL "useProgram: program not valid").

## [0.4.10] - 2026-10-16

### Changed

- Updated `.node-version` to Node 26 and upgraded workspace dependencies (`@types/node` 26, Electron 44.7, Three.js 0.186, React Three Fiber 9.8, Drei 10.7.9, React 19.3.1, Vite 8.3.4, Vitest 5.0.4, `@anthropic-ai/sdk` 0.134, `@radix-ui/react-select` 2.4.1, `smol-toml` 1.9.1, and `typescript-eslint` 8.71.2).

## [0.4.9] - 2026-10-16

### Added

- Subagent teams for Extalia Native lead agents: turn on "Use subagents automatically" and the lead always delegates to its team without being asked. The setup dialog (Team chip in the prompt dock, Team button in the lead's session dialog) sets the count, names (generated, editable), roles and tasks, and the allowed models in priority order; "Plan with AI" splits the goal across members and assigns models, "Re-plan" rebalances while keeping your edits. Members keep the single-writer rule (read-only research, review and analysis; the lead edits).
- Model fallback: when a model runs out of quota, credit or rate limit, the member (or the lead) retries with the next model in its order and says so in the Office.
- Agents & sessions board shows each agent's portrait and nests subagents under their lead (collapsible branches with a count).

### Changed

- Nothing floats over characters except the flash bubble; hovering shows only the name (no status or task text), and selection no longer pins it.

## [0.4.8] - 2026-10-16

### Added

- Per-session model and effort: `createSession(workspaceId, options)`, `setSessionOptions` and `modelChoices` (Native: the connection's listed models, effort for Anthropic connections; Hermes: the profile's router models and `--reasoning` when the Hermes CLI supports it).
- Office prompt dock redesign: grows out of the bottom-left corner on first load, auto-growing field, model combo box, effort control, and a target chip ("New session" or continue a chosen agent's session). The avatar card has its own "Message <name>…" field.

### Changed

- Agents & sessions board rows show name, status and model; details expand on demand, and clicking a row focuses the avatar and points the dock at that session (subagents point at their lead) instead of opening the dialog.
- Nothing floats above a character by default: name tags appear on hover, selection, follow or keyboard focus; bubbles only while work is in progress.
- Lead agents sit in the CEO office (then the leadership desk); subagents take a stable desk in a room that fits their work.
- Monitors, laptops and wall screens on the same desk or neighbouring desks never show the same picture (lock, screensaver and clock variants per slot, varied wallpapers); screens ignore fog and the busiest desks get the screen light pool first, so dark rooms are lit by their screens.

## [0.4.7] - 2026-10-15

### Changed

- Character appearance presets and walking styles now use only `feminine` and `masculine` (`packages/core/src/characterAppearance.ts`, `apps/web/src/office/scene/avatars/{appearance,rig,gait}.ts`); the `neutral` gender/style preset is removed and generated character looks pair each character's presentation with matching male or female hair and gait.

### Fixed

- 2D character portraits (`apps/web/src/office/overlay/{AgentPortrait.tsx,portrait.ts}`): closed the gap between the forehead/temples and hair across all 11 hairstyles (including `undercut`), added a seamless cranium base cap, proportioned the ears and neck/shoulder silhouette, added tailored jacket lapels, and refined eye/brow/glasses proportions.

## [0.4.6] - 2026-10-15

### Changed

- The Hermes model field is now a glass combo box matching the other pickers: "Profile default" first, the router's models grouped by provider, filtering as you type, and "Use “…”" to keep any model id you write yourself (`ui/ComboBox.tsx`, ARIA combobox with keyboard support).

## [0.4.5] - 2026-10-15

### Added

- Hermes workspaces read the selected profile's default model from its `config.yaml` and, when the profile uses a router on this computer (9Router, OmniRoute, Ollama, …), list that router's models to pick from (`hermesModels` host method; remote providers are never queried and the profile's API key is never returned). The model field shows the default, offers the list as you type, can rescan, and explains when a profile has no default model.

## [0.4.4] - 2026-10-15

### Fixed

- Provider picker: the official Anthropic mark replaces the wrong image, 9Router and OmniRoute use monochrome tiles that suit light and dark themes, the "Local" badge sits on the card's top row instead of spilling past its edge, cards in a row have equal heights, and the Liquid Glass Pro selection is a thin iridescent rim instead of a rainbow fill.

## [0.4.3] - 2026-10-15

### Added

- The theme picker (welcome setup and Settings) explains what each choice changes, in the interface and in the 3D Office (day, night, or following the real sun), and notes that the office lamps are set separately. Solar Cycle has its own sunrise icon.

## [0.4.2] - 2026-10-15

### Fixed

- Deleting `~/.extalia-vo` now really starts fresh: an old data folder that was already copied once (it holds `MIGRATED_TO_EXTALIA_VO.txt`) is never copied again.

## [0.4.1] - 2026-10-15

### Added

- Welcome setup on first run (and once for older configs, with the existing connection and workspace preselected): Welcome and language, Profile and appearance, Connection, Workspace, Connect agent apps, Done, then the 3D Office.
- One profile folder for Web and Desktop: `~/.extalia-vo` (Windows `%USERPROFILE%\.extalia-vo`). Existing data is copied once from the previous location (never moved or deleted); interface preferences (language, theme, surface style, font, sidebar) are saved in the profile, and Settings shows the folder.
- The splash plays a pre-rendered loop of the 3D office (night in dark theme, day in light theme); reduced motion and Save-Data show a still image.

### Changed

- Liquid Glass Pro v2: glass slabs with iridescent rims, bevels and nested frosted panels over a slow plasma backdrop, in CSS only (the WebGL `plasma-ui` library was measured and not added because it cost Office frame rate).

### Fixed

- React key warnings in the Office labels and stage; the desktop smoke test follows the moved floor controls.

<!-- ======================================================================= -->
<!-- Milestone 4: Subagents & Project Orchestration (v0.4.x)                -->
<!-- ======================================================================= -->

## [0.4.0] - 2026-10-15

### Added

- Lightweight branded splash and boot coordinator: first run shows only Setup; once set up, every launch opens the 3D Office (legacy remembered mode migrated). Recovery panel with Retry on boot errors.
- 3D Office floor (Campus/F1/F2/F3/All) and light (Auto/On/Off) controls moved into the top bar, Office page only, from one shared store; the Virtual Agent/Virtual Office switch is removed (Chat stays in the sidebar).
- Avatar click opens a compact anchored character card (Message, Activity, Follow, Appearance); a board row opens a separate accessible session dialog with Messages and Activity tabs, restoring the board and focus on close.
- Facility staff: a receptionist (F1 reception) and a bartender (F1 bar) with duty states, legal routes only (F1, F3 terrace/fitness), never counted as agents; agents can no longer take their stations.
- Privacy-safe semantic bubbles: bubbles, toasts, name tags and in-world screens show fixed phrases ("Running a command…", "Editing code…") instead of raw commands, paths or replies; raw detail stays in the Activity panel.
- Explicit restart: Desktop "Restart now" (confirms when work or drafts are active, relaunches through the normal shutdown); Web "Reload page" that states it does not restart the Bridge or outside apps. Connect agent apps shows restart and Codex `/hooks` approval as separate prerequisites.
- "Liquid Glass Pro" surface style (CSS only, light and dark, reduced-transparency and reduced-motion fallbacks); Standard and Liquid glass unchanged.

### Fixed

- Auto-watch enabled by `extalia connect` while the Bridge or Desktop is running now reaches the running host (discovery settings are re-read when the file changes, so neither side overwrites the other).
- The Office fills the window without page scrolling at desktop sizes; compact sidebar and top bar have a visible gutter in glass styles.

## [0.3.4] - 2026-10-15

### Added

- `extalia mcp [--app <codex|claude|gemini|hermes>] [--session <id>] [--port <number>]` stdio JSON-RPC 2.0 MCP server (`packages/host/src/hooks/mcp.ts`, `apps/cli/src/connect.ts`), exposing `report_intent` and `report_handoff` tools with `EXTALIA_MCP_INSTRUCTION` and forwarding calls directly to the local hook ingest endpoint (`127.0.0.1:<port>/api/hooks/<app>`).
- Connecting an agent app (`extalia connect <app>` or `applyAgentAppConnect`) now automatically enables "Watch new sessions automatically" (`autoWatch`) for that app's primary transcript location (`packages/host/src/observations.ts`, `packages/host/src/connect/service.ts`) so outside sessions fall back gracefully to transcript polling before hooks are approved or loaded.

## [0.3.3] - 2026-10-15

### Added

- End-to-end privacy and Hermes dashboard controls in "Connect agent apps" (`ConnectAgentAppsCard.tsx`, `setHookPrivacy` on `@extalia/platform` and `@extalia/host`):
  - Persisted **Labels only** (`labelsOnly`) toggle that strips prompt text, assistant reply bodies and tool outputs across both live hooks and transcript polling while keeping structured activity labels in the Virtual Office.
  - Optional loopback **Hermes dashboard URL** (`hermesDashboardUrl`, e.g. `http://127.0.0.1:9119`) wired into `Observations.discover` and `Observations.refresh` so active Hermes dashboard sessions are discovered and incrementally polled via `/api/sessions` and `/api/sessions/{id}/timeline?after_row_id=<cursor>` without reading `state.db`.
- Mock host (`apps/web/src/host/mockHost.ts`) now enables Gemini CLI and Hermes in "Connect agent apps" alongside Codex and Claude Code, and supports `setHookPrivacy`.

### Fixed

- Observed transcript turns whose last assistant reply lacks an explicit `final` marker (older Codex rollouts or Claude Code entries without `stop_reason`) now settle to `turn.completed` and `agent.state: idle` after 30 seconds of inactivity (`packages/host/src/transcriptEvents.ts`).
- Subagents spawned inside observed sessions via hooks (`SubagentStart` / `SubagentStop` or MCP `report_handoff`) now track their own `working` and `offline` state in the Virtual Office instead of mirroring the lead agent's status (`apps/web/src/office/presence.ts`).

## [0.3.2] - 2026-10-15

### Added

- Hermes dashboard read source (`packages/host/src/hermesDashboard.ts`): optional loopback-only HTTP reader for `/api/sessions` and `/api/sessions/{id}/timeline` with incremental `after_row_id` cursor polling as an alternative to reading `state.db` directly.
- Optional Extalia MCP reporting (`packages/host/src/hooks/mcp.ts`): `report_intent` and `report_handoff` tool schemas, instructions and hook normalization so outside agents can report high-level intent and subagent handoffs directly to the Virtual Office.
- Privacy `labelsOnly` option on hook normalization and ingest (`packages/host/src/hooks/{normalize,ingest}.ts`) to drop prompt text, assistant replies and tool output while keeping structured activity labels.

## [0.3.1] - 2026-10-15

### Added

- Live agent-app hooks and `extalia connect`: connect Codex, Claude Code, Gemini CLI and Hermes once so their sessions and tool steps appear live in the Virtual Office within a second.
  - Loopback hook ingest endpoint (`POST http://127.0.0.1:<port>/api/hooks/<codex|claude|gemini|hermes>`) on both the Bridge and Desktop (`@extalia/host`), authenticated with a separate `0600` ingest token (`Bearer`) or `X-Hermes-Signature-256` HMAC, bounded to 64 KB JSON bodies, rate limited, and always answering `204` so hooks never block or steer an outside agent.
  - Pure hook normalizers (`packages/host/src/hooks/normalize.ts`) for Codex, Claude Code, Gemini CLI and Hermes outbound webhooks, mapping native events to Extalia Protocol events (`session.started`, `prompt.submitted`, `agent.state`, `tool.started`, `tool.completed`, `file.written`, `subagent.spawned`, `subagent.state`, `turn.completed`, `session.ended`), linking `transcript_path` when inside a known root, deduplicating against transcript polling, and skipping Hermes sessions managed by Extalia itself.
  - Dependency-free hook forwarder (`EXTALIA_HOME/hooks/forward.mjs`) and CLI commands `extalia connect <codex|claude|gemini|hermes>` (`--dry-run`, `--yes`, `--port`, `--rotate`, `--trust`), `extalia disconnect <app>` and `extalia connections`, with unified diffs, non-colliding timestamped backups and byte-exact or surgical undo:
    - **Codex**: comment-preserving `[[hooks.<Event>]]` block in `$CODEX_HOME/config.toml` and optional `--trust` approval through the Codex app-server.
    - **Claude Code**: HTTP hooks (`timeout: 2`) plus a `SessionStart` command forwarder in `~/.claude/settings.json`, with managed-policy warnings (`disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`).
    - **Gemini CLI**: command forwarder hooks (`timeout: 2000` ms) in `~/.gemini/settings.json` for `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool` and `Notification`.
    - **Hermes**: comment-preserving YAML `hooks.outbound` webhook entry across default and named profile `config.yaml` files with HMAC-SHA256 signing.
  - "Connect agent apps" / "Hubungkan aplikasi agent" card (`ConnectAgentAppsCard.tsx`) in Settings, Observe and the Virtual Office toolbar, with one-click **Copy command**, **Copy prompt**, diff preview, **Test** and **Disconnect** in English and Indonesian.

<!-- ======================================================================= -->
<!-- Milestone 3: Import Center & Agent Console (v0.3.x)                   -->
<!-- ======================================================================= -->

## [0.3.0] - 2026-10-11

### Added

- Watch new sessions automatically (opt-in per source on the Observe page): Codex, Claude Code, Gemini CLI and Hermes sessions that change after you opt in are observed without picking them, up to 24 at a time; the least recently active ones move to History. Sessions you pick by hand stay until you remove them.
- Observed sessions now report real activity from their transcripts: prompts, tool steps (classified, with the file or command), results and finished turns, about one second after the agent writes them. In the Office their characters think, work and idle like managed ones (live when the last event is under two minutes old, idle after ten), and their screens, bubbles, toasts and read-only console show the steps.

### Fixed

- Observed sessions are matched to the workspace whose folder contains their project, so they appear under the Office's project filter.
- The Office's "Start an agent" box no longer says no agent is working while an observed agent is busy.
- Codex environment context and project instructions no longer show up as user messages in imported or observed sessions.

## [0.2.4] - 2026-10-11

### Changed

- After setup and on every later launch the app opens the Virtual Agent (Chat and sessions) or, if that was the last one used, the Virtual Office. A "Virtual Agent | Virtual Office" switch in the top bar changes mode; the choice and the last workspace are remembered per device.
- Setup's Connection step always offers Extalia Native and Hermes Agent; when Hermes is not installed its card explains how to install it or point `EXTALIA_HERMES_BIN` at it, with a Check again button. The wizard's wording covers both runtimes and ends with "Open Virtual Agent".
- Hermes workspaces show their permissions as "Managed by Hermes", with one explicit switch to bypass Hermes approvals.
- The 9Router preset no longer requires an API key (a local 9Router answers without one).

### Fixed

- The Hermes logo was missing (404) in the light theme of the setup wizard.
- The 9Router and OmniRoute logos were invisible (white on white) in the light theme.
- Testing a custom endpoint no longer requires a model name first and shows readable errors instead of validation messages.
- Switching the workflow in Settings no longer sends a set-up app back to the setup wizard.

### Documentation

- `docs/product/prd-app-flow-and-live-agents.md`: product requirements, verified status and working protocol for the app flow, modes and live agent apps (phases A–E).

## [0.2.3] - 2026-10-10

### Added

- Day and night: the Office follows the sun for the device's time zone (no location prompt, no network), with dusk, blue hour and dark nights lit by real pools of light (entrance, plaza, paths, facade, tree uplights, street lights) and warm office windows. An Auto / On / Off lights control in the Office toolbar switches the interior lights; with them off at night only exit signs and screens light the rooms. An adaptive render budget keeps the scene smooth.
- Screens behave per device: monitor 1, 2 and 3 of a desk show an editor, a terminal or test runner, and docs; laptops, all-in-ones, the reception desk, wall boards and the entertainment TV each have their own look. Content follows the seated agent's reported activity (editing, running commands, tests, research, waiting for approval) without inventing details, idle desks show a lock screen, and empty desks go dark at night with the lights off. Screens glow and light desks, keyboards and faces at night, most strongly with the lights off.
- Building branding: the Extalia emblem above the main entrance, the wordmark over the door and a front board on the forecourt, backlit at night.
- Office overlay: search (`/`) for agents, rooms and activity; a room picker grouped by floor; a Recent activity drawer; lead-agent cards with portraits drawn from each character's look; six KPIs (running, waiting, working, errors, observed, idle); opt-in camera follow (F) next to Find in office; and an "Office full" notice listing agents without a desk.
- Name tags show what a character is doing under its name, and a dashed line shows where a selected walking character is heading.

### Fixed

- Campus signs drawn on canvas textures (the old monument, the wayfinding pylon and the cafe sign) were blank because their textures were uploaded before they were sized.
- The render budget's resolution changes were undone whenever the canvas re-rendered.

## [0.2.2] - 2026-10-09

### Added

- Characters walk: a new agent walks in from the lobby door to its desk and sits down; one that leaves stands up and walks out; workers step out at their lead's desk and walk back when done. Routes follow an authored corridor graph (A*) on each floor, and floor changes use the indoor stairs or ride either glass elevator through its real controller (doors and cab move with the rider). The walk cycle uses the character's walking style (stride, cadence, arm swing, hip sway); name tags, bubbles and the camera follow walkers. Agents already present when the Office opens start seated, arrivals are spaced at the entrance, and reduced motion places characters directly at their desks.
- Characters keep their desks when other agents arrive or leave.
- Character console in the Office: Messages and Activity tabs (a timeline of prompts, steps with status and duration, delegations, approvals with their decision, and results with tokens and duration), the lead agent's team of workers (select one to open it), Find in office, a larger dialog for long conversations (focus stays inside, Esc returns), and keyboard shortcuts M (message), A (activity), L (find) and E (appearance) that never fire while typing.

### Changed

- Source-derived avatar models and their extracted hair are local-only: they load from the git-ignored `apps/web/local-assets/avatars/` folder when present, and the public build uses the self-made procedural characters (every hair style and option still works). The public-safety check rejects any `.glb`, `.gltf` or `.fbx` file in the repository, and publishing `extalia-vo` refuses a build that contains 3D model files.

### Fixed

- The Office no longer logs "Cannot update a component while rendering a different component" while character models load.
- Character bubbles sit above the name tag instead of overlapping it, and activity toasts appear centered left of the agents panel (above the prompt dock when it is shown) instead of covering the conversation's input.

## [0.2.1] - 2026-10-09

### Added

- Separate source hair into 5 male, 4 female and 3 shared independently loadable skinned GLBs; base model packs no longer include hair meshes. Tinting and head/seat poses use the same canonical skeleton.
- Group the appearance editor's real hair assets by presentation with explicit male/female/shared labels. Preserve legacy choices with clear fallback notices; generated presets select actual assets, including high ponytail.
- Provide a reproducible, Blender-free extractor and a required asset-integrity check for skeletons, buffer references, embedded images and source fingerprints.

<!-- ======================================================================= -->
<!-- Milestone 2: Workspaces & Session Hub (v0.2.x)                        -->
<!-- ======================================================================= -->

## [0.2.0] - 2026-10-09

### Added

- Start a managed agent from a prompt dock in Office when no agent is busy, with per-workspace session creation and the existing permission controls.
- Show real character activity as bottom toasts and timed speech/thought bubbles. The agent/session panel is more opaque, blurred, and collapses with a transition; the Office sidebar expands over the canvas on hover or keyboard focus without resizing it.
- Show staged loading progress until the scene and source character assets have drawn. Restore the original bundled GLB character packs, both glass elevator shafts/cabs and the exterior roof-access stairs.

### Fixed

- Permit local object-URL image textures and their fetches in Web/Desktop while keeping script evaluation restricted. Uncompressed source avatars skip unnecessary Draco/network and WebAssembly decoders.

### Validation

- All 349 tests pass. Verify Office prompt/session creation, character-specific chat and approval controls against a temporary mock provider; sidebar overlay expansion keeps canvas width unchanged. Desktop smoke exercises the source character assets, scene readiness and all three floor views.

## [0.1.8] - 2026-10-09

### Added

- Restore furnished F1, F2 and F3 rooms, their original furniture and decorations, floor/cutaway navigation and authored humanoid characters in the shared Office renderer.
- Select a character to view its session history and prompt its managed agent inside Office; worker and observed activity remains read-only according to runtime capabilities.
- Document Extalia Virtual Agent as the single development home for Office improvements, with explicit follow-up requirements for hair, clothing, accessories, gender/style presets and configurable walking animations.
- Name tags above characters (status color and session title) make agents findable and clickable at whole-floor zoom; selecting a character moves the camera to it, beside the conversation panel (instant with reduced motion).
- Character appearance: each character has an editable look with Feminine, Masculine and Neutral style presets (hair, clothing cuts including skirts and dresses, accessories, body frame and walking style) plus individual options, previewed live in the Office. Looks are saved in the agent host, so Web and Desktop share them across restarts. Presets are the user's choice; nothing is inferred from names, models or providers, and characters without a saved look get a neutral generated one.

### Fixed

- Office room, floor and corridor labels stay on one line instead of breaking after every word, and Office panels sit above the scene's labels and stay readable over the 3D view with liquid glass.
- Blazers, coats and cardigans no longer show the shirt through their back, and coats end at the seat instead of passing through the chair.
- Tests that start git or Hermes processes allow 30 s, so they no longer time out on a busy machine.

## [0.1.7] - 2026-10-09

### Fixed

- Interface fonts (Quicksand, Geist, Plus Jakarta Sans, Inter) ship with the app instead of loading from Google Fonts, which the app's Content Security Policy blocked; Extalia makes no third-party requests and the font choice works offline.
- Theme, material and font changes only animate when the value really changes, apply instantly with reduced motion or in a background tab, and no longer log unhandled "Transition was aborted" errors (the solar theme re-applied itself every minute).
- Pages no longer grow wider than the window when they contain a long project path (Files and Git cut off their right column).
- The Bridge reads and discards a slightly oversized request body before answering 413, so clients get the error instead of a reset connection (this also made a Bridge test fail intermittently).

## [0.1.6] - 2026-10-09

### Added

- Setup, Settings, Chat and Virtual Office share one Web/Desktop application. Setup enters Office, and the scene is packaged in the same build with no separate preview server.
- Reuse the existing campus geometry with gradient branding and an initial work view. Project-filtered agents are derived from real host sessions and protocol activity, including approvals, observed sessions and delegated workers; selecting an actor opens its conversation.
- Load the 3D renderer on demand with reduced-motion support and a fallback to Chat when WebGL is unavailable. Detailed interiors and advanced avatar navigation remain later milestones.

## [0.1.5] - 2026-10-09

### Added

- Hermes Agent as a managed runtime: a workspace can run the local `hermes` command instead of Extalia Native. Prompts stream into Chat with tool cards and usage, later prompts resume the same Hermes session, Stop and closing Extalia end the process, and Continue in Extalia works into Hermes workspaces. Setup offers Hermes when it is installed, without a model connection. Hermes' own approvals stay in force unless the workspace allows both file edits and commands.
- Files and Git pages (read-only): browse a workspace and view text files with line numbers; see the branch, ahead/behind, changed files and diffs. Credential files are never shown, and Git runs without a shell and with repository-defined programs (fsmonitor, hooks, filters, external diff, textconv, pagers) switched off.
- Brand assets in `docs/brand/`: light and dark logos (symbol and wordmark), the symbol in SVG and PNG, and a 1280 × 640 social preview; the README header shows the logo that matches GitHub's theme.

### Fixed

- Diagnostics recognizes commands, Git inspection and credential storage provided through the agent host, distinguishes a folder picker from registered project access, and shows unsupported development update checks accurately.
- Show registered project/session counts and a direct workspace-management action in Diagnostics; avoid opening duplicate folder dialogs while a picker is active.
- Desktop finds Hermes in the per-user install folder (`~/.local/bin`) when it was started without a shell PATH.
- README and runtime docs now describe Continue in Extalia and per-connection history.

### Validation

- Verify project-folder checks, two independent workspace session lists, explicit session selection and persistence across host restarts using temporary projects. Document browser/Bridge/Desktop requirements and the optional Python runtime boundary.

## [0.1.4] - 2026-10-09

### Changed

- Native observer polling checks file metadata and Hermes database/WAL metadata before parsing, caches source-location resolution, and coalesces overlapping polls. Unchanged sources do not rewrite snapshots or emit redundant updates.
- Defer the sample Office navigation until real scene integration; preserve the spatial contracts and source for the final milestone.

### Fixed

- Observer-only startup resolves to the Observe page after asynchronous host loading, and icon-only navigation keeps accessible labels on phones.
- Give the observer list and transcript a responsive two-column layout, preserve the local title after a rejected empty rename, and release the host lock if observer startup fails.

### Validation

- Synthetic native-source tests cover idle parse/write suppression, transcript appends and rewinds, equal-size rewrites, pause/restart/resume, source-boundary recovery, Hermes WAL updates, and rejection of managed actions on observed sessions.

## [0.1.3] - 2026-10-09

### Added

- Continue in Extalia: start a managed session from an imported or observed conversation (for example a Codex or Claude Code session that ran out of quota). The recent conversation and the original request are carried over as context, Chat marks where the earlier agent stopped, and the source is never changed.
- Connections can turn session history off. New sessions on such a connection stay in memory only, are marked "Not saved" and disappear when Extalia closes.

## [0.1.2] - 2026-10-09

### Changed

- Defer the Virtual Office 3D scene to the final integration milestone, after managed and observed agent workflows, imports, session management and desktop/web foundations.

## [0.1.1] - 2026-10-09

### Added

- Extalia Native runtime (`@extalia/runtime`): a provider-neutral agent loop with tool calling, approvals and cancellation; model providers for OpenAI-compatible endpoints (OpenAI, OpenRouter, 9Router, OmniRoute, Ollama, custom) and the Anthropic Messages API through the official SDK, with reasoning blocks replayed unchanged and server-side refusal fallbacks when talking to Anthropic directly.
- Node agent host (`@extalia/host`): workspace-bounded file and command tools, OS credential storage, persistent sessions, per-workspace memory, skills (built-in, user and project), and a single-host lock. Desktop runs it in the main process; the `extalia` command runs it behind the local Bridge.
- Connections with presets and a per-connection choice of who provides memory and skills (Extalia, the provider where it has its own, or off); OmniRoute is asked not to add its memory when Extalia's is used.
- First-run setup and progressive navigation: only pages that work in the current mode are shown.
- Chat with streaming answers, tool cards, live command output and approvals (once, for the session, or deny).
- Desktop auto-update from GitHub Releases (download in the background, restart after a short countdown when no agent is working) and packaging with electron-builder.
- npm distribution of the Web client as `extalia-vo` (`extalia` command) with update checks and `extalia update`.
- `tooling/mock-provider.mjs`, a scripted OpenAI-compatible endpoint for trying the agent without an API key.
- Orchestration, on by default: the agent can hand read-only research and review to worker agents (`delegate_task`), several at once, on per-connection Complex / Standard / Quick models (suggested: Claude Opus / Sonnet / Haiku for Anthropic, Sol / Sol / Luna for OpenAI), with a per-turn delegation limit; workers appear as `subagent.*` events.
- Nine built-in skills (plan-feature, debug-issue, code-review, write-tests, refactor-safely, security-review, commit-changes, update-docs, explain-codebase); user and project skills override them.
- Native history import (`@extalia/importers`): Codex, Claude Code, Hermes Agent (per profile, read-only SQLite) and Gemini CLI, with scan, preview and import into a local library that keeps renames, archive and trash across re-imports; Antigravity conversations are detected but not readable yet.

### Changed

- The logo mark uses the office's green gradient (#10b9ac → #83cb35 → #f8e719).
- Placeholder session views (Office, Console, Tasks, Terminal, Files, Git) are no longer shown until they are implemented.

<!-- ======================================================================= -->
<!-- Milestone 1: Public Foundation & Vertical Slice (v0.1.x)               -->
<!-- ======================================================================= -->

## [0.1.0] - 2026-10-08

### Added

- Monorepo foundation: `apps/web`, `apps/desktop`, `apps/cli`, `packages/protocol`, `packages/core`, `packages/platform`.
- Extalia Protocol v0: versioned event envelope with session, agent, task, parent and correlation ids; managed/observed session control; event families for conversation, agents and subagents, tools, commands, files, tasks, approvals, Git and meetings; strict validation and JSON Lines parsing.
- Domain core: profiles, workspaces, portable sessions (`extalia.session.v1`), session library with import preview, deduplication by source key, local organization that survives re-imports, linked-session tombstones, credential masking and export.
- Platform capability contracts, Desktop and Web hosts, and platform user-data directories.
- Web shell with English and Indonesian, light and Royal Charcoal dark themes, an optional liquid-glass surface style for both, compact sidebar, Get started, Event log, Diagnostics and Settings pages, and placeholders for upcoming session views.
- Electron Desktop shell with sandboxed renderer, `extalia://app` protocol with Content Security Policy, folder picker and a smoke test.
- `extalia` CLI with `doctor` and `validate`.
- Repository checks for dependency boundaries, public safety and lockstep versions; CI on macOS, Windows and Linux.
- Architecture documentation, ADRs 0001–0004, migration ledger, contribution, governance and security policies.
