# Garment fit and storage review — 2026-11-06

Status: verified locally in v0.4.176. Scope: all 32 published outfit and wardrobe files.

## Findings and corrections

The previous layer-conformance pass changed anatomical skin to follow nearby clothing. A waist vertex could inherit a sleeve's arm binding; other arm vertices were moved onto the torso. On the belted top, a 2.1 cm skin edge grew to 61.1 cm in a seated arm pose. Sixteen captured production bone poses reproduced this independently. Restoring only the skin's positions, normals, influences and morph deltas from the previous export removed the sheet deformation; clothing, textures and UVs remain intact. `repair-garment-skin.py` checks topology and storage isolation, including sparse morphs. `garment-layers.py fix` now excludes skin.

Fit used to be measured against the scanned outfit as well as skin. The full anatomical `ReferenceBody` showed several tops still standing 5–9 cm off the chest or belly. Eleven explicitly recorded recipes in `tooling/blender/garment-refit.json` draw loose panels closer and lower seven head-adjacent collars/hoods. Canonical neck backing fills the newly exposed region; only original skin demonstrably covered by that loaded backing is suppressed. The gothic blouse's front chest p95 clearance falls from 5.7 to 3.7 cm; the oversized shirt from 9.0 to 6.4 cm, retaining its relaxed cut.

At assembly time, conservative skin filtering uses actual opaque trouser surfaces at the pelvis/upper thighs. Skirts and dresses are excluded by garment identity; necks, hands, exposed shorts hems and shared source attributes are retained. Ray trousers keep their authored alpha shell and gain a dark inner cloth layer with the same bindings and drape targets. The lining is also the opaque coverage surface.

## Storage

Decoder-free lossless buffer repacking reduces the garment set from approximately **94.74 MB to 90.02 MB**. **16 of 32** files meet the target of at most 1,000,000 bytes. It removes dead storage, deduplicates exact payloads, tightly packs interleaved accessors and represents zero morph rows sparsely. Every decoded accessor, image and material is checked for equivalence. No additional runtime decoder or texture loss is introduced.

Exact vertex welding was also investigated for the five largest models using every attribute and morph delta. It would save only 48 bytes: their vertices are already distinct. The remaining large garments require a separately reviewed geometric reduction to reach 1 MB. The black suit remains about 20.40 MB; forcing that model below 1 MB would substantially change its detailed geometry.

## Per-file inventory

Sizes are decimal MB. The last column is the worst number per captured pose of skin edges shorter than 9 cm at rest that grow beyond 25 cm; it measures the reproduced sheet regression, not all possible cloth intersections. Each individual item was rendered with a representative companion outfit in standing, walking and seated/typing poses. Counts include companion pieces, so a failure on a bottom's row may originate in the paired top.

| Published garment | Before MB | After MB | Stretched skin edges, before → after |
| --- | ---: | ---: | ---: |
| `outfits/female/bartender-uniform.glb` | 0.289 | 0.289 | 96 → 0 |
| `outfits/female/outfit-original-dress.glb` | 2.810 | 2.810 | 430 → 0 |
| `outfits/female/outfit-source-denim-dress.glb` | 2.470 | 2.327 | 0 → 0 |
| `outfits/female/outfit-source-jumper-skirt.glb` | 1.277 | 1.254 | 393 → 0 |
| `outfits/female/reception-uniform.glb` | 5.990 | 5.990 | 368 → 0 |
| `outfits/male/bartender-uniform.glb` | 2.687 | 2.634 | 0 → 0 |
| `outfits/male/outfit-black-business-suit.glb` | 22.821 | 20.398 | 16 → 0 |
| `outfits/male/outfit-mens-two-piece-suit.glb` | 1.090 | 0.783 | 0 → 0 |
| `outfits/male/outfit-printed-hoodie-jeans.glb` | 0.659 | 0.608 | 1 → 0 |
| `outfits/male/outfit-prom-suit.glb` | 0.997 | 0.878 | 0 → 0 |
| `outfits/male/outfit-sweatshirt-jacket-workwear.glb` | 10.913 | 10.857 | 69 → 0 |
| `outfits/male/outfit-victorian-bartender.glb` | 7.741 | 7.741 | 58 → 0 |
| `outfits/male/reception-uniform.glb` | 0.298 | 0.298 | 0 → 0 |
| `wardrobe/female/bottom/short-jeans.glb` | 1.657 | 1.657 | 134 → 0 |
| `wardrobe/female/bottom/source-gothic-skirt.glb` | 2.901 | 2.896 | 134 → 0 |
| `wardrobe/female/bottom/source-gothic-trousers.glb` | 0.330 | 0.330 | 134 → 0 |
| `wardrobe/female/bottom/source-ray-trousers.glb` | 0.234 | 0.219 | 134 → 0 |
| `wardrobe/female/outer/cloth-jacket.glb` | 0.384 | 0.384 | 0 → 0 |
| `wardrobe/female/outer/source-leather-cloak.glb` | 0.457 | 0.457 | 0 → 0 |
| `wardrobe/female/outer/source-overcoat.glb` | 0.859 | 0.859 | 26 → 0 |
| `wardrobe/female/outer/source-ray-vest.glb` | 0.104 | 0.101 | 134 → 0 |
| `wardrobe/female/outer/source-red-leather-jacket.glb` | 1.924 | 1.098 | 0 → 0 |
| `wardrobe/female/top/source-belted-top.glb` | 0.676 | 0.676 | 150 → 0 |
| `wardrobe/female/top/source-female-cloth1.glb` | 0.910 | 0.910 | 450 → 0 |
| `wardrobe/female/top/source-flame-hoodie.glb` | 10.667 | 10.013 | 0 → 0 |
| `wardrobe/female/top/source-gothic-blouse.glb` | 3.152 | 3.152 | 245 → 0 |
| `wardrobe/female/top/source-oversize-shirt.glb` | 0.317 | 0.317 | 0 → 0 |
| `wardrobe/female/top/source-pink-hoodie.glb` | 4.030 | 4.029 | 134 → 0 |
| `wardrobe/female/top/source-ray-underlayer.glb` | 0.322 | 0.298 | 228 → 0 |
| `wardrobe/male/bottom/jeans.glb` | 0.303 | 0.281 | 57 → 0 |
| `wardrobe/male/outer/denim-jacket.glb` | 1.506 | 1.506 | 12 → 0 |
| `wardrobe/male/top/green-white-hoodie.glb` | 3.968 | 3.968 | 57 → 0 |

## Verification

- All 32 files rendered through the production character components in three poses (96 views); no page exceptions or skin-sheet stress failures in the corrected run. The initial run's worst pose had 450 offending edges.
- Synthetic tests cover sparse/zero/interleaved storage repair, protected cloth/image bytes, native Three.js loading, conservative trouser coverage, lining preservation, native neck coverage and failed-load feature handling. Developer Python checks use explicit `EXTALIA_TEST_PYTHON`; application use and ordinary CI do not require Python.
- Per-file source/model hashes and byte counts are refreshed. Source material/image receipts and corner UVs remain verifiable.
- Additional 24 views at 145/195 cm cover isolated top-only, bottom-only, hoodie/trouser and lined-trouser combinations in the same three poses: no page exceptions or sheet-stress failures. Integrated `pnpm check` passed: 5,488 TypeScript tests, 453 Rust tests, lint/boundaries/type checks, asset verification and Web/Desktop/CLI builds. Three TypeScript suites/23 tests are skipped by their existing or explicit developer-tool prerequisites; the opt-in Python repair/compaction checks were also run separately.

One companion combination and sampled poses per file do not exhaust every wardrobe combination, animation phase or camera angle. Restoring anatomical skin and preventing future cloth-to-skin reweighting addresses the reproduced cause; individual source cuts and intentionally open hems remain recognizable.
