# Office development and character roadmap

Current behavior reconciled against v0.4.288 on 2026-11-12. Dated verification
paragraphs retain their original scope; see the [module status](../modules/office.md)
for implementation boundaries and remaining acceptance.

## One application and one source of truth

Extalia Virtual Agent is the development home for the Office renderer, characters,
furniture and spatial behavior. Web and Desktop package the same React renderer.
Setup, provider configuration, Chat and the Office share one host/session index.

The earlier Virtual Office is a migration reference. Complete its furnished F1,
F2 and F3 geometry and authored avatar visuals here; do not keep two product
renderers evolving independently. New Office improvements belong in this repo.

If an outstanding improvement is made in the earlier project during migration,
review its source diff and adapt it here. Check dependencies, neutral labels,
protocol/session contracts and asset provenance before copying it. Compare the
affected room or character visually in Web and Desktop. Imported geometry is
adapted source code, not an automatically synchronized copy.

## Native standby shifts

Enabled Native teams can keep a small configured crew in the Office while no
task is running. The current lead retains its actual state and presence; only
eligible dormant team members become explicitly labelled **Standby** or **Off
shift** rows. This creates no sessions, protocol work events or model requests.
Actual work, approvals, failures, stalled/unknown outcomes and mission workers
retain their original state and take precedence.

The member floor is `min(team size, 5, 1 + ceil(team size / 8))`, excluding the
lead: teams of 10, 20 and 32 therefore target main + 3, main + 4 and main + 5.
Existing present members cover that floor before synthetic standby is added.
Across all shown workspaces there are at most five additional standby leases;
active work is never hidden to satisfy this presentation limit. Departing
characters can remain briefly visible during the physical handover.

Each lease uses the existing per-character `subagentLingerMs` duration (7–20
minutes). Expired leases yield to less recently used eligible members, while
recent real attendance also counts toward fairness. A late clock tick replaces
the expired crew once instead of replaying missed shifts. A backwards clock
does not renew leases. Empty or disabled rosters, removed members and ended
sessions retire their standby state. The latest current managed conversation
per workspace is selected before Native eligibility checks, so an ended,
disabled or switched-to-Hermes conversation cannot revive a historical crew.
Observe stays independent and receives no synthetic standby.

Only those current enabled Native teams retain idle event history, through the
existing Office hydrator. Synthetic availability waits for successful history
and roster hydration, including successfully empty histories. Failed or pending
reads cannot turn an unknown former worker into healthy standby. Availability
is gated by the current roster request signature and host/profile identity: old
display metadata retained during a failed revision refresh never certifies a
new shift. Unchanged sibling rosters can remain ready during that refresh.
Fairness is cached across Office navigation in a bounded, weak-host-owned profile/view
cache; switching profile/data source remounts the Office and cannot reuse its
previous profile's roster or movement state. Restarting the app clears this
presentation cache; attendance is not a persisted runtime schedule.

New shift members reuse the two-character admission waves below. Existing SVG
portraits remain until their bodies are admitted. Repeated rotations reuse
configured identities and saved looks; they do not invent new teammates. This
bounds extra standby attendance, not the shared asset cache or whole-app RAM.

The [32-member browser record](../bench/native-standby-qa.json) uses the
mock-only `?mock=ready&standby=32` fixture, which configures an idle team and
never starts a worker turn. Across the initial selection and two accelerated
wall-clock rotations, the lead stayed identical, five members were Standby,
27 were Off shift, and 15 distinct members took a turn. The minified
production-React QA run reported no page or console errors. Separate tests
cover sizes 10/20/32, global limits, protected outcomes, cache isolation,
hydration readiness, cancellation, roster changes and full-roster fairness.
After the final roster-readiness guard, a rebuilt snapshot also passed English
light at 1366 px and Indonesian dark at 390 px with five standby labels, 27
off-shift rows, no page/console errors and no document horizontal overflow.

## Character admission waves

The movement director admits at most two new characters per 1200 ms wave.
This is a presentation queue: Native/observed agent execution, team limits,
session state and the complete board roster do not wait for a character mesh.
An eight-character burst can therefore appear as 2–2–2–2 when independent
arrival points are clear. A shared or blocked portal can admit fewer than two.

Already-present characters hydrate in seated pairs instead of a mass walk-in.
The first pair's cooldown starts at the first render-loop tick, so shader or
loading stalls before that tick cannot place four characters in the first
frame. Live arrivals retain their floor portal, a 1200 ms same-portal interval
and at least 0.9 m of clear space around that point, including facility bodies.
Blocked heads do not prevent admissions through another clear portal. Delayed
frames skip missed waves instead of banking admissions for a catch-up burst.
Reduced motion retains batching and seats arriving characters directly.

Pending characters reserve their current desk and retain agent metadata but
have no mover, rendered body or live position. Changes to their seat, parent
and gait are reconciled before admission; cancellation removes the pending
entry. Portraits inside the Office use the same live-position admission gate:
the existing SVG illustration remains until the character is admitted, then
the normal shared 3D portrait can load. Other pages keep their normal portrait
behavior. Bubbles and quick replies do not anchor to an empty pending desk.
The last frame's admitted bodies remain fully rendered; this changes initial
construction timing, not the eventual model count or GLB size. No whole-app
memory or FPS improvement is implied without separate measurements.

The [browser QA record](../bench/office-arrival-waves.json) captures a mixed
Native/observed mock roster at 2, 4, 6, 8, 10, 12 and 13 characters, without an
observed increment above two. A minified production-React QA build shows the
same portrait-admission sequence without page or console errors. RAF snapshot
timestamps can lag admission during shader/loading stalls; deterministic tests
cover the actual cooldown, 8/32-character waves, blocked portals, cancellation,
queued reseating and delayed first frames. The portrait test proves that 32
queued identities do not request the 3D module and only admitted identities load.

## Drawing-buffer continuity

The Office keeps adaptive resolution enabled. R3F synchronously resets the
canvas drawing buffer when its logical size or DPR changes, even when rounded
pixel dimensions stay the same. Waiting for the next animation frame can expose
the transparent cleared buffer over the light stage background.

`CanvasContinuity` subscribes after R3F's resize listener and redraws the current
scene with the updated camera before the notification returns. It does not
advance the clock or movement callbacks, replace the canvas, or redraw on ordinary
host updates. Cleanup, empty/inactive canvases, lost contexts and reentrant
notifications are covered. The Office currently uses the normal framebuffer;
introducing postprocessing must preserve its output path here too.

Verification for v0.4.106 (2026-10-27): seven regression tests pass. Actual browser
probes reproduced eight buffer clears without a repaint before yielding on the
previous implementation. After the fix, all eight repaint before yielding, with
opaque output restored. An additional 32 resize events across F1–F3, Building,
day/night controls and phone/desktop viewport sizes leave no cleared frame at
the microtask checkpoint; canvas and camera identities remain stable. Independent
review found no blocking issue. Each actual resize adds one full draw; ordinary
state updates add none. GPU context loss and development reloads are separate
cases from this reproduced resize gap.

The actual production build (development controls absent) also passes 44 buffer
dimension writes across floor switches and desktop/phone/fractional resizes,
including 23 writes that retain the previous dimension. No transparent output
remains before yielding; the canvas remains the same and its context stays live.
Full `pnpm check` passes: 254 suites / 2,870 passed tests (one skipped), lint,
boundaries, public safety, schemas, workspace types, Rust checks, Web/Desktop/CLI
builds, synchronized versions and canonical hair assets.

## Conversations belong to characters' sessions

- A primary character opens and prompts its own managed session. Changing the
  selected character switches the history, composer and approval controls to
  that session ID.
- Delegated workers display their reported activity. Their instructions and
  approvals remain with the parent session until a runtime offers independent
  worker conversations.
- Observed characters display native history. Observation does not grant prompt,
  cancellation or approval control over the source app.

## Character appearance and movement

Keep appearance and animation preferences separate from model/provider identity.
Do not infer a person's gender from a name or an agent's model. A character
without saved settings gets a generated look seeded only from its presence id:
always the neutral frame and gait, with hair, outfit, skin and accessories
varied by that id.

**Appearance** in the selected character's Office panel offers three
presentation presets and individual options. A preset is a style choice; it
sets hair, garment cuts, preset accessories, body frame and walking style, and
keeps skin tone, colors, build, height, glasses, badge and headphones as the
user set them. Choosing a preset again re-applies it.

| Preset | Hair (picked by character id) | Clothing | Accessories | Frame and gait |
| --- | --- | --- | --- | --- |
| Feminine | long, long wavy, ponytail, bun, bob | blouse (fitted, scoop neck), skirt; dress available | stud earrings, classic watch, tote | narrower shoulders, wider hips, 3% shorter; shorter stride, more hip sway |
| Masculine | side part, short fade, textured crop, undercut, slicked back | shirt, trousers, executive blazer | tie, classic watch, briefcase | broader shoulders, narrower hips, 2% taller; longer stride, more arm swing |
| Neutral | medium layered, curly, afro, bob, textured crop | knit top, trousers, creative cardigan | smartwatch, messenger bag | neutral proportions and gait |

Every option stays editable on its own: hair style (13) and color, skin tone,
top (shirt, blouse, knit, turtleneck), bottom (trousers, skirt, dress), outfit
layer, top and bottom colors, build, height, glasses, watch, earrings, bag, tie,
ID badge, headphones and walking style. Changes preview live on the character;
Save stores them in the agent host (`characterAppearances`,
`saveCharacterAppearance`), so Web and Desktop show the same look and it
survives restarts. The host validates strictly (known values only, `#rrggbb`
colors, 145–195 cm, at most 500 characters, unknown fields rejected), keeps a
damaged `state/character-appearances.json` aside, and drops looks of deleted
sessions when listing.

| Area | Status |
| --- | --- |
| Hair | Shipped: distinct preset cuts plus explicit choice of every style |
| Clothing | Shipped: shirt, blouse, knit, turtleneck; trousers, skirt, dress; outfit layers and colors |
| Accessories | Shipped: glasses, watches, earrings, bags, tie, badge, headphones; bags are carried standing and set beside the seat |
| Movement | Shipped (MVP): gait parameters drive the idle weight shift, seated sway and the walk cycle (stride, cadence, arm swing, hip sway and roll; speed = stride × cadence). New presences walk in from the entrance (a worker from beside its lead), sit down at their desk; removed presences stand up and walk out (a worker back to its lead). Routes follow an authored waypoint graph with A* through doorways, the indoor stair lanes and both glass elevators. Reduced motion places and removes characters at their seats. Natural curve/lane variation, short-horizon passing and crowd recovery now supplement authored graph routes; portal/contact controllers retain exact constraints |
| Consistency | Seated poses follow each resource’s cushion height and front edge; idle, typing and walking share the procedural fallback and registered source-model characters, with sit/stand blending |
| Preferences | Shipped: stored per character in the host and shared by Web and Desktop; reduced motion stops idle sway |

Extend the shared character implementation here so both Web and Desktop
receive each improvement together.

### Character models and assets

The public build includes licensed Blender-retargeted body/hair models and fitted
wardrobe pieces registered in `apps/web/public-assets/models.json`. Source URL
selection prefers these public assets; procedural characters remain fallbacks
for unavailable or failed source loading. Unknown local files are excluded from
ordinary production builds. Explicit `--mode local-assets` development can add
private fallback models, but is not a public packaging mode.

The current inventory contains 133 GLBs totaling 152,104,948 bytes (about 145 MiB
before compression), including furniture, architecture, avatars, vehicles and
greenery. These are asset bytes, not startup or runtime memory measurements.
The [public inventory](../../apps/web/public-assets/README.md) and notices retain
per-component licenses. Project-authored MIT scene models and separately licensed
avatar exports follow different provenance; a free download alone never proves
redistribution permission. Newly distributed models require reviewed license
records, hashes and the existing public asset validation.

### Avatar spawn and loading

`CharacterBody` separates source loading from source failure. When the selected
source body/hair URLs exist, its Suspense boundary waits without a procedural body placeholder;
`SourceAvatarBoundary` still renders the procedural fallback on a failed load.
Missing source URLs select that fallback immediately. The selected body/hair
preloads start together and use the renderer's separate URL cache entries, so
hairstyles can share a body and warm spawns need no repeat asset request. Keep
per-instance skeleton/material cloning and live motion state independent.
Do not preload the complete optional source library to hide loading delays.

A matching lightweight LOD would need the detailed model's proportions, rig and
appearance. This update adds no LOD/model assets and claims no memory/FPS savings;
it fixes the visible style switch and the body-then-hair request waterfall.

### Seat dimensions and body contact

Furniture uses metres. `furnitureSeatBlueprint.ts` owns chair and upholstered
cushion dimensions; rendered meshes and `resourceRegistry.ts` must agree.
`seatHeight` is the cushion top. `seatFront` is its forward edge measured from
the avatar root, after the chair-local sitting offset. Forward both through
`SeatApproach`, moving occupants/staff and both character renderers. Do not
replace them with one hard-coded seated height.

`seatedPose.ts` keeps the thigh supported until the cushion’s front (allowing
8 mm of soft compression), including leisure-clip offsets. Calf flexion keeps
shoes above the floor; feet plant when limb lengths permit. Short or stylized
legs may hang instead of stretching the skeleton or passing through a cushion.
Source poses measure the rest skeleton and remove authored segment tilts;
walking retains its original rig. This is bounded pose/contact logic, not a
full mesh collision or cloth simulation.

Office/meeting/guest cushions sit at 46 cm, sofas at 43 cm and armchairs at
45 cm. Barstools retain their elevated profile. Office arm pads top out at
71 cm, below the 78.5 cm workstation surface. Update chair choreography contact
targets with the same blueprint whenever changing chair geometry. Keep moving
chairs independent even when their immutable mesh resources are instanced.

### Desk device dimensions and placement

`props/deviceGeometry.ts` owns physical monitor/laptop dimensions in metres.
`Monitor.position` is the **bottom of its stand**, and `Laptop.position` is the
**bottom of its deck**, on the supporting surface. Do not pass a panel-centre Y.
All direct callers use this contract, including reception and touchdown desks.
The single desk supports devices at 78.5 cm; pod bevel caps at 80.2 cm; executive
screens rest on the leather blotter at 84.55 cm. Reception's shared rear shelf
is at 76 cm and clears the solid counter body.

Monitor glass is 50–58 cm wide, 16:9, with a 2.5 cm total bezel allowance and
10.5 cm clearance under the housing. The single all-in-one glass is 56 × 31.5 cm;
its housing top is 123 cm above the floor. The laptop chassis is 36 × 25 cm,
1.8 cm thick; its 33.2 × 18.675 cm screen sits inside a tilted lid whose lower
edge meets the hinge. Glow pools use the same physical frames. Keep authored
screen slots/content, texture/detail policies and avatar hand targets independent
of device dimensions. These are fixed workstation proportions, not automatic
monitor adjustment for every avatar height or arbitrary device collision.

## Daylight, night and the Office lights

With the **Solar** app theme the Office follows the real sun; with Light, Dark or
System it shows day or night to match the interface. The sun is computed on the
device (NOAA formulas in `apps/web/src/environment/solarMath.ts`): there is no
location prompt and no network request. The device's IANA time zone picks the
point the sun is computed for (`environment/deviceLocation.ts`): the zone's
namesake city from a built-in table (`Asia/Jakarta` keeps the project's WIB
reference point, 5.55° N 95.32° E); any other zone uses longitude 15° × its
standard UTC offset and a typical latitude for its region. The Solar theme's
light/dark switch uses the same point, so the interface and the scene agree on
sunset. The campus has no real bearing: its entrance faces the midday sun in
both hemispheres and the sun sets on the right-hand side of the default view.

Sky, fog, hemisphere, ambient and the single shadowed sun/moon key light are
interpolated by sun elevation between dawn/dusk-aware profiles
(`office/scene/environment/lightingProfiles.ts`) and ease over about a second,
so dawn and dusk never jump. Nights are deliberately dark: a faint moonlit fill
keeps silhouettes legible, and surfaces are lit by fixtures that exist in the
scene. Path lamps, bollards, tree uplights, facade downlights, the entrance
canopy and the arrival-road street lights bake their beams into the shared
fixture irradiance volume (real pools, no painted light planes) and switch on
with the site photocell (`exteriorLightFactor`, from +4° to -4°).

The **lights** control in the Office toolbar (Auto / On / Off, remembered per
device) overrides the interior only. Auto switches the lights on after dusk
(`lightsOn`) and keeps fixtures daylight-dimmed during the day
(`interiorLightFactor` 0.3); Off leaves only exit signs, screens and the site
lighting outside. Lit windows follow the interior lights.

An adaptive render budget (`office/scene/environment/renderBudget.ts`) pursues 60 FPS without imposing a frame-rate ceiling. Each application load begins with a 1080-pixel physical short-edge ceiling; the five levels cover 720, 900, 1080, 1440 and 2160 pixels. These are resolution ceilings, not fixed 16:9 canvases: the Office keeps its actual aspect ratio. DPR never exceeds the display's native ratio or 2, and total pixels stay within 3840 × 2160 even on ultrawide displays. Resizing or changing display density recalculates the physical drawing buffer; DOM text and controls stay native-sharp.

After a three-second warm-up, three stable slow windows permit a lower-resolution trial. Three warmed candidate windows must demonstrate at least 10% and 2 ms improvement before that reduction is retained. Otherwise the confirmed resolution returns and reductions wait 60 foreground windows. Near-60 throughput and periodic restoration trials allow a sharper image, including in CPU-bound views below 60 FPS. Composition, camera, visibility and context changes invalidate unproven comparisons. Each change settles briefly; hidden time never advances a trial. The effective budget FPS never exceeds either raw or filtered throughput.

Remounting the scene in the same application keeps the settled tier and resumes adaptation. Resolution trials hold lights, shadows, traffic and geometry detail constant; baked light pools remain present. This responds to render throughput, not network speed, and cannot guarantee 60 FPS when geometry or CPU work is the bottleneck. GLB downloads, decoded geometry and avatar portrait canvases are not reduced by DPR. See [the resource guide](../bench/office-adaptive.md).

Development builds expose `__EXTALIA_SOLAR_PREVIEW__(minutes | null)`,
`__EXTALIA_ENV_STATE__()`, `__EXTALIA_RENDER_BUDGET__` and
`__EXTALIA_SET_RENDER_BUDGET__(level | null)` for visual QA.


## Reference-led campus envelope

The campus skin uses six visual courses around the three existing 6.4 m levels;
these are facade divisions, not six navigable floors. `facadeElevation.ts`
authors silver front frames with real horizontal window holes and shared
boundary points for diagonal junctions. `CampusBuildingShell.tsx` joins them to
the rounded side/rear sweeps, recesses the front glazing and opens the glass
corner. The original interior, roof setback and circulation layout remain the
source of truth. The shell stays confined to campus view.

Frame, trim, light and glass surfaces are merged; mullions are instanced. The
512 × 256 diamond cladding texture is reused for color and subtle bump. Alpha
glass avoids an additional transmission render. Dynamic cladding and glazing
materials keep their source references during static batching so solar changes
remain visible. Cool low-intensity cladding emission is an artistic night fill;
accent edges are emissive geometry, with no additional shadow lights.

Tests cover perforated frames, finite indexed assembly, shared diagonal joints,
and entrance/lift/emergency/terrace openings in the mirrored world transform.
These envelope raycasts do not certify unrelated fixtures or navigation physics.
No memory, FPS or transparent-overdraw improvement has been benchmarked.

### Reviewed Blender building parts

`tooling/blender/export-building-shell.py` refreshes five optional local assets
under `apps/web/local-assets/building/`: shell, roof utilities, maintenance
stair, elevator statics and terrace guard. The source scene defaults to `Scene`
(`EXTALIA_BUILDING_SCENE` overrides it). The exporter creates temporary copies,
keeps material role metadata, excludes preview scenes/lights/cameras/actions
and resets the eight named rotor transforms without saving the authoring file.
All parts finish exporting before publication; `building-manifest.json` records
the source revision and object membership. This is not a multi-file atomic
transaction. Preserve a local asset backup when refreshing a working scene.

The reviewed facade uses neutral linear RGB(0.16,0.22,0.27), alpha0.42; elevator
shaft alpha0.14 and balustrade alpha0.18 use the same tint. Closed12mm panes are
single-sided to avoid rendering both faces of each pane. `campusModels.tsx`
preserves authored roles, colors, alpha and culling; only facade glass takes
the app's night window glow. Alpha is a rendering parameter, not measured
physical transmittance. Day/night control remains with `SceneEnvironment`.

The app retains the original neon lettering, animated elevator cabs and doors,
eight independent fan motors, entrance/terrace doors, and maintenance gates.
Model-ready switches replace static geometry only. The model stair's lower
gate is at[-20.72,12.8,14.1], rooftop gate[-21.35,19.33,6.2]; its five fixtures
remount when the selected layout changes so their irradiance follows the new
flight. Floors1/2 unmount these gates/fixtures. Missing/failed local assets and
`?building=threejs` retain the procedural fallback.

## Initial Building camera and ground coverage

The Building preset now looks down from the north-west at approximately 22
degrees, framing the roof, entrance plaza and foreground in the usable canvas.
A Building zoom-out boundary must satisfy two conditions: viewport corner rays
meet the ground inside the finite city disc, and those intersections lie in
front of the orthographic near plane. Checking only the disc can accept a view
whose lower rays start below ground, leaving a flat background strip.

The boundary derives from the current camera position, target and stage size,
so manual orbit, pan and zoom retain their controls. Floor framing and character
follow retain their existing behavior. A regression uses the former shallow
zoomed-out pose, checks its clipped lower rays, and verifies that the new bound
puts every ground intersection inside both the city and the camera frustum.

Local visual verification mounted the real OfficeCanvas with no agent sessions,
at 1440×960 and 390×844. The stage and canvas bounds matched, and all four
viewport-corner ground intersections projected inside the near/far clip planes
and city rim after fresh load. Light and dark scene captures retained rendered
foreground to the bottom. Thirty-two focused camera/framing tests passed; the
temporary browser entry point was removed before the repository gate.

Final v0.4.208 validation: `VITEST_MAX_WORKERS=2 pnpm check` passed with
6,632 TypeScript tests (23 optional skipped), 474 Rust tests, lint, typechecks,
all builds, version consistency and hair-asset checks. The first full run hit
two Hermes event-wait deadlines during concurrent checks; all 14 Hermes tests
passed separately, followed by the complete bounded gate without changing
those tests. No real profile/configuration edits, commit or publication.

## Executive room cabinetry and decor

F2 Executive and F3 CEO Studio now derive the rear cabinet anchor from the west
feature panel rather than a fixed distance behind the desk. The cabinet's rear
cap sits 20 mm in front of the panel ribs, providing an installation/shadow gap
without a freestanding strip of floor behind it. The renderer and navigation
footprint consume the same cabinet position, rotated envelope and offset.

Two wall sconces occupy the exposed panel ends. One reading lamp serves the
lounge, while three modest planters flank the cabinet and lounge window clear
of the central arrival lane. The task lamp uses the shared executive desktop
height. Seat transforms and chair approaches remain unchanged.

An isolated preview mounted the real RoomShell/ExecutiveRoomInterior and app
structural floor plate for each room. The support plate stayed on a hidden
render layer to isolate the room visually while retaining its actual collision
geometry. Precise rendered cabinet bounds measured a 20 mm rear gap on both
floors; WalkingClearance approved all 16 seat staging capsules and both 7 m
central aisle segments. Light/dark and 390 px captures were checked. Eight new
layout/wiring checks plus 20 planter/workstation/clearance cases passed; a
bounded independent read-only review found no substantive issue.

Final v0.4.210 validation: `VITEST_MAX_WORKERS=2 pnpm check` passed with
6,716 TypeScript tests (23 optional skipped), 474 Rust tests, lint, typechecks,
all builds, version consistency and asset checks. The first full run hit an
unrelated Codex proxy disconnect case; its isolated rerun and the complete
retry passed without changing transport code. No real profile/configuration
edits, commit or publication.

## Six-pod Large Team Workspace

The 32×19.6 m F1 engineering workspace now contains six four-seat pods in three
columns and two rows. Existing pod-a through pod-d resource IDs are retained;
pod-e and pod-f add eight allocatable workstations. Pod capacity is 24 seats,
and total F1 agent seating is 32. Both language labels derive from the current
pod/station data instead of a fixed capacity string.

The central east–west aisle stays open. North–south routes turn through the
spaces between columns rather than through the middle pods. All pods share
row-based staging rules, and relocated east breakout chairs have an in-room
approach via the south perimeter lane. Six suspended halos follow the pod
centres; sixteen ceiling troffers occupy aisle/perimeter columns. Relocated
perimeter lounges, rugs, reading lamps and modest plant accents balance the
room without occupying its work or doorway lanes.

Focused validation passed 60 tests covering real seat allocation/identity,
desktop/input contact, circulation, furniture-derived bounds and all 658
sampled leisure routes through door choreography. The actual
Floor1 component in an isolated browser preview produced 2,434 walking
colliders: all 24 pod staging capsules and every in-room lobby-to-pod route
leg were clear at a 0.28 m body radius; exactly six halos were present. English
and Indonesian 6/24 labels, light/dark captures and 390 px page bounds were
checked. Independent implementation/review found no blocking issue. No real
profile or external application configuration was changed. Workspace lint,
typechecks, daemon build, Rust checks, production builds and version/hair
consistency checks also passed; the PRD tracker records the remaining unrelated
installer-artwork and Memory-import failures from the full test gate.

### Pod departure clearance

Team pod structures publish the same concave outline used to author their
tabletop, transformed into world space for capsule clearance. A square mesh
bounding box filled the empty corner bays: all 24 rendered pod departures
could stop at the chair grip point and exhaust the recovery budget. The
footprint uses an AABB broad phase followed by segment/interior and boundary
distance checks. It conservatively covers the legs, frames and dividers;
separate devices and neighboring furniture retain their own collisions.

Screen-location mapping now validates every pod against the resource registry.
The former A–D pattern left E/F screens unmapped and rendered their chairs as
static objects. All 24 chairs now use the shared movable-chair registry.
Regression checks exercise arrivals and departures for every seat, occupied
screen/resource mapping, transformed upper-floor outlines and nearby blockers.
All 78 focused tests passed. In the actual rendered scene all 24 departures
complete with both authored and procedural structures; 24 concurrent occupants
changing desks all finish seated after 53.64 simulated seconds. All 24 pod
chairs are registered as movable. Independent read-only review found no
blocking issue. The temporary preview and its browser/server were removed.
Full `VITEST_MAX_WORKERS=2 pnpm check` passed at v0.4.218: 7,059 TypeScript
tests, 25 optional tests skipped, 474 Rust tests, all builds and version/asset
checks. The initial installer-artwork and Memory-import blockers recorded
above are resolved in this integrated validation.
