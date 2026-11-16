# Seven remaining garment reductions

Baseline: PR #107 commit `283f64225fc837d410c06308a30f23d35f35cb57`. All sizes below decimal MB.

| Asset | Before MB | After MB | Before triangles | After triangles |
|---|---:|---:|---:|---:|
| `avatars/wardrobe/male/top/green-white-hoodie.glb` | 3.968 | 1.819 | 116,010 | 45,056 |
| `avatars/wardrobe/female/top/source-flame-hoodie.glb` | 7.956 | 6.157 | 162,928 | 110,756 |
| `avatars/wardrobe/female/top/source-pink-hoodie.glb` | 4.029 | 1.518 | 117,711 | 35,377 |
| `avatars/wardrobe/female/top/source-gothic-blouse.glb` | 3.152 | 1.508 | 83,703 | 29,111 |
| `avatars/outfits/male/outfit-sweatshirt-jacket-workwear.glb` | 6.897 | 4.303 | 185,778 | 104,320 |
| `avatars/outfits/male/outfit-black-business-suit.glb` | 9.462 | 7.943 | 190,833 | 144,273 |
| `avatars/outfits/female/reception-uniform.glb` | 5.990 | 5.390 | 135,660 | 115,446 |

Total:41.455→28.638MB (30.9% reduction);992,623→584,339triangles (41.1% reduction).

## Method and safeguards
- Offline meshoptimizer1.1.1, target ratio0.05, relative error0.003, attribute-aware normals/UV/skin weights, locked borders. This target is bounded by error and is not a promise of95% removal. Existing named tiny Accent rule remains.
- Ordinary GLB, no runtime Draco/Meshopt/KTX2 or quantization requirement.
- Authored nodes/materials/textures/samplers/scenes retained; image payloads, retained vertex attributes, inverse bind matrices exact.
- Reception excludes `OriginalTop_Reception4` and `OriginalTop_Reception9`. Unrestricted candidate removed local disconnected pieces, measured by one-way surface audit up to0.1146model units. Final maximum sampled deviation0.00580model units. These two primitives are byte-exact, not merely visually similar.
- Larger flame/workwear/business/reception were not forced to1–2MB. Error0.006 exploratory candidates remain unshipped, because further quality compromise is unnecessary for current conservative delivery.

## Validation
- Five Python regression tests passed including protected mesh and material exactness and invalid selection rejection.
- Seven GLBs parsed by Three GLTFLoader without any decoder; all skinned meshes present. Node test stubs image bitmaps and does not validate rendered texture decode.
- Blender Cycles rendered front and rear for rest/walk/sit/reach, baseline and candidate:112images reviewed in contact sheets. No new obvious silhouette or garment-hole regressions at512px test resolution. Minor shading smoothing appears on some folds; pre-existing jagged cuff/underside boundaries remain. Reception final8candidate images rerendered after exclusion fix.
- One-way nearest-surface sampling of referenced baseline vertices, up to1000per primitive, under CPU skinning. Diagnostic only, not Hausdorff or self-intersection guarantee. Distances in report are model units.
- These are isolated garments with diagnostic poses, not full runtime body fit, IK, collision, or chair tests. No hardware FPS measurements or100FPS claim.

## Reproduce
Run the updated simplifier on baseline assets with `--ratio 0.05 --error 0.003`, exact paths above via repeated `--only`, an external `--output-dir`, and `--report`. Run reception separately adding `--exclude-material OriginalTop_Reception4 --exclude-material OriginalTop_Reception9`.
Run `python tooling/test/simplify-garment-meshes_test.py`.
Use `tooling/blender/review-garment-reduction.py --input FILE --output-dir DIR` with Blender; repeat with `--rear`.
