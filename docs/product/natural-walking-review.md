# Natural office walking

Ordinary floor travel now uses a stable variation for each character and trip.
Validated open-space chords can bypass intermediate aisle points. Rounded curves
change the actual feet position through corners, with lane variation that returns
to exact doorway, stair, lift and seat contacts. The navigation graph still
provides connectivity between rooms and stories; its centreline is no longer the
only physical line walked through open space.

## Scene clearance and passing

Each mounted Office owns a clearance field built from its rendered furnishings
and partitions. Static batching originals remain physical sources; duplicate
render batches, overhead decoration, hidden templates and moving door leaves are
excluded. Door motion remains owned by the door traffic controller. Body-radius
segment checks account for transformed tabletops, cabinets and low partitions.
Upper stories require supporting floor geometry, including the stair cutouts and
rounded building edge. Model replacement events refresh the field without a full
scene traversal every frame. Before geometry is ready, original routes remain
available.

Nearby walkers publish velocities measured from copied positions. Predictive
passing uses bounded lateral changes and speed adjustment, with every proposed
movement checked against the same scene clearance. Narrow contact approaches
retain their exact positions and use headway rather than lateral deviation.
Yielding walkers remain visible to traffic while stopped. Passing width adapts
to available space, and small pace differences help groups break rigid formation.
Walking phase follows actual distance, including passing motion. Curves and
passing do not change agent/session activity or reduced-motion behavior.

## Validation

Focused tests cover body clearance from actual Three geometry, transformed
furniture, batching originals, model replacement, upper-floor voids, field owner
isolation and measured velocities. Movement tests cover trip variation, rounded
positions, validated shortcuts, opposed/crossing/following streams, bounded halls,
protected contacts and real door choreography.

Browser review uses the mounted Office's collision field and actual source
avatars. Representative routes cover the F1 corridor, team workspace and lobby,
F2 circulation, and F3 fitness. A six-character opposed stream checks continuous
movement, physical separation, arrival and sampled body clearance. Review images
are ignored under `output/playwright/natural-walk-*.png`.

The rendered-scene route probe completed ten trips across those five areas with
no unsafe sampled natural-walking segment. Fourteen desk destinations across QA,
entertainment, library, pantry and engineering reached their seated state through
the real door controller. The six-character mixed-start corridor review completed
all trips within 50 simulated seconds, with 0.894 m minimum centre separation and
no unsafe sampled natural-walking segment. Maximum frame travel was 0.02217 m and
maximum frame heading change was 0.10334 rad at a 1/60 s step. These are focused
browser simulations, not a guarantee for every possible furniture arrangement or
population.

Version 0.4.83 passed `pnpm check`: lint, package boundaries, public safety,
schemas, workspace typechecks, daemon build, 225 JavaScript test suites (2,393
passed, one skipped), Rust checks/tests, Web/CLI/Desktop builds, version
consistency and character-hair asset validation. Sixteen movement regressions and
six clearance/registry regressions were added for this update.

## Pace correction in 0.4.84

Short curve samples previously stored their truncated frame distance as the next
sample's velocity, then discarded unused time. This repeatedly slowed an otherwise
clear path. Commanded speed now survives those internal samples, with consumed
time tracked separately for forward and lateral travel. The additional natural-
walking speed multiplier was removed; personal/trip pace and stroll/walk/hurry
already provide the variation. Stride and cadence continue to follow actual
travel, with a 2.2 m/s walking maximum.

Regressions check clear-path speed and stride distance at 30/60/120 FPS, rounded
path throughput, equal-speed opposing rows, and mixed real trip paces. A rendered
24.9 m corridor probe used nine character/mood combinations: average travel matched
the intended 0.85–2.2 m/s speeds within 0.01 m/s. Six mixed-pace walkers completed
within 30 simulated seconds (minimum separation 0.559 m), and six walkers at the
2.2 m/s cap completed within 20 seconds (minimum separation 0.692 m). Both had no
unsafe sampled natural-walking segment, with frame travel and yaw bounded. Ten
F1–F3 route probes completed safely, and fourteen fast desk approaches reached
their seats through the real 28-portal door controller. These focused cases do
not certify every possible population or arrangement.

The combined 0.4.84 update passed the full check: 227 suites, 2,405 tests passed,
one skipped, Rust checks/tests and Web/CLI/Desktop builds.

Hermes model discovery was unavailable before external execution; Codex and local
subagents handled implementation and review. Native Desktop startup is not run
against a real profile; Web and Desktop share the renderer.
