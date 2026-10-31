# Asset intake map

Status of third-party 3D downloads waiting to become public, simplified Extalia models. The
downloads live in the owner's local `assets-temp/` folder (never committed); every processed
model goes through Blender (scripted, reproducible) into `apps/web/public-assets/` with an entry
in `models.json` and a credit in `public-assets/THIRD_PARTY_NOTICES.md`.

Order agreed on 2026-10-29: **cars first**, then the other groups one at a time.

## Rules for every group

- Only what the Office needs: no interiors, no hidden geometry, no source textures unless a
  group needs them; brand logos, names and plates removed.
- Budgets per model are set per group before processing (triangles, bytes, draw calls) so the
  Office keeps > 40 FPS.
- Licence: the owner confirmed on 2026-10-29 that every download is a free RenderHub item under
  RenderHub's Extended Use License (commercial and non-commercial use; full terms in RenderHub's
  3D Content Licensing Agreement), recorded as `LicenseRef-RenderHub-Extended-Use` like the
  avatars. Exception: the Huracán GT3 comes from Sketchfab under CC-BY-4.0 (credit required).
  Only simplified derivatives built by the project scripts are published, never the source
  archives or textures.
- Nested archives: several downloads contain `.rar` files; extract with `bsdtar` (libarchive)
  into a fresh scratch folder, never inside the repository.

## Groups

| Group | Archives | Size | Usable formats | Licence evidence | Target in the app | Stage |
| --- | --- | --- | --- | --- | --- | --- |
| Cars, EV | Tesla Model 3 2024 (low + high poly), Xiaomi YU7 2025, Leapmotor C01 2024, Li Auto MEGA 2024 | ~470 MB | FBX, OBJ, BLEND, MAX | RenderHub Extended Use (owner-confirmed) | Parking (EV bays), traffic, later character vehicles | **1 — in progress** |
| Cars, conventional | Huracán GT3 EVO, BAIC BJ40, Polestar 1 2019, Fiat 500, SsangYong Rodius 2010, Honda Odyssey 2021 | ~415 MB | GLTF, GLB, BLEND, FBX, OBJ, 3DS | Huracán: CC-BY-4.0 (attribution); others RenderHub Extended Use | Parking, traffic | **1 — in progress** |
| Hair, male | Afro hairstyle | 1.4 MB | BLEND | RenderHub Extended Use | New male hairstyle (hair-card pipeline `tooling/convert-detailed-hair.py`) | 2 |
| Hair, female | Long straight hair (free), bun with bangs (next-gen, PBR) | ~400 MB | nested RAR/ZIP: FBX, OBJ, BLEND, Maya, Unity | RenderHub Extended Use | New female hairstyles | 2 |
| Clothing, female | 7 RenderHub archives (vest sample, white dress, skirt and shirt, cowgirl set, sports outfit, relaxed streetwear set, outfit 4) plus 30 Sketchfab GLBs | ~1.1 GB | FBX, OBJ, GLB, Marvelous Designer (ZPRJ), nested RAR/ZIP | RenderHub Extended Use (owner-confirmed); Sketchfab CC-BY-4.0 per file (`asset.extras`) | 28 wearable outfits `avatars/outfits/female/outfit-*.glb` (catalog `tooling/blender/avatar-outfits.json`); school uniforms, cloak, sheer mesh dress, shorts-only and one cheongsam skipped with reasons; the receptionist suit is reserved for the staff uniforms | **3 — done** |
| Clothing, male | 9 Sketchfab GLBs, 4 owner zips | ~380 MB | GLB, FBX | CC-BY-4.0; Sketchfab Standard (apparel pack, jeans); owner zips pending (no licence file) | 8 wearable outfits `avatars/outfits/male/outfit-*.glb`; bartender sets reserved for the staff uniforms; apparel pack, jeans, business suit, denim jacket, workwear and camouflage set skipped with reasons | **3 — done** |
| Characters, male | Asian old man; animated dancer (`rp_` = RenderPeople) | ~470 MB | nested ZIP/RAR: FBX, MAX, C4D, Maya | RenderHub Extended Use (owner-confirmed); the dancer carries a RenderPeople `rp_` name — keep its credit | New body types / ambient characters | 4 |
| Furniture | Two-seat modern sofa (RenderHub), bar stool | ~114 MB | nested RAR: OBJ, FBX | RenderHub Extended Use | Lounge and pantry furniture | 5 |
| Faces, decorations, outdoor, plants, trees | — (folders empty) | — | — | — | Reserved | — |

## Per-group processing notes

- **Cars:** catalog-driven (`tooling/blender/campus-vehicles.json`), smooth shading on a
  simplified shell, separate wheels for spinning, lamp roles for night lighting.
- **Hair:** reuse the existing hair-card converter and `catalog.json` checks; match the avatar
  rig (20-joint `AvatarLiteRig`) and fit to the skull of the target body.
- **Clothing:** `tooling/blender/prepare-avatar-outfits.py` (see `tooling/blender/README.md`, Avatar
  outfits) re-weights to the avatar rig from the body, split tintable zones (top, outer,
  accent, trim, bottom, shoes, lining) like the existing scan outfits.
- **Characters:** decide per model whether it becomes a full body (retarget to the rig) or a
  static ambient prop; check licence first.
- **Furniture:** simplify to the furniture budget used by `create-interior-library.py` assets.
