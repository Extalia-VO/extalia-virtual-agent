# Static library optimization handoff

Base: PR #107 head `283f64225fc837d410c06308a30f23d35f35cb57`.
No push, no PRD edits, no local user checkout changes. Original files remain in isolated source checkout.

| Asset | Original bytes | Final bytes | Triangles before → after |
|---|---:|---:|---:|
| furniture/interior-library.glb | 4,704,920 | 1,885,152 | 159,184 → 59,908 |
| landscape/exterior-landscape.glb | 3,945,096 | 2,899,736 | 78,856 → 56,562 |
| landscape/district-buildings.glb | 3,238,616 | 2,300,424 | 32,168 → 32,168 |

Attribute-aware meshoptimizer simplification: ratio target 0.1, relative error bound 0.01, normals/UV/color weighted. Size is NOT a safety criterion. District geometry rejected further simplification under this bound; only 384 exact duplicate vertices welded. Other static files retain hard-normal/UV seams; do not promise all assets <2 MB.

UVs pack to standard normalized Uint16 (maximum absolute error <0.000008), district vertex color to normalized Uint8 (<0.002 linear channel error). Positions and normals remain Float32. No removed UV sets, textures, nodes, materials, markers, or runtime decoder requirement. Retained position/normal values and light fixture triangle order checked exactly. UV/color quantization is bounded, not lossless.

Visual review: Blender Cycles CPU contact sheets for all named roots from front/upper and rear/upper angles. No lost components/material changes identified. Initial 1% candidate had visibly faceted small lamp shade. Final protects seven meshes comprising complete floor-lamp and pendant-light: +40,284 bytes and +1,834 triangles, improving quality while staying under2MB. No claimed FPS result.

Tests: native Three.js GLTFLoader parses all three; names and userData match source exactly; applyMatrix4 on Float32 geometry, finite attribute checks and mergeGeometries pass. Source asset/nodes/materials/scenes metadata exact through pipeline; packing asserts every expanded triangle attribute error is within bound. This is loader/geometry QA, not a browser interaction/end-to-end benchmark. GPU frame timing and laptop testing still required.

Reproduce from base assets:
`python3 tooling/optimize-static-libraries.py --output-dir /tmp/static-candidates --report /tmp/static-report.json`
Requires NumPy, Node, pinned meshoptimizer1.1.1, and existing compact-garment-buffers.py / simplify-garment-meshes.mjs helpers.
`node tooling/test-static-candidates.mjs /tmp/static-candidates`

Integrate three GLBs and two tooling files. Parent handles all manifests/hash/size records, version and changelog, shared verification, and publishing. Do not include this QA folder/large rendered sheets in repo unless desired.
