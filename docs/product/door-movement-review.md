# Hinged door movement

## Standby travel after door release

Door choreography moves a character away from the sampled walking trajectory. Resuming an old natural leg with its earlier origin/progress could leave a standby walker stationary beside a closed door until a local recovery ran, or unable to rejoin where static geometry blocked that recovery. Release and shared handoff now build a clearance-checked connection from the actual feet position, replace the obsolete first curve leg with exact walking segments and reset the complete natural-walking state. No body teleport or closed-leaf bypass is used.

Dense virtual approach markers no longer stop consuming after eight samples. Destination-side contacts, final goals, stairs and elevator steps remain retained. A rejected bridge waits for static clearance; an exhausted route completes its final closing duty without waiting for a nonexistent waypoint. Queued replacement goals continue through the existing replanner.

Verification:

- A controlled before/after reproduction with the release repair disabled/enabled shows 45 of 50 stationary frames before and zero after. First-frame motion after repair is 0.02339 m, maximum motion respects the 0.04433 m/frame walking budget and sampled leaf clearance remains at least 0.408 m.
- Six focused movement/door suites pass 202 tests. Mirrored close/handoff regressions cover both hinges, swing signs and approach sides, dense 24-marker consumption, blocked/released static joins, exhausted routes and partial-angle handoffs. Blocked exact/virtual markers before stairs or elevators retain their reservation and original transition until a safe join exists. A 248-route leisure regression enables natural trajectories and conservative portal-wall clearance.
- Browser probes using actual rendered geometry complete 496 same-floor leisure journeys across F1–F3 at slow and fast paces. Four live source-avatar push/pull maneuvers resume immediately, show zero stationary frames during the following 40-frame sample, preserve leaf clearance above 0.408 m and finish their exact goals with closed doors.
- Independent read-only review identified rejected-bridge escape, exhausted-route completion and blocked-marker transition boundaries; all received fixes and regression coverage.
- Full `pnpm check` passes for v0.4.92 on 2026-10-24: lint, boundaries, public safety, schemas, workspace types, 241 suites / 2,675 passed tests (one skipped), Rust formatting/clippy/tests, Web/Desktop/CLI builds, synchronized versions and canonical hair assets.

## Dynamic interaction pace

Hand-operated door tempo now derives from actual capped walking speed in metres per second, including character gait, personal pace, trip variation and current walking mood. Grip/release timers, hand ramps, turning and candidate leaf motion share one bounded tempo, recomputed each frame. A pace change during an interaction takes effect without restarting its beat or changing its geometry.

Clear-apron walking uses the character's travel speed rather than a fixed 55% slowdown. Close contact uses careful shorter steps at 75% of that speed. The leaf remains bounded by the operator's physical travel budget and the existing swept-door clearance checks; traffic ownership and queue handoff stay unchanged. Hand targets use the resulting leaf angle. Foot phase follows measured root travel on apron paths and signed travel during swings, so feet do not continue walking when the body stays still or a short path segment ends early. Automatic sliding doors keep their physical controller timing.

Verification:

- Eighteen new pace tests cover slow/normal/fast interaction, both hinges and approach sides, both swing signs, 60 Hz and 100 ms frames, sampled body/leaf clearance, gait distance, stationary feet, actual gait/speed caps and mid-swing pace changes. Five focused suites pass 166 tests.
- Independent read-only review reports no blocking findings. Additional temporary review cases cover mixed-speed queues, repeated changes across all beats, dense subframe collision samples and sliding-door passage/closure.
- Twelve live source-avatar browser maneuvers complete through solid and glass doors, mirrored hinges and both directions at slow/fast paces. Rendered leaf angles match traffic state, every door finishes exactly closed and minimum sampled leaf clearance is 0.42 m. A mirrored solid push entry takes about 8.57 s of door work at the slow test pace and 3.17 s at the fast capped pace.
- The final combined-workspace gate also exposed stale Knowledge integration: the sample host lacked the newly registered overview method, the method-list fixture still expected seven entries and the sync fixture counted only indexed notes rather than newly seen paths. The mock now returns bounded validated overviews with tested degrees/ranking; fixture corrections retain skipped-file and profile-isolation assertions. Four focused Knowledge/protocol suites pass 230 tests.
- Full `pnpm check` passes for v0.4.91 on 2026-10-24: lint, boundaries, public safety, schemas, workspace types, 240 suites / 2,655 passed tests (one skipped), Rust formatting/clippy/tests, Web/Desktop/CLI builds, synchronized versions and canonical hair assets. Concurrent Knowledge Rust files received formatting only to satisfy the shared gate.

## Door geometry and traffic

Room entry leaves now open inward by a full quarter turn. Front/back entry
layouts use mirrored hinges while keeping the same room-relative swing.
Exterior leaves retain outward operation. Sliding doors retain their own
automatic traffic controller.

The portal exposes hinge handedness and optional hardware height/offset. Leaf,
handle and body coordinates share the same pivot and rotation convention.
Characters reserve a hinged doorway, approach the appropriate face, turn toward
the handle and select the hand from the hinge/face combination. Their feet
follow a point 0.42 m from the leaf while the hand follows the actual handle.
Pulling uses backward steps; pushing uses forward steps.

A short visibility graph finds a path through the clear opening and around the
free tip. Its 0.34 m body clearance excludes the leaf capsule, jambs and adjoining
wall. A push-entry character reaches the accessible handle near the free tip,
tugs it toward closure and moves inside while the reserved swing finishes. A
pull-entry character crosses the doorway and turns back to pull it closed. Waiting characters remain beyond the sweep radius; a blocked
leaf pauses rather than timing out into a forced passage. A reservation covers
the complete maneuver, so another operator cannot close the leaf mid-passage.

The last passer closes the door. Handoff reconnects the original route through
a clear path, discarding only intermediate threshold markers that overlap the
open leaf. Final goals are retained. Removing characters, reduced-motion seat
placement and disposing either movement director release door ownership and
closing duties.

Verification for v0.4.66:

- 67 focused tests across door, chair, movement-director and facility behavior.
  Door simulations cover both hinges, both swing signs, both approach sides,
  three widths and four world orientations, with 60 Hz and capped 100 ms
  steps. Every sampled body position clears the leaf/jambs. Queue, handoff,
  route resumption, contact, push/pull cadence and cleanup regressions pass.
- Browser review uses the actual `OpenDoor`, `SourceHumanoid`, traffic registry
  and mover. Four hinge/approach combinations complete opening, passage and
  closing. The smallest sampled body-to-leaf distance is 0.42 m. Local review
  screenshots are under `output/playwright/door-*` (ignored artifacts).
- Mounted building inspection finds 25 hinged portals at 90 degrees and three
  sliding portals, across all three floors.
- Full `pnpm check` passed: 191 suites / 1,906 tests, Rust formatting,
  clippy and tests, lint, public-safety, boundaries, all type checks, Web/CLI/
  Desktop builds, version consistency and local character-asset validation.
  Installed Xcode tools were selected for that process only.

The planner handles the doorway apron; it is not a general furniture or
character crowd solver. Existing office navigation continues to select routes
outside that apron. Desktop startup smoke remains excluded because of the
existing real-profile auto-connect behavior documented in the avatar foot
review; the shared renderer is reviewed in the browser and Desktop is built.


## Near-handle closing and threshold recovery

Closing now turns beside the free-edge handle directly after passage instead
of walking to the far waiting apron and back to the middle of the leaf. The
closing stance stays within handle reach and clears the latch jamb. A reverse
swing may finish closing while completing the frame crossing; requiring the
body to cross fully first would force another trip back to the handle.

A rendered portal can differ from its authored threshold by floating-point
rounding (for example, 11.399999999999999 versus 11.4). Strict same-side tests
missed these crossings, letting wanderers reach a closed leaf. Their subsequent
approach correctly refused to plan from inside the leaf capsule and never
progressed. The actual leisure-route regression reproduced 94 such stalls.
Crossing detection and crossing duties now snap sub-micrometre plane offsets.
Existing stranded actors walk away on the same face before replanning; actors
exactly on the plane choose the side opposite the next non-plane route marker.
The leaf stays closed during recovery, with no teleport or timeout bypass.

Verification in v0.4.73:

- 219 focused tests across doors, liveness, movement, facility staff and desk
  placement. The 109 liveness cases include all 28 actual portal geometries and
  office leisure routes, 32 stranded-start combinations, 50 tiny target-offset
  cases, queued goal replacements and staggered opposing/following traffic.
- Four actual source-avatar browser maneuvers with mirrored hinges/approaches
  complete the shorter close path; minimum sampled leaf distance is 0.351 m.
  Two browser actors started in the old stranded `doorwork/approach` state at
  the closed plane: both retreated with the leaf shut, opened, crossed, closed
  and completed the route. Images are under `output/playwright/door-recovery-*`.
  Full `pnpm check` passed: 210 suites / 2,265 tests passed, one skipped,
  Rust formatting/clippy/tests, lint, boundaries, public safety, type checks,
  Web/CLI/Desktop builds, version consistency and local character assets.
  Installed Xcode tools were selected for that process only.

The geometric checks cover the reproduced door stall, not a general crowd
collision system. Hermes discovery was unavailable because its Python runtime
was not configured; Codex continued with Luna regression work. Sol supplied the
near-close implementation and original reproduction before hitting its usage
limit. No Hermes model, session or token usage was created.


Repository-wide validation also required small cleanup in concurrent skill-registry
work: scoped a list-page variable, documented an intentional control-character
validation regex, normalized a synthetic email to an example.com address, and
aligned the Bridge fake-host test with its explicit unsupported-action (501)
response. No registry or Bridge runtime behavior was changed by that cleanup.


## Latch-side pull opening (v0.4.74)

The former pull stance rotated with the middle of the leaf and ended behind
its hinge. Pull opening now starts beside the latch and releases its initial tug
within five degrees, before the handle leaves arm reach. The reserved operator
finishes the checked swing while stepping laterally beyond the latch, with only
0.26 m of additional retreat. Push openings retain their existing contact path.

A solo pull opens about 45 degrees on normal wide doors, with extra opening for
narrow doors to retain capsule clearance. The actor then regrips the real handle
near the frame and closes while completing the crossing. No invented panel grip
is used. An initial queue gets a full opening and direct handoff, without first
walking to the closing handle. The opening target is fixed at the initial grip;
a late arrival waits for the partial pass to finish instead of extending a
released gesture. Leaf movement after the tug remains reserved and checks other
walkers before every step. A bounded search limits foot motion through the
piecewise sidestep rather than allowing a jump at its corner.

Verification: 181 focused tests across choreography, liveness, door traffic,
movement and facility staff; mirrored source-avatar browser passages complete
with expected opposite-hinge positions and real closing-handle contacts. New
coverage checks side and clearance throughout the opening, reachable contact
before release, a close regrip without deep retreat, and late-arriving traffic.
Full `pnpm check` passed: 210 suites / 2,267 tests passed and one skipped,
including Rust formatting/clippy/tests, lint, boundaries, public safety, type
checks, Web/CLI/Desktop builds, versions and local character assets. Browser
review includes four mirrored 1.15 m source-avatar passages and both pull
hinges on 1.6 m glass doors. All complete; the glass pull cases retain at least
0.411 m sampled leaf clearance. Local images are under
`output/playwright/door-lateral-*`. The full check passed with two test workers
after an earlier exhaustive BMP-character test exceeded its default timeout;
no test assertion or timeout was changed.


## Reachable closing after inward entry (v0.4.79)

The former push-entry close target used the opposite rotating leaf face. At a
quarter turn that target lies behind the hinge line, so the visibility graph
correctly routed the actor around the stationary free tip to reach it. The new
close starts from the same accessible face used to push the door, at the free
edge. The actor releases a short five-degree tug before the handle leaves reach,
then moves along a 0.42 m arc around the moving tip as the reserved swing shuts.
The body stays on the room side and avoids a trip behind the open panel.

`DoorAct.entryCloseStart` fixes the initial opening fraction for this trajectory.
The existing pull-entry/room-exit close track remains separate. Free walkers
assigned a close duty after crossing an already-open leaf infer the accessible
leaf face from the current body position and leaf angle. Queue handoff remains
reserved for following traffic. Threshold markers are consumed after the entry
close so the resumed route continues into the room. Foot-limited angle steps
snap sub-nanofraction endpoint residues to exact 0/1.

Regression coverage reproduces the former behind-leaf close grip, checks both
hinges and swing signs, narrow/wide panels, rotated frames, moving leaf/jamb
clearance, reachable tug contacts and already-open free-walker duties. Five
focused movement/door/facility suites pass (185 tests). Six real source-avatar
browser maneuvers complete: mirrored solid push entries, mirrored 1.6 m glass
push entries and both existing pull exits. The actual rendered leaf angle is
checked against the traffic amount at the closing grip. Sampled body-to-leaf
clearance stays at least 0.42 m and every leaf finishes at exact zero. Local
captures use `output/playwright/door-entry-close-*`. Independent Codex Sol review
reported no actionable findings. Hermes discovery was unavailable before any
worker started; no external execution or usage was recorded. Full `pnpm check` passes for v0.4.79: lint, boundaries, public safety, typecheck,
215 suites / 2,291 tests (one skipped), Rust formatting/clippy/tests, Web/CLI/Desktop
builds, synchronized versions and local avatar checks. No real-profile Desktop
startup test is performed.
