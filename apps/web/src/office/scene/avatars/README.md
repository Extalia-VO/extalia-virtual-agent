# Office characters

`OfficeCharacter` normally renders the registered Blender bodies and detailed
hair shared by Web, Desktop, portraits and facility characters. These are the
existing retargeted models, not newly generated replacement humans; their
RenderHub Extended Use License and source notices are recorded in
`apps/web/public-assets`. Two body GLBs serve four appearance variants, and ten
detailed hair exports retain the original style fallback.

If model loading fails, the self-made procedural fallback provides layered sculpted
hair, face and ears, textured eyes, articulated hands and fingers, wardrobe cuts
and trims, cuff details, and shaped shoes. Appearance, rig, wardrobe, face and
texture helpers are renderer-local code. Optional unregistered local models are
available only through the explicit development-server mode `local-assets`;
registered public models retain priority.

`CharacterAppearance` (from `@extalia/core`) is the saved, strictly validated
look of one character, independent of runtime state. Without a saved look,
`resolvedAppearance` uses the normalized full-name identity when supplied,
otherwise the presence `id`; saved looks always win. Titles, models and
providers do not seed the look. `PRESENTATION_PRESETS` and `applyPresentationPreset` define the
feminine, masculine and neutral presets; `avatarVisual` maps a look onto the
renderer config and `characterRig` applies the presentation frame (shoulder and
hip width, small height bias), stature and optional height.

Garments: shirt, blouse (fitted, scoop neck), knit and turtleneck tops;
trousers, skirt and dress. Skirts and dresses have a waist yoke on the torso and
a drape that follows the thighs, so the 45 cm seated pose lies over the lap;
coats fold at the seat when seated. Accessories: glasses, watches, earrings,
bags (carried standing, set beside the seat), tie, badge and headphones. Hair
covers 13 styles, including bun and long cuts; clipper shading follows the hair
color.

`gait.ts` holds the walking style: `gaitParameters` (stride length, hip sway and
roll, arm swing, cadence) and `idlePose`, which drives the standing weight shift
and the seated sway. The walk cycle (`movement/walkCycle.ts`) takes stride, arm
swing, hip sway and cadence from `gaitParameters`; walking speed is stride length
× cadence. Both renderers read a live `CharacterMotion` (`sit`, `walk`, `phase`)
written by the movement layer, so the seated and standing poses blend while a
character sits down or stands up. Routes, arrivals and departures live in
`../movement/` (`navGraph.ts`, `mover.ts`, `director.ts`).

The status ring retains reported presence colors, and selection has a separate
ring. Standing, a 45 cm seated pose and idle movement are supported. Activity
clips (`activityPose.ts`) add joint offsets over either renderer's base pose:
desk work chosen from the reported activity kind by `movement/workClip.ts`
(edit types, read/search scrolls and reads, thinking puts a hand to the chin or
leans back, commands and tests type then watch the output), idle desk moments,
and the leisure poses of idle characters (lounge, TV, bar, fitness, games,
chat). The movement layer writes the clip into `CharacterMotion.clip`.
At a desk the hands follow the desk: `deskReach.ts` expresses the keyboard, mouse
and cup in the seat frame, `handGoals.ts` gives each wrist a target per clip, and
`armPole.ts` solves the two-bone desk arm with a continuous elbow plane that
keeps outward mouse reaches below the shoulder. `armIk.ts` retains the movement
reach solve. `handOrientation.ts` uses the actual posed parent transform for
palm orientation and shares bounded wrist roll with the forearm. Typing hands
span the keyboard's letter area; wrist travel stays small while fingers move.
Sipping and phone moments show a mug
(`IdleProps.tsx`) or a phone only in their clip, never with reduced motion.
Reduced motion disables cosmetic movement including idle sway and facial
blinks. Animation never creates task state or progress.

Board, card and message portraits render this same `CharacterBody` through one
shared offscreen renderer, with duplicate frame copies and visibility-aware
scheduling. `facialExpression.ts` provides seeded blink, gaze, idle yawn and
focused/waiting expressions using a shared monotonic clock and live scene
activity. Canonical local heads receive narrowly gated cached runtime shapes;
procedural heads use the same controls. Reduced motion freezes expressions.
Model failures use the procedural body; graphics failures retain an illustration.

## Local-only source models

Unreviewed source packs and authoring inputs remain local and are never
committed. The reviewed public avatar outputs retain their separate RenderHub
license rather than the project's MIT license. Local originals live in
`apps/web/local-assets/` (listed in the root `.gitignore`):

```text
apps/web/local-assets/avatars/
  bodies/<model-variant>.glb        office-classic, business-man, business-woman, female-casual
  hair/<male|female|shared>/<style>.glb
  hair/catalog.json                 sizes and hashes of the files above (local metadata)
  source/<model-variant>.glb        full packs, only needed to re-run the extractor
```

Vite loads `bodies/` and `hair/` through `import.meta.glob` in `sourceAvatarFiles.ts`
only with `pnpm --filter @extalia/web exec vite --mode local-assets`. Default
builds and development servers alias that module to registered public maps before
asset discovery, even when private files are installed. Production builds reject
the `local-assets` mode. The public Office geometry is separately registered in
`apps/web/public-assets/models.json`; its approved scene and licensed avatar models are
included in both Web and Desktop.
A missing folder, or a missing single file, yields an empty map: no build error
and no runtime error. `OfficeCharacter` mounts `SourceHumanoid` only when both the
body and the hair model for the look exist; otherwise (and if loading a
model fails) it renders the procedural `CharacterMesh`. While selected
source assets are pending, the body stays hidden instead of briefly switching
from the procedural style to the detailed style. Only the selected body/hair URLs
are preloaded, in parallel, using the same separate per-URL caches as the renderer.
Subsequent instances reuse the assets and clone their skeletons/materials; there
is no global asset preload or additional lightweight model. Presence, movement
and interactions continue while the visual body waits for its assets. The
appearance editor offers the same 13 hair styles either way, because the procedural
character draws each one itself.

- To use your own models, put files with these names in the folder above. Only
  add models whose license allows you to use them; the folder stays on your
  machine.
- `pnpm lint` (`tooling/check-public-safety.mjs`) rejects model files outside the
  explicitly registered and hash-verified public inventory. Private avatar packs
  stay ignored; do not work around the guard with `git add -f`.
- Additional public models need confirmed redistribution rights, attribution,
  license text, source provenance and an inventory entry before they can ship.
- `node tooling/check-character-hair.mjs` (part of `pnpm check`) validates the
  local hair and body files. Without the folder it prints
  `skipped: no local avatar assets` and exits 0.

### Source-model integration

When the local models exist, `SourceHumanoid` adapts their wardrobe slots, morphs
and skeletal coordinate system to host-derived presence. Per-instance materials
are cloned; shared model geometry and textures are cached. Embedded textures use
local object URLs, allowed for images in the Bridge/Desktop Content Security
Policy. Asset geometry does not invent runtime activity; session state controls
typing and status rings.

Source body scale uses the rig's width/height and depth/height ratios, avoiding
a second application of the procedural body's nominal scale. For the known
local source outfits, `sourceLimbWeights.ts` confines elbow/knee blending to the
joint region so upper-limb weights do not bend the middle of a forearm or calf.
It leaves skin, shoes, rest geometry and unrelated influences unchanged.

`sourceGarmentWeights.ts` first identifies isolated sleeves by welded triangle
connectivity and shoulder/cuff extent. Those sleeves receive an anatomical
upper-arm/forearm blend, fading into the original shoulder cap and retaining
hand influence at the cuff. Sleeveless torso panels shed leaked arm influences.
Joined sleeve/bodice meshes, unknown garments and other wardrobe variants keep
their authored binding. Only cached skin-index/weight attributes change; rest
geometry, materials and local asset files stay intact.

The source skeleton ends at the hands. `sourceHandCurl.ts` therefore provides
two cached relaxed-hand morphs for the recognized local assets; it does not
provide independently articulated source fingers. The procedural character has
four articulated fingers per hand. Source models with finger bones or unknown
asset names keep their original geometry.

`sourceFootGeometry.ts` fits only the formal `ScanOutfit` cuffs and exposed
foot skin. The distal bare-foot volume is tucked smoothly inside the closed
shoe while retaining skin height and the upper ankle. The map stays monotone
instead of flattening or folding the surface. Shoe primitives, skin weights,
UVs, indices and other wardrobe variants retain their source data. Corrections
use cached geometry copies; local model files are unchanged. Per-outfit sole
measurements drive the leg floor constraint, including sit/stand transitions;
the seated hip and desk contacts stay fixed.

### Bodies made in Blender

The local bodies can be rebuilt in Blender from Character Creator base bodies: fitted to the
20-joint skeleton (names, hierarchy and rolls unchanged), skin textures neutralised so the app's
skin tone tints them, standing 1.85 m to the crown, and dressed in scanned outfits retargeted onto
them. A body file then carries `Body` (head, neck and hands; other skin under the outfit is not
shipped), optionally `BodyNeckline`, `EyesDetail`, `Eyebrows`, the `Facial*` hair and one
`ScanOutfit` mesh. The outfit's materials are named by role (`OfficeTop`, `OfficeOuter`,
`OfficeAccent`, `OfficeBottom`, `OfficeShoes`, `OfficeLining`; `Skin_*` for scanned skin), so the
wardrobe palette colours every look; meshes outside the office and source wardrobe sets always
show. Facial hair, brows and lashes draw as alpha-tested strand cards like the hair.

When a machine ships only detailed hair, a look whose style has no local model wears the first
local style of its group, and the appearance editor offers only the local styles. Rebuild the
detailed hair for such heads with `tooling/convert-detailed-hair.py` and `"fit_ref": true`, which
fits the pack to the reference body's own skull instead of the original canonical head.

### Modular hair

The local renderer loads a base body from `bodies/` and one independently skinned
hair file from `hair/male/` or `hair/female/`. Male styles are short fade, side
part, slicked back, undercut, textured crop, curly and afro; female styles are
bob, wavy, ponytail, high ponytail, medium and bun. Hair is kept per gender: the
appearance editor offers only the character's own presentation group (a saved
style from the other group stays visible as the current value), and generated
looks wear the detailed styles of their group.

`tooling/extract-character-hair.mjs` reproducibly prunes unrelated meshes, images
and buffers from the packs in `source/` while retaining the canonical 20-joint
skeleton and female morphs, and writes `bodies/`, `hair/` and `catalog.json` into
the same local folder. The renderer copies the body's animated bone pose into the
hair rig, hides source-pack hair, and caches geometry/textures with per-character
tint.

The old `long` setting resolves to the actual wavy mesh.

#### Detailed hair (hair cards)

Some styles also have a detailed hair-card model, `hair/<group>/<style>-detail.glb`
(`detail` in `packages/core/src/characterHair.ts`): textured crop and slicked back
(male), high ponytail and bun (female). When present locally it replaces the light
mesh. It is made from a hair pack you are licensed to use with
`tooling/convert-detailed-hair.py` (Blender, run with `--factory-startup`): the
hair is fitted to the canonical head, bound rigidly to the `head` bone, thinned
to a triangle budget by whole cards, and given one grey strand texture per
material (tinted by the hair colour at runtime; alpha from the pack's opacity
map). `node tooling/register-detailed-hair.mjs` records the files in
`catalog.json`, and `tooling/check-character-hair.mjs` validates them.

The renderer draws hair cards as alpha-tested cut-outs (blended cards are not
sorted and vanished from some angles). The business-woman body's head is a face
shell without a skull — the light meshes cover it — so a look on that body that
wears detailed hair uses the whole-head female body instead. Without a detailed
file the light mesh is used (bun falls back to the bob mesh); the procedural
character draws every style itself.

### Outfits, first-spawn looks and staff uniforms

`outfitCatalog.ts` lists what a character may wear: the scanned outfit styles every
body carries, plus the fitted outfit models found at build time under
`public-assets/avatars/outfits/<male|female>/<id>.glb` (reviewed source-preserving garments and the staff uniforms). No model id is
hard-coded: a new file becomes a choice for its gender group. `SourceHumanoid`
loads the selected model next to the body, rebinds its skinned mesh to the body's
bones by name and shows it as the `ScanOutfitModel` slot; its `Office<Zone>_*` and
`Skin_*` materials take the same tints as the scanned outfits. `Original*` materials preserve
their source colours and maps on Auto and accept explicit colour tints on cloned materials.

Without a saved look, a character wears a generated outfit picked from the
reviewed pieces and its group's models by highest-random-weight hashing of its
look seed (`seededOutfitChoice`): stable across reloads, varied across characters,
and when the catalog gains an outfit only the characters it wins for change.
Garment colours come from coordinated office or casual zone palettes
(`OUTFIT_PALETTES`: top, bottom, jacket, accent). Nothing is stored on spawn; the
look is saved only when the user saves an edit, as for every other appearance
field. The appearance editor offers every outfit of the character's group,
zone colours, **Randomize outfit** (re-rolls outfit and colours) and
**Default outfit** (back to the generated one).

The receptionist and the bartender always wear their role uniform
(`STAFF_UNIFORMS`, `staffAppearance`): the editor shows the uniform as locked and
only its accent colour (tie, scarf, bow tie, badge stripe), hair, skin, body and
accessories change.


### Independent fitted garments

`CharacterAppearance.outfitParts` stores optional top, bottom and outer model ids. The host
persists the same contract as other appearance fields; `outfitModel` and `outfitParts` are
exclusive. Default combinations use stable seeds per identity and slot. Changing a bottom
never rerolls a top; choosing a body preset clears incompatible fitted models/parts.

Body-specific pieces come from `avatars/wardrobe/<male|female>/<top|bottom|outer>/`. They
retain the original GLB meshes, UVs and textures, fitted by `tooling/blender/fit-original-*.py`
on each body's reference rig.
Their bone names/rest transforms match the body. The renderer rebinds the selected layers
and removes only the replaced scan zones, retaining a missing part's scan fallback. Exposed
arm skin belongs to the upper garment even below waist height; lower garments include exposed leg
skin and may own source shoes. Otherwise corrected native feet and shoes remain. Outer layers
carry no skin. Declared closed-jacket coverage hides only occluded underlayers. See the tooling README for publication.

The raw downloaded garment conversions remain local review material. Their duplicate seams
and weight inversion were repaired, but source sleeve correspondence and complex silhouettes
still fail fit review. They are not offered in production or first-spawn choices. Reviewed original receptionist and bartender sets replace their matching role paths. Facility
uniforms retain their role-specific complete outfit and editable personal features/accents.
