# Finished-floor contacts

The floor origin is the finished walking surface on F1, F2 and F3: local Y=0,
with world elevations 0, 6.4 and 12.8 metres. Characters, furniture feet, door
thresholds and navigation already use those elevations. Previously, finish
thickness and extra corridor offsets raised surfaces by 6–10.5 cm above them.

## Geometry and Blender source

`FloorFinish` now places its thickness below its origin. Room and corridor tops
and their edge inlays share the walking datum; broad underlayers sit 2 mm below
to avoid coplanar surfaces. Structural slabs reserve the upper 8 cm for finishes
while retaining their original underside at −32 cm, so ceiling and stair
alignment are preserved. Rounded campus clipping and stair openings remain in
the existing footprint geometry.

`tooling/blender/create-floor-panel.py` generates an editable local
`apps/web/local-assets/floors/floor-panel.blend`, a 2.2 KB GLB and a bounds
manifest. The closed, UV-mapped unit panel has its top at zero and thickness
below it. The app shares its normalized geometry and retains the existing oak,
stone, tile, carpet and access-floor materials. Perimeter panels retain runtime
clipping to the rounded building profile. Missing, invalid or failed assets and
`?floors=procedural` use the same corrected procedural geometry. A keyed local
batch replaces geometry after loading without leaving stale floor batches.

Area rugs now rest on the floor with a 6 mm pile rather than floating above the
old finish. Lobby medallion faces lie within 0.5 mm of the surface; the runner
and borders are flush inlays. Fitness uses one stone base and exercise-zone
rugs, removing the overlapping aisle finish. Server rack positions now denote
the supporting floor; the Blender console-table legs extend to that floor too.
The intentionally raised yoga-mat platform retains its matching pose targets.

## Verification

Focused tests inspect actual floor component trees across all three levels,
slab undersides, rugs, lobby inlays, rack positions and the fitness floor layers.
Blender export tests inspect unit bounds, normals, UVs and invalid-model rejection.
Existing rounded-footprint and natural-walking regressions also pass.

The mounted Office was checked in campus and individual-floor views: 37 finish
groups use the local model, all finished tops match their floor origin (or the
2 mm underlayer), and 76 static/instanced work chairs have bottoms at their floor
datum. Sampled cabinets, bookcases, coffee tables, three server racks and the
console table are grounded. Six source avatars in standing/seated review poses
have minimum skinned vertex heights within 1 mm of their local floor across
oak, carpet and stone panels. Review images are local under
`output/playwright/floor-contact-*.png`. An aborted binary model request verified
the procedural fallback on all three floors, followed by a restored-model check.
Ten representative F1–F3 routes completed with no unsafe sampled natural-walking
segment against the revised rendered floor geometry.

Ground status and selection rings were removed from both agents and facility
characters. Eight mounted character pick groups retained their click/hover
handlers and contained no ground-ring geometry during browser inspection.

Version 0.4.84 passed the complete `pnpm check`: lint, package/public-data/schema
checks, workspace typechecks, daemon build, 227 test suites (2,405 passed, one
skipped), Rust checks/tests, Web/CLI/Desktop builds, version consistency and hair
asset validation. The recreation regression now checks the rack's new floor-
origin contract rather than its former elevated cabinet centre.

Hermes discovery was unavailable before execution; Codex subagents and local
Blender handled implementation and review. Native Desktop startup was not run
against a real profile; Web and Desktop share the floor renderer.
