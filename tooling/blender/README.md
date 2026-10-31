# Blender asset tooling

Headless Blender scripts that author or prepare the Office's public 3D models.
Run them with `Blender --background --factory-startup --python <script> -- <args>`;
local exports land in the git-ignored `apps/web/local-assets/`, and
`python3 tooling/blender/prepare-public-models.py` publishes the reviewed set to
`apps/web/public-assets/` with hashes, licences and provenance in `models.json`.

## Staff uniforms

`create-staff-uniforms.py` builds fallback receptionist and bartender uniforms for both
bodies from `staff-uniforms.json`. Each starts from the body's own scanned outfit
and adds layers cut from it with planar edges (a blazer with back collar, front V,
sleeves above the shirt cuff and buttons, or a waistcoat with armholes and a satin
back), lifted off the garment below, plus generated parts: name badge, bow tie,
neck scarf, bistro apron, rolled sleeves with forearm skin. Torso cloth takes the
base garment's weights without arm influence below the shoulder line (no armpit
webbing), sleeves follow the sleeve below, hems mostly the hips. The output follows
the fitted-outfit format (rig plus one `Outfit` mesh, `Office<Zone>_<Id>` materials,
no UVs or textures) and stays under the RenderHub licence of the avatar outfit.

```sh
Blender --background --factory-startup --python tooling/blender/create-staff-uniforms.py -- \
  [--only reception-uniform/female,bartender-uniform/male] [--review <dir>]
python3 tooling/blender/prepare-public-models.py --staff-uniforms
```

`--review` renders each uniform standing, at a desk, reaching, walking and seated.
In a live Blender, exec the script with `__name__ = "__live__"` to build the four
uniforms (with test-pose keyframes added by hand) into the scene "Extalia Uniforms".
Reruns are byte-identical. Reviewed original uniforms at the same published paths take precedence
and are preserved by the general publisher.

## Original garments and modular wardrobe

The active fitted garments retain the owner-provided GLB geometry, UVs and embedded source
textures. `fit-original-garments.py` fits the female cloth jacket; `fit-original-bottoms.py`
fits female denim shorts and the CC-BY male jeans/sneakers from `hoodie_and_jeans.glb`.
`fit-original-sets.py` fits the original dress and receptionist suit; `fit-original-bartender.py`
fits the original vest over the licensed male shirt/trousers. Source credits are read from
the GLBs and recorded separately from added avatar skin/context.

```sh
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/fit-original-garments.py -- --source-dir <assets-temp/shirt>
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/fit-original-bottoms.py -- --source-dir <assets-temp/shirt>
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/fit-original-sets.py -- --source-dir <assets-temp/shirt>
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/fit-original-bartender.py -- --source-dir <assets-temp/shirt>
# After reviewing standing, walking, sitting, desk work and reaching:
python3 tooling/blender/publish-original-garments.py --only all
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/check-avatar-outfit-fit.py
```

Pieces live in `avatars/wardrobe/<female|male>/<top|bottom|outer>/<id>.glb`, complete sets
in `avatars/outfits/<female|male>/`. All bind to the body's twenty-joint reference skeleton.
`original-skin-seams.py` bridges generated leg skin to the corrected native ankle ring,
matching its positions and bone weights instead of overlapping incompatible skin surfaces.
`original-armhole-seams.py` adds an internal cloth gusset behind the receptionist suit's
separate CAD armhole rims. It retains the original exterior faces and sampled cloth material.
The original solid suit fabrics export as opaque to prevent transparent layer sorting from
hiding the jacket behind its shirt; texture payloads remain unchanged.
Original textures stay on Auto; explicit colour choices tint cloned materials. The jacket's
white source inner is only a visible front panel, so it remains local and cannot be selected
as a standalone top. The outer works over the body's complete shirt. Missing separate slots
retain native clothing; shoes come from the selected original bottom or the corrected native
footwear. Whole sets and separate garments are exclusive saved choices.

Publication registers only explicit reviewed paths and strips private export metadata while
preserving embedded texture payloads. The general asset publisher preserves original uniform
replacements. Source garments retain CC-BY-4.0 attribution; added avatar skin and clothing keep
their separate RenderHub licence. Raw conversions and rejected template experiments remain local.

### Source GLB catalogue

`source-garments-female.json` and `source-garments-male.json` cover every example GLB,
including complete outfits, individual garments and explicitly selected variants from packs.
`fit-source-garments.py` retains source panels, all corner UV layers, native material graphs,
embedded texture bytes and authored alpha settings. Material identity uses glTF indices,
including sources with duplicate material names. Added body context has its own materials.
Existing reviewed exports are protected by `existingOnly` recipes.

Generated body backing retains the reference body's small skin influences and continuous
limbs beneath moving hems. Shared, bounded torso/pelvis/sleeve fields fit source layers
together; they never replace their materials or corner data. Source-owned footwear and
native shoe/ankle context remain separate choices.

An explicit `seatedDrapeOptions.mode: offline_cloth` bakes a temporary Blender cloth proxy
into `ExtaliaSeatedDrape`; optional `short_pose_profile` and `tall_pose_profile` add
`ExtaliaSeatedDrapeShort` and `ExtaliaSeatedDrapeTall`. The renderer interpolates the
reviewed height bank only while seated. All targets are zero
when standing or walking, and added body context has zero cloth deltas. These exports
require per-file collision, strain and visual review; offline simulation is never a
substitute for inspecting the original fabric and the final runtime poses.
Body clearance does not establish correct nesting between overlapping cloth layers.

Native trousers behind a separate original top retain their own materials. The renderer
fits covered areas beneath the original cloth, protects body clearance and matches the
exposed source body's hip binding where necessary. Original garments remain unchanged.
An explicitly reviewed short-skirt recipe can add concealed native inner shorts; their
reference body weights and zero drape deltas preserve coverage while seated.

Reviewed recipes may also opt into source-only shoulder banks or a walking drape.
`shoulderCorrective` bakes named angle samples and leaves the standing Basis intact;
the renderer interpolates them from chest-relative arm elevation after hand IK.
Forward shoulder samples require a separate desk/elbow review before approval.
`walkDrape` adds one zero-default `ExtaliaWalkDrape` target, shared across the original
cloth layers. Its runtime weight is `walk * (1 - sit)`, independently of seated banks.
The fitting input comes from the production gait, walk-cycle and limb math:

```sh
node --experimental-strip-types tooling/blender/generate-source-walk-poses.ts \
  --reference <canonical-reference.glb> --output <local-walk-poses.json> \
  --sole-left <metres> --sole-right <metres> --phases 16 \
  --heights 145,170,195 --gaits feminine,masculine --strides 1,1.6
# Add --walk-poses <local-walk-poses.json> to fit-source-garments.py.
```

The fitter verifies the reference joints and takes eight phases of each gait/stride
profile. Keep the pose packet with local review evidence; it records the source rig
hash and its canonical matrix frame. Validate intermediate phases and actual rendered
Skin exposure as well as the solver's residuals. These features remain explicit;
they never grant catalogue approval on their own.

```sh
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/fit-source-garments.py -- --source-dir <assets-temp/shirt> --group female
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/fit-source-garments.py -- --source-dir <assets-temp/shirt> --group male
python3 tooling/blender/audit-source-garments.py --source-dir <assets-temp/shirt> --output <local-report.json> --corners
python3 tooling/blender/publish-source-garments.py --source-dir <assets-temp/shirt> --dry-run
```

Candidates and their `.source.json` fidelity receipts stay under the ignored
`local-assets/avatars/all-garment-review/fitted/` directory. The audit checks all source
files against the recipes, verifies current source/output hashes, native material graphs,
embedded images and required UV sets. `--corners` additionally compares every retained UV
corner per source material; this checks UV values and multiplicities, not geometric fit.
Explicit detail LODs change corner multiplicities and must be reviewed separately. The Flame
hoodie's recipe reduces modeled stitches only; its primary fabric triangles stay unchanged.
Its auxiliary topology graph corrects sleeve/bodice weights without welding or changing UVs.
Channels beyond Blender's eight-UV export limit are restored only when exact source
per-primitive duplication and fitted corner correspondence prove a safe accessor alias.
Distinct missing UV data fails conversion.

Material fidelity alone never grants wearable approval. Review source appearance, rest, walk,
sit and reach against the actual body and native context, then record `review.status: passed`,
the exact `fittedSHA256`, positive `review.budgets.triangles` and `.bytes`, and all five
`review.fitChecks` as true. CC-BY recipes also require `publish: true` for public promotion.
Standard-licensed sources keep `publish: false` and can only enter the reviewed local catalogue.
The publisher rejects stale hashes, missing maps/UVs, unreviewed overrides or exceeded budgets,
and verifies the material graph again after sanitizing export metadata. Public receipts live in
`public-assets/source-garments.json`; approved local receipts in
`local-assets/avatars/reviewed-source-garments.json`. Never approve a candidate to satisfy a count.

Regression checks without source downloads:

```sh
python3 tooling/blender/check-original-gltf-materials.py
python3 tooling/blender/check-source-uv-audit.py
python3 tooling/blender/check-source-garment-publication.py
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/check-source-garment-corners.py
```

## Avatar outfits

Wearable outfits (`avatars/outfits/<male|female>/outfit-<name>.glb`) are refitted from
downloaded garments listed in [`avatar-outfits.json`](avatar-outfits.json), one entry per
outfit. Entries marked `publish: false` remain local review outputs and never become production
choices. The generic downloaded conversions are held because their source sleeve/body
correspondence has not passed walk/seated review; the modular wardrobe above supplies the
active separates and sets through dedicated source-preserving fitters. The runtime offers every published file of a gender group automatically
(`apps/web/src/office/scene/avatars/outfitCatalog.ts`). `prepare-avatar-outfits.py` imports
the entry's model (FBX, OBJ or GLB, extracted alone from the archive with `bsdtar`), drops
the source avatar, hair, stitching and logos, assigns tint zones (rules, else by placement:
shoes, small trim, bottoms, top, outer layers), welds duplicate source seams before any decimation, preserves thin layers, registers the cloth to the reference body,
poses that body into the source's arm and leg spread and skins the cloth from it (no
webbing between arm and torso; skirts blend hips and both thighs), keeps connected cloth surfaces and consistently winds their normals, decimates to about 6,000 triangles, returns to the rest pose, pushes the cloth
off the skin, winds every face away from the body, keeps only the skin the garment leaves
visible, borrows shoes (and trousers or a base top when the download lacks them) from the
body's own scan outfit, and exports the rig plus one `Outfit` mesh (`Office<Zone>_<Id>` and
`Skin_<Id>` materials, no UVs or textures, at most 10,000 triangles and 700 kB).

```sh
# once: cut the full reference bodies out of the local avatar review file
Blender --background --factory-startup --python tooling/blender/prepare-avatar-outfits.py -- \
  --build-reference <merged avatar review .blend>
Blender --background --factory-startup --python tooling/blender/prepare-avatar-outfits.py -- \
  --source-dir <assets-temp/shirt> [--only outfit-dress,outfit-sport] [--work-dir <empty dir>]
python3 tooling/blender/publish-avatar-outfits.py
```

The fitting pass smooths and limits bone influences before inverse skinning, so the exported
weights reproduce the fitted source pose. Cleanup never splits non-manifold edges to force a
budget or deletes individual faces using a visibility ray: either can fragment thin cloth.
Coincident seams are welded at 0.1 micrometre in world units within each source object/part,
leaving nearby linings separate. The sports set borrows the reference shoes rather than keeping
its poorly fitting source footwear. Retained touching layers are not guaranteed manifold, and
these are skinned meshes rather than simulated cloth; extreme seated hems can still overlap.

Run the synthetic topology and pose regressions without downloaded assets or a user profile:

```sh
Blender --background --factory-startup --python-exit-code 1 --python tooling/blender/check-avatar-outfit-fit.py
```

### How to add an outfit

1. Put the download in the local clothing folder (`assets-temp/shirt/<female|male>/`).
2. Add an entry: `id` (`outfit-<name>`, also the file name and the runtime id), `group`,
   `label`, `category`, `archive`, `source` (the model inside it; `inner.rar::model.fbx`
   for nested archives; a loose `.glb` names itself), `title`, `license` and `notice`
   (CC-BY entries carry title, author and Sketchfab URL from the GLB's `asset.extras`;
   owner files without a licence use `LicenseRef-Owner-Provided-Unverified`).
3. Fit hints only when needed: `span` ([low, high] body heights of the garment when the
   units guess fails), `avatar` (rules naming the source mannequin), `zones`
   (`[object|material, regex, zone]`, zones top/outer/accent/trim/bottom/shoes/lining/drop),
   `skirt` ([top, hem] heights), `hem` (crop long hems), `borrow` (scan-outfit parts),
   `predecimate` (very heavy sources), `rotate`. `"status": "skip"` with a `reason` keeps a
   download listed but unpublished.
4. Run the two commands above for that id, look at it (rest, walk, seated, typing, arms
   raised), then `pnpm exec vitest run tooling/blender/avatarOutfits.test.ts`.

## Campus parking

`create-campus-parking.py` lays out both parking lots with layout markers (Blender
empties for every bay, aisle point, entry point and lamp in "Parking layout markers").
It reads the markers back to draw the east lot (asphalt, kerbs, bay lines, wheel stops,
EV pads, footway and garden link, aisle crossing, planting) and both access connectors
(level throat, smoothstep ramp cut into the plinth with retaining walls, dropped-kerb
footway crossing with curved kerb returns, tactile paving, give-way line and centre
line) into `landscape/campus-parking.glb` (about 1,700 triangles, one merged runtime
draw), and writes `campus-parking.layout.json`. Publishing copies the GLB and turns the
layout into `apps/web/src/office/scene/campusParkingLots.json`, the data behind the
shared `PARKING_LOTS` contract (`campusParkingLots.ts`); the west lot's bays stay
instanced runtime slabs. To change a lot, move markers in the live scene (exec the file
and call `setup_scene()`, `create_markers()`, `build()`), carry the change into
`layout_definition()`, re-export and publish.

## Campus cars

Passenger cars are simplified, debadged derivatives of reference models listed in
[`campus-vehicles.json`](campus-vehicles.json). `prepare-campus-vehicles.py`
extracts only each entry's preferred model file from its archive, removes the
interior and badges, decimates to about 6,000 smooth triangles, replaces the
wheels with one instanced wheel template plus four hub markers, assigns plain role
materials and exports `apps/web/local-assets/vehicles/<style>.glb`. EV chargers and
the cycle shelter stay project-generated by `create-campus-mobility.py`. Every
vehicle, pickups included, is derived: the double-cab `pickup` (the old
`mobility-double-cabin` name resolves to it) and the mid-size, full-size, crew,
off-road and electric pickups replace the retired procedural single-cab truck,
whose `mobility-truck` name now resolves through `LEGACY_MOBILITY_MODELS` to the
day's mid-size pickup (else `pickup`).

### How to add a new car

1. Put the downloaded archive in the local reference folder, e.g.
   `assets-temp/cars/ev/<archive>.zip` or `assets-temp/cars/conventional/`.
   A single self-contained `.glb` (e.g. a Sketchfab download) also works: name
   it as both `archive` and `source`. Archives and their textures are never committed.
2. Add one entry to `campus-vehicles.json`:
   - `style`: a neutral id without brand (`ev-hatch`, `wagon`, ...). The runtime
     model is `mobility-<style>` and the file `vehicles/<style>.glb`.
   - `category`: `ev` (charging bays) or `conventional`, from the reference folder
     (`ev/` or `conventional/`; hybrids and plug-in hybrids stay conventional unless the
     folder says `ev`); `weight`: how common the car is (`>= 1` drives in traffic, `< 1`
     is rare: parked at most once, never in traffic, and drawn less often into the daily
     rotation). `placement: "traffic-only"` marks a vehicle that never parks (too long
     for a bay) and drives only on the lanes without a pedestrian crossing; only such a
     vehicle may raise `max_triangles` / `max_bytes` above 6,600 / 350,000.
   - `archive` (file name only), `source` (the model file inside it; prefer
     `.glb`/`.gltf`, then `.blend`, `.fbx`), `title`, real `length` in metres and
     `forward` (`+Y`/`-Y`/`+X`/`-X`: where the source car's front points).
   - `license`: the source's real licence, taken from the download (for Sketchfab
     `.glb` files: `asset.extras.license`): `CC-BY-4.0`, `CC-BY-NC-4.0`,
     `CC-BY-NC-SA-4.0` (non-commercial; the ShareAlike derivative stays
     CC-BY-NC-SA-4.0), `LicenseRef-Sketchfab-Standard`,
     `LicenseRef-RenderHub-Extended-Use` (notice `renderhub-extended-use`) or
     `LicenseRef-Owner-Provided-Unverified` (no licence file: credit "author and licence
     pending owner confirmation" until the owner confirms them). `notice`: a key of
     `notices` whose text carries the exact title, author, source URL and licence URL
     (and "Non-commercial use only." for NC licences). Other licences are rejected by
     the public-model validator.
   - Optional fixes when the generic name/colour heuristics fail: `rules`
     (`[object|parent|material, regex, role]`, first match wins; `parent` matches any
     ancestor node; roles `paint`, `glass`,
     `trim`, `rubber`, `alloy`, `lamp` (split head/tail by position),
     `lamp_head`, `lamp_tail`, `plate`, `drop`, and `texture`: classify that atlas
     material from its sampled texels like `colourFrom: "texture"`; add
     `texture_paint: false` when the paint comes from a plain material), `role_boxes`
     (`[role, |x| min, |x| max, from front min, max, z min, z max, [roles it replaces]?]`
     after normalising: a chrome grille emblem to `trim`, tyres that share one black
     material to `rubber`, loose bed cargo to `drop`), `emblems` (`[|x| min, |x| max,
     from front min, max, z min, z max]`: every loose part wholly inside the box is
     removed, e.g. a grille or tailgate badge; parts sharing a vertex position count as
     one, so the panel behind stays whole; pair it with a `role_boxes` entry that
     recolours whatever relief is left as grille `trim` or tailgate `paint`), `caps`
     (`[role, z, |x| max, from front min, max]`: a flat panel closing a roof the source
     left open), `side_caps` (`[role, |x|, from front min, max, z min, z max]`: an upright
     panel on both sides, added after simplification behind the side glass, so a glazing
     gap or an open door window never shows the hollow cabin),
     `source_box` (source-space `[x0, x1, y0, y1, z0, z1]`: keep one car when the scene
     holds several), `spare: "rear"` (only rubber in the rear fifth can form a tailgate
     spare wheel; recommended for new entries), `head_boxes`/`tail_boxes`
     (recessed lamp units), `paint_boxes` (badges set into a panel), `nose`,
     `drop_below`, `lamp_decals`. Box values are metres after normalising:
     `[|x| min, |x| max, from front (head/paint) or rear (tail) min, max, z min, z max]`.
   - `colourFrom: "texture"` for sources whose colours live in a texture atlas
     (one material, no useful names): each face samples the base-colour (and
     emission) texture at its UV centroid plus four inner points (median), then
     roles come from colour clusters and position: emissive texels are lamps,
     the colour covering most upper-body area is paint, dark bluish texels above
     the belt are glass, round loose parts in the lower corners are tyres, light
     or red texels at the front/rear extremes are lamps, the rest trim/alloy.
     `texture_roles` (`[role, |x| min, |x| max, from front min, max, z min, z max]`)
     overrides the result inside a box.
3. Export it (other entries keep their previous output):

   ```sh
   Blender --background --factory-startup \
     --python tooling/blender/prepare-campus-vehicles.py -- \
     --source-dir <assets-temp/cars> --only <style>
   ```

   Several `--only` runs may go in parallel (each with its own `--work-dir`; the
   manifest is merged under a lock). For very heavy sources set `predecimate: 400000`:
   larger parts are then decimated in two stages, so even 2M-triangle downloads stay
   fast and within a few GB of memory.
   Review the result in Blender (import the GLB): front faces app `+Z`, wheels on
   the ground, no interior or badges, lamps in the right place. Iterate on the
   entry's rules if needed. Reruns are byte-identical.
4. Publish: `python3 tooling/blender/prepare-public-models.py`. This copies the
   GLB, records its licence and provenance in `models.json`, regenerates the
   "Campus vehicles" section of `THIRD_PARTY_NOTICES.md` and the runtime catalog
   `apps/web/src/office/scene/campusVehicles.json` (with `trafficOnly`,
   `nonCommercial` and `licenseUnverified` flags). Each day the runtime draws 12-14
   styles from it (weighted, seeded by the local date; `?carSeed=<n>` pins it in
   development) and parks and drives only those; see `apps/web/public-assets/README.md`.
5. Test: `pnpm exec vitest run tooling apps/web`, `pnpm typecheck`, `pnpm lint`.
