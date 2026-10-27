# Blender workstation furniture and panoramic displays

Ordinary and touchdown desks use a 60 mm honey-oak top with rounded edges,
slim ivory legs, a recessed frame and levelling feet. Reusable devices and
accessories share graphite, teal and ivory materials: monitor shells and stands,
laptop deck and lid, full/compact keyboards, mouse and pad, organizers, books,
mini shelves, plants, flowers and a decorative lamp.

## Authoring and runtime

`tooling/blender/create-workstation-set.py` reads
`apps/web/src/office/scene/interior/workstationAssetProfile.json`. Run Blender in
background mode with `--python` and pass `--output <directory>` and optionally
`--preview <png-path>` after `--`. The editable source, GLB and dimensions manifest
are generated under ignored `apps/web/local-assets/furniture/`. The local library
has 22 named roots, 45,274 triangles and approximately 1.3 MB of geometry/materials.
No third-party model is used. Generated model binaries stay local under repository
policy; a clean checkout uses procedural geometry until the script is run.

`WorkstationPart.tsx` loads the library once, shares immutable geometry/materials,
and clones only transforms and materials requiring wood customization or live lamp
emission. Dynamic roots exclude temporary backups from static floor batching.
Original procedural parts remain available while loading, on a failed request or
for a missing root; `?workstations=procedural` forces them.

The authored pieces replace furniture and hardware only. Runtime screen textures,
agent bindings, status lights, glow and screen emitters remain live. Keyboard key
centres and cap heights, mouse dimensions and semantic input frames are preserved.
Ordinary/touchdown desk tops stay at 0.785 m. The library also supplies shared
hardware/accessories to team, executive and reception workstations. Decorative
lamp diffusers use the existing interior-light factor, including manual overrides.

## Monitor placement

`monitorBankLayout` places two or three external monitors with equal screen sizes,
matching base/panel heights, symmetric side angles of 0.12 radians and an 8 mm gap
between their front bezel edges. Geometry accounts for bezel width and housing
depth, so yawing a complete bank preserves its seams. It is used for ordinary dual
screens, team dual screens, the executive triple bank and reception twins.
The mixed monitor/laptop pod retains its independently positioned devices.

## Validation

- Imported GLB tests check all 22 roots, origins, desk height, monitor shell bounds,
  unobstructed live-picture planes, every keycap top and actual mouse bounds.
- Geometry tests check panoramic seams at ordinary, diagonal pod and reversed
  executive orientations, equal dimensions and reception stand support.
- Browser review covers ordinary dual-monitor/laptop, touchdown, all four pod
  variants, reception twins and executive triples. All sampled authored parts load;
  keyboard/mouse semantic contacts match seated avatar goals within 3e-16 m.
- Aborting the binary library request preserved the complete ordinary dual-monitor
  desk, two live screens and exact input contacts. Restoring the request loaded all
  authored pod parts again. The lamp diffuser measured 1.35 emission intensity in
  daylight, 3.1 at night and 0 with the manual light override off.
- Review screenshots are ignored under `output/playwright/`, including
  `workstation-single-dual-monitor-updated.png`,
  `workstation-executive-bank-updated.png` and `workstation-blender-preview.png`.

- Full `pnpm check` for v0.4.77 passes: lint, dependency boundaries, public-safety,
  typecheck, 214 suites / 2,280 tests (one skipped), Rust checks, Web/Desktop builds,
  synchronized versions and local avatar-asset checks. The Node-only imported-GLB
  checks live under `tooling/blender/`; browser-side tests remain free of Node APIs.
- Independent focused Codex Sol review reported no actionable findings in asset
  ownership/disposal, fallbacks, placement or monitor-bank geometry. Hermes was
  unavailable before execution, so no external worker ran or changed files.

No Desktop startup test was performed against a real user profile.
