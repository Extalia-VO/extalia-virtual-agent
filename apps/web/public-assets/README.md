# Public Office models

The 2026-11-08 inventory snapshot contains **133 models**: 18 project-authored
scene models (the work tablet included), 12 retained body/hair exports, 8 detailed hairs from owner-provided packs,
32 fitted outfits/wardrobe pieces, 45 simplified campus vehicles and 18 campus plants and trees. Their registered GLB bytes total **152,104,948**
(about 145 MiB before packaging compression; 47 garment, outfit and hair files use the compact
texture profile, see "Texture encoding"); this is asset size, not measured
startup cost or runtime memory. Web, Desktop and the npm Bridge share the inventory.
Exact hashes, sizes, declared licenses and provenance are in [models.json](models.json).

The declared-license counts are MIT 18, RenderHub Extended Use 49, CC-BY-4.0 57,
CC-BY-NC-SA-4.0 4, CC-BY-NC-4.0 1, Sketchfab Standard 4. The project's
[MIT license](LICENSE.md) does not replace third-party terms. Retained avatars,
source garments, generated additions and derived vehicles keep the component
terms described in [AVATAR_SOURCE_LICENSE.md](AVATAR_SOURCE_LICENSE.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Inventory validation checks
these recorded declarations and bytes; it is not an independent grant of rights.

## Texture encoding

**Compact profile (current, owner-approved 2026-11).** `tooling/compress-public-models.py
--profile compact` (`--dry-run`, `--write`; `--verify` re-checks the records) trades sharpness for size
while keeping motifs, prints and stitching readable. Every texture is at most **512 px** on its longest
side (Lanczos, never upscaled):

- Colour maps (base colour, emissive, anything shared with a colour slot): lossy WebP q90 (method 6,
  alpha kept losslessly); quality is raised to q95, then lossless, when PSNR < 38 dB or SSIM < 0.95
  against the 512 px source. Worst measured: PSNR 38.55 dB, SSIM 0.962.
- Data maps (normal, metallic-roughness, occlusion): JPEG q92 with 4:4:4 chroma (q95, then lossless
  WebP, when a threshold fails; lossless WebP when alpha matters). Normal maps must stay within a mean
  angular error of 2 degrees and p99 of 6 degrees (worst measured 1.94 and 5.98). Lossy WebP is never
  used for data maps.
- The smallest passing encoding wins; an image that is already small enough and not made smaller
  is kept. Textures and images no material references are removed (the three Ray garments carried ten
  each). `EXT_texture_webp` is declared only where WebP images remain; JPEG is core glTF.
- Each changed image records `extras.extaliaImageConversion` with `profile: "compact"`, the encoding,
  the original source SHA-256, size and bytes, `resizedFrom`, the measured metrics and the payload
  SHA-256; `tooling/public-models.mjs` checks all of it and the material receipts still resolve to
  the original source image.

The earlier lossless rules below describe how the recorded source images were first produced.

`tooling/compress-public-models.py` (`--dry-run`, `--write`, `--verify`) shrinks GLBs
without changing any motif:

- PNG colour textures (base colour, emissive and any other slot) become **lossless WebP**;
  the decoded RGBA pixels, including alpha, must be exactly equal or the PNG is kept.
  JPEG textures are left as they are.
- Normal, metallic-roughness and occlusion maps larger than 2048 px are downscaled to
  2048 px (Lanczos, aspect kept) and stored as lossless WebP. An image that is also used by
  any other slot is never resized.
- Identical image payloads are stored once; geometry, skins, morph targets, UVs, materials
  and samplers are untouched.
- Textures use `EXT_texture_webp` (listed in `extensionsUsed` and `extensionsRequired`, like
  the avatar bodies); three.js `GLTFLoader` decodes it natively. No Draco, Meshopt or KTX2:
  the CSP `script-src 'self'` blocks WASM decoders.
- Each converted image records `extras.extaliaImageConversion` (source SHA-256 and size,
  pixel hashes, `resizedFrom` for a downscale). `tooling/public-models.mjs` hashes the
  recorded source image for the per-garment material receipts, so `source-garments.json`
  keeps the original image hashes as provenance, and rejects a resize of any colour map.

## Vertex quantization

`tooling/compress-public-models.py --quantize` (`--dry-run`, `--write`; `--verify` re-checks
the records) quantizes only the vertex data of **skinned** primitives, with
`KHR_mesh_quantization` (native in three.js `GLTFLoader`, no WASM):

- `WEIGHTS_n` become normalized uint16, renormalized so every vertex sums to exactly 65535
  (largest remainder; worst deviation from the original weights about 1.1e-5).
- `TANGENT` becomes normalized int8 (int16 if the error would exceed 0.5 degrees; worst
  measured 0.32 degrees); the `w` sign stays exact. Only files with a quantized tangent list
  `KHR_mesh_quantization` in `extensionsUsed` and `extensionsRequired`.
- `POSITION` and `NORMAL` stay float (a skinned mesh ignores its node transform, and the avatar
  code recomputes normals in place); static scene and vehicle meshes are untouched because the
  scene bakes and merges their geometry. UVs, joints, indices, morph targets, skins, materials
  and textures are byte-identical. Each quantized accessor records `extras.extaliaQuantization`.

## Campus greenery

Potted plants (`greenery/plant-*.glb`), garden plants (`greenery/garden-*.glb`) and trees
(`greenery/tree-*.glb`), one GLB each of at most 1 MiB (9.6 MB for all 18), are simplified by
`tooling/blender/prepare-greenery.py` from owner-provided downloads listed in
`tooling/blender/campus-greenery.json`: foliage thinned to seeded leaf islands, bark and stems
decimated, textures reduced to 512 px WebP with alpha-masked leaves. They replace the procedural
trees, shrubs and pots once loaded (indoor pots and desk plants, campus and civic-park trees,
the parking planters and the near city parks); `?greenery=procedural` keeps the fallbacks.
Variants, yaw, size and a slight foliage tint are picked from each placement's world position.
The owner confirmed on 2026-11-08 that all 18 greenery models use the existing RenderHub
Extended Use License profile (`LicenseRef-RenderHub-Extended-Use`), not MIT. Their recorded
source archives and CGAxis download history remain in the "Campus greenery" section of
THIRD_PARTY_NOTICES.md. This records owner confirmation, not independent licence verification.
The confirmed entries have no `licenseUnverified` runtime flag.

The same dated owner confirmation applies to the 8 detailed hair models listed in
`tooling/hair-packs.json` and the "Owner-provided hair packs" notice section.
Terms: https://www.renderhub.com/info/3d-content-licensing. Author and product URLs
were not supplied; source archive names remain unchanged.

## Campus vehicles

Each car is one GLB (`vehicles/<style>.glb`), listed in
`tooling/blender/campus-vehicles.json` and exported by
`tooling/blender/prepare-campus-vehicles.py` from a local reference archive:
interior and badges removed, about 6,000 triangles, one instanced wheel template
with four hub markers, no textures. Adding a car is described in
`tooling/blender/README.md`. Their licenses:

- `LicenseRef-RenderHub-Extended-Use`: free RenderHub downloads under RenderHub's
  Extended Use License (owner-confirmed 2026-10-29), the same terms as the
  avatars: https://www.renderhub.com/info/3d-content-licensing. The simplified
  derivatives ship as part of Extalia; they are not offered as a standalone model
  collection and grant no trademark rights.
- `CC-BY-4.0`: Creative Commons Attribution 4.0 (Sketchfab downloads). The
  required credit (title, author, source and licence URL, modifications) is in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- `CC-BY-NC-4.0` and `CC-BY-NC-SA-4.0`: **non-commercial use only**. The derived
  GLB keeps the source licence (ShareAlike derivatives are shared under the same
  CC-BY-NC-SA-4.0) and its runtime catalog entry carries `nonCommercial: true`.
- `LicenseRef-Sketchfab-Standard`: Sketchfab Standard licence
  (https://sketchfab.com/licenses); the derivative ships only inside Extalia.
- The format also recognizes `LicenseRef-Owner-Provided-Unverified` for unresolved
  owner-provided downloads (runtime flag `licenseUnverified: true`). **No vehicle
  in this snapshot has that declaration.** A placeholder notice does not establish
  permission to redistribute a future candidate.

The source archives stay outside the repository. Validation accepts these
licenses only for `vehicles/*.glb` with `third-party-derived` provenance from that
exporter and a matching "Campus vehicles" notice entry with the licence's terms URL;
non-commercial entries must say "non-commercial use only" and unverified ones
"pending owner confirmation" on their own notice line.

### Commercial-assets switch

One build-time switch leaves the non-commercial and unverified cars out of parking
and traffic:

```sh
EXTALIA_COMMERCIAL_ASSETS_ONLY=1 pnpm --filter @extalia/web build
```

The default runtime includes the five registered non-commercial cars; no
unverified-license car is currently registered. The switch filters only the
runtime catalog (`licensedCatalog` in `campusMobilityLayout.ts`). **It does not
omit model files from the package:** every registered vehicle remains in the build
inventory and output. A distribution intended to exclude those assets must change
the source inventory/catalog and rebuild, then verify the actual output. The switch
alone is not a claim of unrestricted commercial rights.

### Daily rotation

Parking and traffic show 12-14 styles a day: a weighted, deterministic subset of
the (licence-filtered) catalog seeded by the local date (YYYYMMDD), with three
electric cars for the charging bays and at least one common conventional car for
traffic. Rare styles (`weight < 1`: sports cars, classics) are drawn less often and
never drive; `trafficOnly` vehicles (the 11 m rigid truck, the stretch limousine)
never park and use only the two lanes without a pedestrian crossing. Only the day's
GLBs are fetched and drawn (three batches per used style). In development,
`?carSeed=<integer>` pins the rotation for tests and screenshots.

The furniture, floor, interior architecture, landscape, district and campus
mobility (chargers, cycle shelter) libraries and the campus parking (east lot and both
access connectors, `create-campus-parking.py`) come from the checked-in
Blender generators named in the inventory.
The building, terrace, elevator and roof exports are project-authored work
approved by the maintainer for redistribution with Extalia. Their original
Blender authoring scene is maintained separately; the reviewed GLBs are the
checked-in distribution sources, exported with `export-building-shell.py`.

After regenerating and reviewing approved local exports, run
`python3 tooling/blender/prepare-public-models.py`. This copies only the explicit
non-avatar inventory, removes empty review scenes and records new hashes. It
does not grant distribution rights to any other local file. Review geometry and
provenance before accepting a changed inventory.

Then run `python3 tooling/prepare-licensed-avatars.py` to retain the reviewed
existing avatar exports. Its pinned source inventory rejects changed input bytes;
it does not generate replacement humans or change the existing rig/wardrobe.
Two identical pairs of body variants share two physical GLBs; ten detailed hair
exports retain the original style fallback. Original full source packs remain local.

Source validation rejects missing, modified, symlinked or unregistered models,
external resources and private filesystem metadata. Production validation also
requires every registered model, this inventory and the license; no model is
inlined. CLI and Desktop packaging repeat the same check on the copied UI.

Unregistered avatar packs remain in the ignored `local-assets/avatars` directory.
Only the explicit development-server mode `local-assets` may add them as
fallbacks. Default Web and Desktop builds use the same registered Blender avatars,
regardless of extra local files on the build machine. Their third-party assets
are not offered as a standalone model collection or relicensed under MIT.


Modular wardrobe pieces under `avatars/wardrobe/<male|female>/<top|bottom|outer>/` retain
owner-provided original GLB garments and native textures, fitted to the matching body. Tops,
bottoms and outer layers can be mixed independently. Each registered source garment retains
its CC-BY-4.0 attribution; any added avatar skin/context retains its separate RenderHub licence.
The exact exporter, hash and component licensing are recorded in `models.json` and
`THIRD_PARTY_NOTICES.md`. Unreviewed conversions remain local and cannot become outfit choices.
