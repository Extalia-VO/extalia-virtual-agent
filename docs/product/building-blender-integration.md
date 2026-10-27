# Reviewed building integration — v0.0.67

The local application now uses the `consistent-glass-14` Blender review. This
refreshes all five optional GLBs, including the latest west ribbons, side-door
portal and open front-left glazing. New shell membership also includes the
rooftop logo supports and entrance reveals. Models stay in ignored local assets;
the source review file is external and was not saved/modified by export.

## Ownership

- Blender owns the skin, glazing, canopy, logo plinth, static elevator frames,
  terrace guard, maintenance flight/landings, rooftop equipment and fan meshes.
- The application owns the original neon lettering/halo/spill, elevator cabs,
  landing/cab doors, entrance/terrace/side doors, fan motor timelines and
  solar-controlled lights. No preview camera, light or animation is imported.
- Maintenance gates use the existing traffic-driven interior `OpenDoor`.
  Model lower gate [-20.72,12.8,14.1], roof gate [-21.35,19.33,6.2], width 1.2 m.
  Five fixtures follow the selected flight. Layout changes remount those
  fixtures so baked illumination follows; floors1/2 remove their registrations.
  This does not add a new autonomous rooftop navigation route.
- The roof neon retains its original glyphs/materials and sits on the model
  plinth at [-10.7,21.35,-19.12]. Its procedural supports step aside with the
  model; its lighting remains app-owned.

## Glass and export

Three material roles preserve authored linear RGB (0.16,0.22,0.27), alpha and
single-sided culling: facade 0.42, shaft 0.14, guard 0.18. Only facade panes receive
interior window glow. Shaft visibility comes from cab/landing illumination.
Materials are shared per loaded source material, including disposal ownership.

The exporter uses an isolated temporary scene and copied objects/meshes/materials,
retains exact rotor names and pivots, clears preview actions and resets rotor
rotations to zero. The eight rotors share one exported mesh with its thin axis
along local Y. Five pending files finish before publication; the manifest is
written last. Publication is not an atomic multi-file filesystem transaction.
A locally retained pre-refresh asset backup supports manual asset rollback.

## Verification

- `pnpm check`: exit 0, 171 suites/1,599 tests; lint, types, tests, Web/Desktop/CLI
  builds, versions and local hair validation passed at 0.0.67.
- Desktop smoke: exit 0, scene ready, no model errors, all three floor views;
  isolated temporary Desktop/data profile. Web and Desktop use the same build.
- Actual loaded GLBs: 5 model roots; no exported animations/cameras/lights;
  all 3 role extras/colors/alpha/culling preserved. Exact 8 rotor names reference
  one mesh and use the expected runtimeY-axis.
- Actual browser imported meshes: 40 access rays clear (front, side, terrace,
  roof and both elevator approaches), 78 gate leaf sweep samples have no static
  mesh conflict;3 positive ray controls hit retained geometry.
- Runtime mock ride: boarding succeeded; cab moved fromY 2.30685 toY 6.4075;
  both traffic-driven gates opened to 1. Eight independently controlled rotors
  retained one geometry; 6 changed angle during a 2 second sample, others were
  allowed to rest under existing thermostat logic.
- Day/night material inspection: facade alpha 0.42, night emission 0.16;
  shaft 0.14 and guard 0.18 retain zero emission. Day/night browser images and
  Desktop screenshots are local artifacts under `output/playwright/`.

Existing development-only React synchronous-unmount warnings occur during scene
loading; no model-load error occurred. No FPS/memory/physical-transmittance claim.
Glass alpha and light appearance may still differ across views and overlapping
panes. Door sweep sampling is scoped mesh QA, not a whole-building collision
certification. The runtime fallback remains available without local model files
or with `?building=threejs`.

Codex implemented/exported/integrated; GPT-6.1 Sol implemented material/stair
ownership and reviewed export; GPT-6 Luna audited runtime/handoff alignment.
Hermes model discovery failed before launching a worker because its Python
router environment was unavailable; no external run/session or partial writes
occurred. Review continued locally under the configured Codex fallback. No
worker token usage or measured savings were reported.


## Terrace guard cleanup — v0.0.68

The initial integration hid the procedural rail components after model readiness,
but their geometry had already been copied into the floor-wide static batch.
That copy survived component unmounting. The replaceable guard now has an
`officeDynamic` isolation boundary and its own `StaticCampusBatch`; removing it
also disposes its merged buffers. Other terrace furniture and glazing remain.

A regression test exercises actual Three.js batch construction and cleanup.
Controlled browser loading holds the terrace GLB request: four rear-guard probes
initially hit the fallback's alpha0.23 glass; after release they hit only the
Blender alpha0.18 balustrade and the fallback subtree is absent. Full
`pnpm check` passed at0.0.68:172 suites/1,600 tests. No asset re-export required.


## Interior perimeter ownership — v0.0.69

Whole-building `campus` view uses the exterior skin for the perimeter. RoomShell
faces are classified against the actual room registry and building planes;
F3 uses the terrace setback atZ13. Only matching walls, windows, frames, sills,
skirting and caps hide. Corridor-facing windows and internal room boundaries
remain. Custom lobby north/west and engineering west windows, plus the terrace
entry partition, use the same ownership boundary. Moving entrance, terrace and
room doors stay outside it. Furniture, floor finishes, lights and ceiling
content are retained.

`ExteriorEnvelopeProvider` controls visibility; each exterior `EnvelopeWall`
is isolated from the floor-wide static batch and owns its own batch. Campus
hides29 groups. F1/F2/F3 restore10/10/9 visible perimeter groups; All floors
restores29 because it is a cutaway without the campus skin. Returning to Building
hides29 again. Internal sides remain in their original floor-wide batches.

Browser probes confirm the internal Meeting A window remains while the old
exterior Executive window disappears in campus mode. Both reappear in F2 and
All floors as appropriate; the lobby and terrace door portal registrations
remain. Daylight screenshot:output/playwright/v069-clean-envelope.png. Focused
tests cover real batch visibility, all five view modes, geometric classification
and keeping doors/furnishings out of suppressed surfaces. Full `pnpm check`
passed at0.0.69:174 suites/1,609 tests. An initial run during concurrent preview
rendering hit unrelated host fixture timeouts; it passed unchanged after closing
old previews. No Blender asset re-export or navigation-route change.

Codex implemented view context/custom floor coverage and visual QA; GPT-6.1 Sol
implemented RoomShell classification/ownership and tests; GPT-6 Luna audited
perimeter coverage and preservation of internal walls. No measured performance
or worker token savings are claimed.

Desktop smoke at0.0.69 also passed with scene ready, zero model errors and all
three floor views. The Desktop F2 capture was reviewed with its perimeter walls
restored; the campus browser capture shows the cleaned envelope. Screenshots
remain local under output/playwright/v069-desktop/.


## Rounded floor footprint — v0.0.70

The reviewed glazing has 1.88 m corner radii around X -19.15/23.15, front
Z -17.205 and rear Z 17.15 (lower) or 11.15 (upper body). Campus floor geometry
is clipped to an inscribed 1.78 m radius, sixteen segments per quarter, leaving
10 cm nominal clearance behind the glass. This changes actual slab/finish
geometry, not visibility or a visual clipping plane. Original rectangle-local
UV density is retained, with closed slab caps and sharp edge normals.

Coverage includes the F1 base slab, F2/F3 slab strips, room and circulation
finishes, floor border strips, ceiling soffits and their reveals. Nested
finishes pass their room's building coordinates. Indoor F3 finishes/ceilings
use the setback; the F3 slab and terrace deck retain the lower profile to Z 19.
Existing stair voids remain separate slab patches. Only affected perimeter
patches leave the floor-wide immutable batch; each owns a mode-keyed batch
to avoid stale square copies. Original rectangles return in standalone floor
and All floors views. No Blender re-export or navigation-layout edit.

Browser geometry checks found 254 perimeter patches and 8,196 rendered vertices
inside their expected rounded footprint (20 micrometre tolerance), both before
and after Building→F1→F2→F3→All floors→Building. Standalone views restored the
rectangular geometry. Daylight overview reviewed at
output/playwright/v070-rounded-floors.png. The pre-existing portrait-root
unmount warnings still occur on Office entry; no model-loading failure occurred.

Codex integrated floor/ceiling patches and browser verification. GPT-6.1 Sol
implemented and tested the pure clipping/prism geometry. The earlier Luna audit
identified square slab/finish/ceiling sources; its additional review failed
before producing changes, so Codex performed local verification. No measured
performance or worker-token savings are claimed.

Full `pnpm check` passed at 0.0.70: 176 suites / 1,620 tests. Browser
ray probes also confirm the F2/F3 stair voids stay clear and both rear decks
remain present at Z17.5.

Desktop smoke passed at 0.0.70: scene ready, zero model errors, all three floor
views and diagnostics clear. The F3 Desktop capture was reviewed with its full
terrace and stair opening intact. The initial campus smoke screenshot captures
the loading screen; the browser overview above provides the finished campus
render. Smoke stderr includes existing file-not-found messages while the
structured result reports no model errors. Screenshots remain local under
output/playwright/v070-desktop/.

## Outdoor campus refresh (v0.4.107)

The local Blender source scripts now generate coordinated outdoor and mobility
libraries. `create-exterior-assets.py` exports 31 named roots (78,856 triangles,
about 3.8 MB): trees, flowering beds, fern/agave groups, bent grass blades, benches,
lights, a café, bicycle fixtures, pond and pergola. Background crowns use a
156-triangle shared mesh rather than the richer close-up shrub; sparse 12-triangle
grass tufts appear only at useful projected size. Foreground planting reserves
both the arrival corridor and the west parking footprint.

`create-campus-mobility.py` exports eight distinct vehicle forms—sedan, SUV,
Jeep-style off-road, MPV, hatchback, single-cab truck, double-cab pickup and EV—plus
charger and solar cycle shelter. The actual 14,280-triangle / 1.21 MB library
uses at most twenty body/lamp instance batches. All eight vehicle styles appear
in parking. Cars fit the 5.5 m bays (actual maximum footprint 5.106 by 2.11 m);
three EV bays have separate chargers, pedestrian access stays outside the drive
lane, and the canopy covers the existing bicycle rack. Four sparse, separated
through-lanes pause at the arrival crosswalk. This is ambient traffic; characters
currently stay on campus paths and do not cross active vehicle lanes. Moving
vehicles stop while the scene is hidden and disappear under reduced motion.
Their photocell lamps preserve red tail lamps; charger/shelter lighting also
responds to manual controls. There are no individual vehicle lights or shadows.

`create-district-buildings.py` adds 461 physical mullions, 470 transoms and twelve
recessed glazed lobbies to the nearby shells. The local district remains four
merged role draws and 32,168 triangles. Distant skyline silhouettes remain cheap;
existing time-driven window shaders and night crowns remain live. The editable
Blender files and GLBs stay in ignored `apps/web/local-assets/landscape/`; all
libraries have complete procedural backups if their binary cannot load.

Outdoor furniture and navigation now import one canonical blueprint rather than
two diverging copies. All thirty resource points—28 seats, café pickup and garden
art viewing—connect to perimeter paths. Wider picnic/patio spacing and narrow
structural proxies keep actual tables, poles and planter cores solid without
turning an entire merged canopy into a wall. Four forecourt poles sit off the
transverse planter-access route. Actual Blender geometry tests and the mounted
browser scene both complete all thirty arrival/interaction/departure cycles;
the browser reports no blocked route edges. Café preparation starts only after
physical arrival, has one reserved pickup point, and leads to a free outdoor
seat for sipping. Real work, removal, reduced motion and disposal cancel visits
and release state. The ready cup and indicator read the same scene-local order.

Repeated opaque loaded models share instances after transforms are updated.
Transparent, skinned, mirrored and custom-callback meshes retain their own draw
path. Collision originals remain available; material/geometry changes restore
normal rendering immediately. Static instance buffers stay clean, hidden floors
stop their batches, and removal restores owned flags without disposing shared
assets. Unreadable screens below 18 CSS pixels pause live repainting, preserving
the latest image, initial/content-change paints, and independent photometry.
Loaded static chairs and team pods opt in too; identical pairs can share a batch.
The stationary shell, elevator frames, roof stair and terrace also merge compatible
opaque geometry after loading. Live glass/accent materials remain separate and
moving roof-fan assemblies retain their own transforms. Actual GLB regression
tests verify preserved triangles, material references, nighttime response and
source ownership through batch cleanup.
Compact portraits (all visible targets at most 64 CSS pixels) display at 10 FPS;
a larger target retains 15 FPS. Initial/changed portraits render promptly and
actual elapsed pose time is retained. The displayed identity, mesh, expressions
and reduced-motion behavior remain the same.

Verification includes actual Blender previews and GLB silhouette/bounds/contact
checks, exclusive/cancelled kiosk visits, all exterior routes, source/fallback
geometry and lighting, and independent read-only review. Final `pnpm check`
passes on v0.4.107: 261 test files, 2,913 passing tests and one skipped test,
plus lint, boundaries, public safety, TypeScript, Rust checks and all builds.
The compiled UI passes light/dark and 390-pixel viewport checks without horizontal
overflow. Forcing all three outdoor libraries to their procedural backups reaches
the ready scene without page errors or WebGL context loss.

Performance remains a follow-up, rather than an achieved acceptance criterion.
The optimized browser build was measured at a 1440 by 900 viewport on an M3 Max,
using the same render path as production and local mock host data. A ten-second
day sample averaged 44.0 FPS. Night samples varied: the final ten-second sample
reached 41.4 FPS, but a subsequent thirty-second sample averaged 34.1 FPS at
0.7 DPR (937 by 535 drawing buffer). Other local applications were running;
these measurements do not establish an isolated hardware ceiling or sustained
40-FPS acceptance. Additional 0.6/0.5 DPR trials did not consistently improve
throughput and were removed to preserve clarity. Transform work on hidden
original model meshes is a measured remaining CPU candidate; any future caching
must preserve moving parents, live local transforms and collision originals.

## Interior architecture and lighting (v0.4.108)

`create-architecture-library.py` exports eight contract-sized modules: glass
panels/transoms, plaster wall, hinged frame, glass/wood leaves, sliding frame and
sliding leaf. Blender 5.1.2 generated 9,076 triangles in thirty material groups.
`create-stair-library.py` exports six modules (tread, stringer, landing, handrail,
shoe and clamp), 6,424 triangles in sixteen material groups. Editable sources,
GLBs and manifests stay in ignored `local-assets/architecture/`. Both generators
support inspection previews and keep application contact origins in their GLBs.

The application owns door motion, pivots, handle contacts, portal identity and
stair routes. Right-hinged frames mirror their jamb fittings. Sliding tracks now
span both leaves at full travel. Room entries and the engineering doors use their
real 2.55 m opening height, avoiding the former 0.4 m transom overlap. Model loads
refresh their nearest static batch through a stable context notification; nested
owners cannot absorb each other's generated geometry. Fixed parts can batch,
moving door ancestors remain excluded, and failed/absent assets retain the full
procedural structures. Equal glass/paint variants share reference-counted
materials; closed glass boxes retain front-face rendering and no depth writes.

All 72 tread strips remain live application emitters. Three low-power cached
samples under each strip add warm spill toward the next lower tread/riser (216
samples across both staircases), without adding meshes or GPU spotlights. Glass,
risers, handrail LEDs and the existing nineteen fixtures per staircase remain
application owned. Day fill is retained; night Off sets the tread emission and
spill to zero. Browser inspection confirms all 72 strips light in Auto at night
and extinguish with night Off.

Parked vehicles have zero per-instance emission while retaining their lens
colours. Moving vehicles share four short headlights, each with a 9 m range and
no shadows; hidden/reduced-motion traffic extinguishes its beams. Six perimeter
parking poles use two geometry draws and six cached ground pools. Light Off no
longer changes daylight sky, sun, ambient light or daytime fill; solar twilight
blends the night treatment gradually instead of replacing daylight with a dark
profile.

Direct character/card inspection and modal open/close preserve manual camera
state. Board rows and character shortcuts locate avatars, as clarified in
v0.4.109; Find and Follow remain explicit requests. Floor and All floors
overviews fit the usable viewport; Building keeps its desktop default and limits
outward zoom against the shared 250 m ground disc. Narrow viewports receive only
the minimum safety zoom needed to keep the rim outside view. Deliberate panning
outside the backdrop is not a new supported region and does not snap inward.

Verification: actual Blender previews/GLB bounds, opening rays, handle contacts,
all stair contact heights, lighting caches, shader instance masks, material
ownership, nested batch replacement, camera requests and user popup round-trips.
The browser retains exact manual pose/zoom 80 through the session modal; explicit
Find changes the pose as intended. Day Auto/Off natural light and sky match
exactly. Full `pnpm check` passes: 272 suites, 2,974 tests passed, one skipped,
plus TypeScript, lint/boundaries/public safety, Rust and Web/Desktop/CLI builds.
The separate sustained outdoor FPS acceptance above remains open.
