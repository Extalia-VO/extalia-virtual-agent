# Blender office chairs

The task and executive work chairs are authored with Blender by
`tooling/blender/create-office-chairs.py`. Run Blender in background mode with
that script to generate the editable `office-chairs.blend`, two GLBs and a
manifest in ignored `apps/web/local-assets/furniture/`. Optional arguments after
`--` are `--output <directory>` and `--preview <png-path>`.

The new model has contoured lumbar upholstery, rounded seat and arm pads,
an adjustable-height column, a tilt housing and five radial twin-wheel casters.
The executive variant has a taller back and a head cushion. Authored colors
retain blue-grey task upholstery and warm executive upholstery. No external
model or texture is required to reproduce these assets.

## Runtime integration

`chairModels.ts` discovers the local GLBs and loads each once. `chairGeometry.ts`
bakes child transforms, smooth normals and material colors into one shared
geometry per variant. Workstation chairs retain one instanced draw per variant
and floor, driven by the existing slide/swivel matrices. Meeting and reception
chairs share the same geometry. Static chair roots stay outside floor-wide
static batches so their temporary procedural meshes disappear after loading.

Without local assets, or after a load failure, procedural chairs remain available.
`?chairs=procedural` forces that backup for review. Generated models remain local,
following the repository's model-file policy; a clean checkout needs to run the
Blender script to display the authored version. Web and Desktop share this renderer.

The floor origin and +Z facing direction are unchanged. Triangle raycasts measure
the seat top at 0.460 m and both arm pads at 0.710 m high, x=±0.280 m, z=0.035 m.
Task/executive heights are 1.120/1.300 m. The rear grip surface at x=0.19 m,
y=1.0 m is within 4 mm of the choreography contact. The wheel base fits within
the existing 0.72 m clearance diameter.

## Review evidence (v0.4.75)

- Blender 5.1.2 generated and rendered both editable variants. GLBs are approximately
  209/213 KiB, with 8,356/8,544 triangles after the runtime bake.
- Browser review used actual imported geometry, a detailed male avatar entering
  through the right opening, and a detailed female avatar using the left opening.
  Pull, entry, lowering, seated, standing, exit and push beats completed on both
  sides. Instance matrices matched the mover within 4.8e-8.
- Triangle raycasts verified the exported seat, arm-pad and rear-grip positions.
- A seated detailed female avatar was reviewed at the executive workstation.
- A cold application load replaced 51 moving and 25 static chairs across all
  three floors. Static roots contained only their authored mesh after loading.
- Aborting both GLB requests retained all 51 moving and 25 static procedural
  chairs. Restoring the requests and reloading returned to the authored models.
- Focused geometry/seat/choreography checks: five suites, 30 tests passed.
  Full check passed: 211 suites, 2,270 tests passed, one skipped; Rust checks and
  Web/Desktop builds passed. Cold-load/fallback review is recorded in the PRD tracker.

Development captures are in ignored `output/playwright/`: `chair-blender-preview.png`,
`chair-blender-seated-task.png`, `chair-blender-seated-executive.png` and
`blender-chair-<side>-<beat>.png`.
The earlier avatar garment deformation and terminal-finger limitations are separate
from chair geometry. Desktop was built using the shared renderer; no startup test
against a real user profile was performed.
