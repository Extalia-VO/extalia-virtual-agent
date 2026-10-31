# Public Office models

The 2026-10-31 inventory snapshot contains **106 models**: 17 project-authored
scene models, 12 retained body/hair exports, 32 fitted outfits/wardrobe pieces and
45 simplified campus vehicles. Their registered GLB bytes total **691,568,420**
(about 660 MiB before packaging compression); this is asset size, not measured
startup cost or runtime memory. Web, Desktop and the npm Bridge share the inventory.
Exact hashes, sizes, declared licenses and provenance are in [models.json](models.json).

The declared-license counts are MIT 17, RenderHub Extended Use 23, CC-BY-4.0 57,
CC-BY-NC-SA-4.0 4, CC-BY-NC-4.0 1 and Sketchfab Standard 4. The project's
[MIT license](LICENSE.md) does not replace third-party terms. Retained avatars,
source garments, generated additions and derived vehicles keep the component
terms described in [AVATAR_SOURCE_LICENSE.md](AVATAR_SOURCE_LICENSE.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Inventory validation checks
these recorded declarations and bytes; it is not an independent grant of rights.

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
