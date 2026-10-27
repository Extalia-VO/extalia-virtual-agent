# Four-person Blender work desks

The reviewed desk has four concave circular seating bays with a 0.85 m radius,
a 60 mm oak top, slim steel legs at the midpoints between chairs, a recessed
cross-frame, levelling feet and a narrow central cable spine. Four low glass
dividers have rounded corners and eight compact metal clamps. Glass spans
0.835–1.180 m vertically, with 23% opacity. The frame leaves the diagonal
kneespace open; the desktop underside at 0.742 m clears the chair arm pads by 32 mm.

## Authoring and integration

Run Blender in a separate background process with
`--python tooling/blender/create-team-pod-desktop.py`. Optional script arguments
after `--` are `--output <directory>` and `--preview <png-path>`. The editable
`.blend`, GLB and manifest are generated in ignored `apps/web/local-assets/furniture/`.
The approximately 241 KiB GLB contains the complete fixed structure; chairs,
devices and accessories stay in the renderer. No third-party model is used.

`teamPodDesktopProfile.json` supplies the dimensions to both Blender and the
procedural geometry. `TeamPodDesktop.tsx` loads one shared asset and clones its
object transforms for each pod, retaining shared geometry and materials.
Dynamic roots keep temporary backups out of floor-wide static batches. The
old storage-block legs, oversized central column and full-span glass are removed
from `TeamPod4.tsx`, so the imported model does not overlap them.

A matching procedural structure remains available without local models or after
a failed request; `?desks=procedural` forces it. Generated model files remain local
under repository policy. A clean checkout needs the Blender script to reproduce
the authored version. Desktop and Web use the same renderer.

## Seating and devices

The deeper bays move seats and inputs 0.32 m toward the desk centre together,
preserving the approximately 0.399 m nominal keyboard reach. The resource registry
uses the new seat anchors, while its approach offsets preserve the original aisle
waiting points. The shared profile also supplies desk height to avatar hand goals.

All monitor configurations move inward. The mixed monitor/laptop stand is offset
away from the pointer area; laptop-only stands are behind external keyboards.
Random keyboard and pad placements retain support on the surface, and monitor/
laptop stands have at least a 25 mm separating axis gap from sampled input footprints.

## Validation (v0.4.76)

- Blender 5.1.2 authored and rendered the complete structure. The exported glass
  uses GLTF alpha blending at 0.23; runtime disables its depth writes and shadow casting.
- Actual imported triangles were raycast in the browser: the seating bay is open,
  input support is at y=0.802 m, and each model has four slim legs, four glass panels
  and eight clamps. No studio floor, light or camera is in the runtime export.
- A detailed seated female avatar and a top view of all four device variants were
  reviewed. Rendered keyboard/mouse contacts matched avatar goals within 3e-16 m
  in the sampled dual-monitor seat. Screens moved farther from the inputs.
- Support tests cover all 16 authored pod seat IDs and 500 stable randomized layouts;
  stand/input separation tests cover all four device variants and 100 arrangements.
  Ten focused suites / 173 tests pass, including chair, navigation and door-liveness
  checks after preserving aisle staging.
- Full `pnpm check`: 212 suites, 2,274 tests passed, one skipped; Rust checks,
  Web/Desktop builds, versions and local-avatar checks pass.
- Aborting the GLB request showed four complete procedural desks in the actual
  office, each with four legs and four glass dividers, with open bays and retained
  input support. Restoring the request and reloading replaced all four with
  complete Blender models (four legs, four glass panels and eight clamps each).

Ignored review captures: `output/playwright/pod-blender-preview.png`,
`pod-blender-seated.png` and `pod-blender-top.png`. No Desktop startup test was
performed against a real user profile. Existing source-avatar garment/finger
limitations are outside this furniture update.
