# Office development and character roadmap

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
| Movement | Shipped (MVP): gait parameters drive the idle weight shift, seated sway and the walk cycle (stride, cadence, arm swing, hip sway and roll; speed = stride × cadence). New presences walk in from the entrance (a worker from beside its lead), sit down at their desk; removed presences stand up and walk out (a worker back to its lead). Routes follow an authored waypoint graph with A* through doorways, the indoor stair lanes and both glass elevators. Reduced motion places and removes characters at their seats. No collision avoidance between walkers yet |
| Consistency | Seated poses follow each resource’s cushion height and front edge; idle, typing and walking share the procedural and local source-model characters, with sit/stand blending |
| Preferences | Shipped: stored per character in the host and shared by Web and Desktop; reduced motion stops idle sway |

Extend the shared character implementation here so both Web and Desktop
receive each improvement together.

### Character models and assets

The public build draws every character procedurally; this is the supported
default and what CI exercises. Source-derived GLB models are local-only: put them
in the git-ignored `apps/web/local-assets/avatars/` folder (layout in
`apps/web/src/office/scene/avatars/README.md`) and they replace the procedural
character on that machine. Without the folder, builds, tests and `pnpm check`
still pass. `pnpm lint` rejects any tracked, staged or non-ignored `.glb`,
`.gltf` or `.fbx` file. A third-party model needs a license that allows
redistribution before it can be committed, together with its attribution and
license text.

### Avatar spawn and loading

`CharacterBody` separates source loading from source failure. When both local
URLs exist, its Suspense boundary waits without a procedural body placeholder;
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

An adaptive render budget (`office/scene/environment/renderBudget.ts`) keeps the
scene above 40 fps: after two slow two-second windows it lowers the pixel ratio,
then the shadow refresh rate, and finally the live fixture beams and shadow map
size; it steps back up after sustained headroom. Baked light pools are never
reduced. Development builds expose `__EXTALIA_SOLAR_PREVIEW__(minutes | null)`,
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
