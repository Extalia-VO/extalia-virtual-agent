# Conservative garment mesh reduction

Baseline: `8fc739e5f3b574e8b6555844910e88040d8c7ff2` (v0.4.294).
This pass reduces geometry, not image resolution. The four accepted GLBs total
49,009,656 → 26,636,696 bytes (45.7% less) and 1,404,595 → 587,123 triangles
(58.2% less). These are full-file mesh counts, **not rendered frame counts or an
FPS measurement**. Material/primitive counts are unchanged; this does not itself
reduce each avatar's draw-call count.

| Asset | Bytes before | Bytes after | Triangles before | Triangles after |
| --- | ---: | ---: | ---: | ---: |
| Black business suit | 20,397,732 | 9,462,408 | 666,717 | 190,833 |
| Sweatshirt/jacket workwear | 10,857,156 | 6,896,760 | 312,068 | 185,778 |
| Victorian bartender | 7,741,352 | 2,321,216 | 198,678 | 47,584 |
| Flame hoodie | 10,013,416 | 7,956,312 | 227,132 | 162,928 |

Exact paths, hashes and per-primitive results are in
[the machine-readable receipt](garment-mesh-reduction.json).

## Why not force one megabyte?

An earlier aggressive bartender candidate reached about 1.5 MB but introduced
visible shirt-through-vest artifacts, so it was rejected. Size is not the acceptance
criterion. The female reception uniform candidate saved only about 3%, so the
original was kept rather than introducing geometry changes for a marginal saving.
Lossless buffer compaction found no further savings in the original clothing set.

The business suit contained many 1–3 cm accent/button primitives with approximately
27,120 triangles each. The accepted pass simplifies such small, named accents more
than the large fabric surfaces. Fabric uses a conservative normalized geometric/
attribute error bound of 0.001; small accents use 0.05. These are algorithmic error
metrics, not guarantees of millimetre-level error for every deformed pose.

## Preservation and validation

- Offline meshoptimizer 1.1.1, pinned as a direct development dependency. No new
  runtime decoder or dependency is needed.
- Boundaries are locked. Normals, UVs and dense bone-weight channels inform collapse
  selection. The simplifier only chooses retained original vertices; their stored
  position, normal, tangent, UV, joint and weight component bytes stay exact.
- Embedded images, material graphs, skeleton/joint metadata, inverse bind matrices,
  node hierarchy, licenses and attribution are preserved. Motifs are not downsampled.
- Morph-target and animated inputs are refused rather than approximated. None of
  these four selected inputs has morph targets or embedded animation clips.
- Both model manifests are refreshed. The source garment `fittedSHA256` values still
  identify the original reviewed fitting stage; the new receipt explicitly records
  the subsequent simplification input and output hashes. Original fit approvals
  are not presented as new full-application approval.
- Synthetic Python regressions and a production Three.js GLTFLoader skin-loading
  test passed. Public-model verification passes for all 133 registered models.

## Visual review and limits

Blender 4.3.2 CPU Cycles, 16 samples, 512 × 512 per panel, identical synthetic
rest/walk/sit/reach poses and lighting. Baseline is left, candidate is right.
No obvious new holes, silhouette changes or motif loss were observed in the
front and rear comparisons below. Existing baseline defects, including some rear
bartender shoulder gaps and extreme reaching distortions, remain and are not
claimed fixed by this pass.

| Garment | Front | Rear |
| --- | --- | --- |
| Business suit | [Comparison](garment-mesh-reduction/outfit-black-business-suit-front.jpg) | [Comparison](garment-mesh-reduction/outfit-black-business-suit-rear.jpg) |
| Workwear | [Comparison](garment-mesh-reduction/outfit-sweatshirt-jacket-workwear-front.jpg) | [Comparison](garment-mesh-reduction/outfit-sweatshirt-jacket-workwear-rear.jpg) |
| Bartender | [Comparison](garment-mesh-reduction/outfit-victorian-bartender-front.jpg) | [Comparison](garment-mesh-reduction/outfit-victorian-bartender-rear.jpg) |
| Flame hoodie | [Comparison](garment-mesh-reduction/source-flame-hoodie-front.jpg) | [Comparison](garment-mesh-reduction/source-flame-hoodie-rear.jpg) |

These are **isolated garment tests**, not live Office screenshots. They do not
certify body removal, runtime corrective morphs, IK, furniture contact, every
avatar combination or native macOS/Windows/Linux rendering. Runtime performance
and full-body visual review remain required before claiming a frame-rate gain or
merging. The comparison images retain the underlying garment licenses and credits
in [the asset notices](../../apps/web/public-assets/THIRD_PARTY_NOTICES.md).

## Reproduce

Use an unchanged baseline checkout as the input. NumPy is an offline tooling
prerequisite; ordinary application use does not need Python or Blender.

```sh
pnpm install --frozen-lockfile
python3 tooling/simplify-garment-meshes.py --output-dir <review-directory> --report <report.json>
EXTALIA_TEST_PYTHON=python3 pnpm exec vitest run tooling/test/simplifyGarmentMeshes.test.ts
blender -b --factory-startup --python-exit-code 1 --python tooling/blender/review-garment-reduction.py -- \
  --input <baseline-or-candidate.glb> --output-dir <image-directory>
# Repeat with --rear and with the matching baseline/candidate.
```

The simplification command writes candidates only, never overwrites the source
assets or updates a manifest. A second invocation on already reduced files is
not a regeneration of this baseline comparison. Match source hashes in the receipt.
