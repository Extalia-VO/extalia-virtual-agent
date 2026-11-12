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

## Ordered two-way traffic and safe waiting

A FIFO passage ticket now covers the whole crossing, including an already-open
hinged or sliding door. Initial nearby arrivals enter by distance and stable ID;
subsequent arrivals retain queue order. Waiting movers seek swept, body-clear
pockets on their entry side, outside the central passage and moving leaf. They
recheck blocked parking paths rather than stacking at the handle. Route changes,
disposal and stale physical leases release tickets and owned closing duties.
A pre-existing external operator reservation remains authoritative until explicit
release; entering the physical queue converts it to the normal refreshed lease.

The next ticket takes over only after its predecessor clears the exit. The final
hinged passer closes behind the group; sliding doors retain their physical hold
and close afterward. Completed passers are excluded from implicit arrival
enrollment while remaining physical obstacles. A post-passage route join blocked
by the open leaf yields on the exit face without rejoining the entry queue. Late
arrivals during closing receive a handoff, and final goals, stairs and elevator
transitions are never discarded as stale threshold markers.

Validation adds six-actor opposing-traffic simulations for both door types, plus
queue ordering, cancellation, stale leases and leaf-safety tests. A browser probe
using the loaded Office's actual render-derived clearance passed four opposing
actors through Engineering's east door and the lobby slider in 21.9 and 21.4
simulated seconds, respectively; both closed afterward. Maximum movement was
0.04434 metres per 1/30-second step, with minimum body separation above 0.56 m.
This was a movement/clearance simulation in the loaded scene, not a recording of
new avatar meshes or real provider workloads.

A granted sliding-door head waiting for leaf motion is distinct from a queued
waiter: a frozen leaf remains visible to the existing six-second bounded progress
watchdog. Healthy queues remain protected, and recovery never grants permission
to cross a shut leaf. Final focused validation passes 292 tests across fourteen
doorway, entrance, seating, movement and facility suites.

## Congested-door alternatives and compact parking

Queue inspection now distinguishes a progressing head/leaf from a motionless
entry queue. A waiter considers an alternative after twelve simulated seconds
without head/leaf progress; an untouched head with a blocked approach can probe
after four. These probes exclude hand contact, swings and passage in progress.
An automatic slider head frozen partly open may also leave from its entry face.

The planner removes both graph directions across the congested physical portal,
using actual portal-plane geometry rather than names. It checks a continuous
same-face join from the character's feet to an ordinary supported waypoint, and
validates the route to a different door before any stairs/elevator transition.
Queue costs favor a less congested alternative. The chosen weighted graph is
used for the actual route, preserving the same/latest destination. Only then is
the old ticket released. Arrival at the alternative joins its existing local
FIFO with no inherited priority. If a safe alternative is unavailable, the
original ticket and queue remain intact. Destination-scoped avoided doors, a
twenty-second cooldown and at most two detours prevent repeated switching.

Normal deep waiting remains preferred. When no deep pocket is reachable, compact
lateral targets beyond the jamb can use shallower space. Targets clear the full
future leaf sweep, and every walk segment still checks the current leaf, static
furniture and other bodies. Four dense, opposing-traffic regressions cover both
hinges and directions, final FIFO order, body/static clearance and final closing.

An isolated browser probe used the loaded Office's real render-derived clearance
and authored navigation: a retained reservation blocked Engineering's north door.
The mover detoured at 14.7 simulated seconds through Engineering's east door,
reached the unchanged goal at 61.43 seconds and never crossed the blocked portal.
Maximum movement was 0.04434 metres per 1/30-second step. This was a mover/clearance
simulation in the loaded scene, not a recording of newly rendered avatar meshes
or real provider activity.

Static obstacle checks now participate in the door visibility graph itself, so a
blocked shortest bend can be replaced by another leaf/jamb-safe bend. Cached paths
invalidated by a body or static obstruction are retried at a bounded interval.
If the normal far handoff endpoint overlaps furniture, a clear 1.1 m exit-face
endpoint can finish passage instead. Uniform 2.35 m and 2.45 m apron regressions
verify opposing four-actor FIFO, supported sweeps, body separation and final
closing. These tests do not certify geometrically impossible room/door layouts.
Final focused validation passes 333 tests in seventeen suites.

Validation at v0.4.264 also passes Web typechecking and production renderer/Desktop
builds. The full workspace gate was attempted but remains blocked by concurrent
ownership-review entries in Chat transcript presentation and host observed-tool
image handling. No full-gate success is claimed for this update.

## Crowded narrow rooms and meeting departures

With local body snapshots available, a walker reserves its next actual doorway
up to ten metres before the threshold. Lookahead stops at floor transitions and
does not reserve from the wrong face when a route crosses the door's infinite
plane somewhere outside its aperture. The head follows its authored approach;
parking does not make an obsolete chair-side curve a valid return path. A checked
visibility join can use later approach samples, authored aisles and orthogonal
bends around tables, foliage and an opened leaf. Stairs, elevators, other portals
and the original final goal remain protected.

Waiting tickets, including the head before passage, can step aside for a walker
already travelling away from the door. Its travel intent defines the clear aisle;
safe local pockets supplement the normal waiting columns. This preserves FIFO
ownership rather than admitting two bodies together. A cached yield is cancelled
if its peer joins the same queue or finishes travelling, so a newly reported
arrival or an already seated character cannot make the head wait indefinitely.

An in-flight hinged passage/handoff keeps its interaction when the first progress
watchdog fires. Dropping it while retaining the old threshold used to re-enrol an
already crossed character from the opposite face. Clear exit-side bends now let
the character continue into a turning aisle instead of forcing the same far
centre apron. Dynamic/static sweeps and the leaf/jamb checks still apply. A nearby
body without a queued or approaching crossing is not a successor: the last actual
passer retains closing duties and waits for a safe swing.

Meeting and guest seats use their complete authored rear staging lane for both
exit and entry. The former 0.6-metre backstep could stop inside the inflated chair
collider. Only the matching chair is masked during this controlled lane; other
furniture, floor support and neighbouring bodies remain solid. Ordinary level-floor
recovery also walks its validated joining corridor on its last attempt, without
relocation or a recovery fade. The library entry has an explicit orthogonal turn
around its rendered plant corner.

Render batching retains collision ownership independently of mutable mesh
metadata. React replacing `userData` no longer removes an invisible batched
original from the clearance field. Intended source hiding and controller cleanup
still release the collision normally. The ownership registry is independent of
React and the renderer's batching component.

### Rendered crowd verification (v0.4.269)

These bounded v0.4.269 runs use detached door traffic and supplied all-actor,
zero-velocity neighbour snapshots. They do not exercise the production body
registry, measured velocities, desk reassignment or full arrival/departure
lifecycles. The later live-director investigation below covers those gaps; the
results here are evidence for these six fixtures only.

Fresh isolated scene runs use the real furnished office, rendered source avatars,
authored navigation, render-derived clearance and detached traffic at 30 simulated
steps per second. Characters enter and leave simultaneously; meeting departures
start seated and arrivals retain their original assigned seats.

| Scenario | Actors | Original goals completed | Simulated completion |
| --- | ---: | ---: | ---: |
| Library, opposing traffic | 10 | 10 | 55.43 s |
| Library, opposing traffic | 20 | 20 | 162.97 s |
| Entertainment, opposing traffic | 10 | 10 | 64.07 s |
| Entertainment, opposing traffic | 20 | 20 | 91.70 s |
| Meeting A, 10 leaving / 10 arriving | 20 | 20 | 169.40 s |
| Meeting B, 14 leaving / 6 arriving | 20 | 20 | 146.77 s |

All six runs finish with empty queues and closed doors. Across these 100 actor
journeys, no recovery fade, position jump, foreign-static crossing or body overlap
is recorded. Maximum frame travel is 0.04434 m; minimum measured body separation
is at least 0.56001 m. Own-chair entry/exit contacts are classified separately
using the controlled mask rather than ignored as arbitrary geometry violations.

Every fixture checks actual chair colliders and their own entry/exit lanes. The
field is rebuilt after asynchronous models/material visibility settle and after
the avatar render commits. An audit of 35 initial disappearing records identifies
only intentionally hidden lamp bulbs, sconce lenses and terrace light strips;
physical chairs remain present. Consecutive settled fields retain 5,129 records.
The local fixture also mirrors detached traffic amounts onto its mounted hinge
groups and verifies exact rendered leaf angles at the open and final samples.

Ignored evidence is under `output/playwright/crowd-room`: the consolidated report,
scene screenshots, `library20-entry-repair.json`,
`final-meetings-settled-results.json` and material/batch ownership audits. The
temporary browser fixture is removed after verification. These are synthetic
movement runs, with no real provider requests or user-profile changes.

Final validation passes all 304 Web test files / 2,862 tests, workspace lint and
typechecking, production Web/Desktop builds, synchronized v0.4.269 versions and
canonical hair-asset checks. Existing Web fixtures were aligned with the absent
observed-input context, current non-queue settings layout and strict attachment
metadata (negative sizes rejected; explicit zero-byte files retained). Those
fixture updates do not change conversation behavior.

The full `pnpm check` was attempted twice. Its native debug build did not finish
in this macOS environment: the default build stalled reading the dependency
directory, and an isolated target progressed before generated build-script
processes remained at startup. Both stalled verification process groups were
stopped; no application or agent session was restarted. Rust verification and
the unified project gate are not claimed as passing for this update.


### Live-director lifecycle investigation (2026-11-11)

The reported F3 desk/corridor problem reproduces in a real furnished-scene run
using `MovementDirector`, global `DoorTraffic`, live elevator controllers, actual
body callbacks and measured nonzero velocities. Twenty synthetic presences have
unique destinations, staggered arrivals, occupied-seat reassignment, replacement
workers, room/floor changes and final departure. A coherent simulation clock
covers the director, registry, doors and elevators; no real profile/provider is
used.

The pre-fix run records twelve distinct overlapping pairs (minimum separation
zero), missing bodies in walking/waiting/boarding/riding/alighting/vanishing,
and eight characters still present after 340 seconds despite all departures
being requested at 220 seconds. This invalidates a general liveness conclusion
from the earlier bounded door fixtures.

Concrete causes include unguarded chair-root translation, stale/absent physical
body records, slot-zero lift waiters sharing the alighting lane, four Flex chair
stages clipping inflated desktop corners, and a FIFO head/waiter occupancy cycle.
Live renderer checks also exposed the authored seated root sitting 8 cm inside
the conservative tabletop cylinder clearance; a strict new guard must not freeze
legitimate standing or scooting. Synthetic box-only chair tests do not establish
that the complete furnished desk sequence works.

Ignored local investigation artifacts are under `output/playwright/crowd-live`.
Final lifecycle acceptance requires exact admissions/exits, physical closure and
stationary-goal progress in addition to zero overlap; results are recorded below.

The corrected furnished layout passes a complete 59-desk preflight: every stage,
controlled root contact, stand/scoot/grip trajectory and available full chair
maneuver is clear. Both preferred side choices resolve to a valid maneuver;
Knowledge uses its clear side around the existing coffee table. Library sofa
entry/contact remains valid after moving its coffee table. The north Multi-Engine
desktops retain a measured 0.035 m furniture-to-wall gap. The formerly blocked F3
lift boarding segment also passes the real 5,164-collider field after deriving its
join from the actual floor polygon rather than the building's outer bounding box.

The full lifecycle runner additionally records actual admissions and retired
actors, duplicate chair operators, full 3D frame displacements, non-arrival/exit
opacity fades and recovery transitions. It cannot count a queued-but-never-spawned
presence as a completed journey, or accept invisible relocation as recovery.


### Accepted unchanged-source matrix (v0.4.276)

All cases use the same final production movement source, actual furnished geometry,
measured live body registry and controller-owned doors/lifts at 30 Hz. Four
replacement workers are included in each case. No real agent/provider/profile is
used.

| Scenario | Desired roster | Admitted / exact exits | Last exit, simulation time |
| --- | ---: | ---: | ---: |
| Held office allocation, later reassignments disabled | 20 | 24 / 24 | 297.167 s |
| Office, cyclic room/floor reassignment | 20 | 24 / 24 | 282.900 s |
| Office, alternate ordering | 10 | 14 / 14 | 275.033 s |
| Meeting rooms, cyclic reassignment and replacement | 20 | 24 / 24 | 301.500 s |

All 86 admitted actors reach their exact exit; every case ends with all 26 doors
closed and FIFO queues empty. Peak physical population is 24. Each case records
zero overlap, missing-body/nearby-registry holes, registry drift, duplicate chair
operators, unexpected opacity fades or 3D frame steps above 0.15 m. Minimum body
separation is at least 0.56000 m; maximum full 3D step is 0.124991 m at 30 Hz,
including cab motion. Normal arrival fades remain recorded separately. Recovery
attempts and deliberate yielding are observed rather than required to be zero.

The held case disables the scheduled 110/145-second task changes: all 20 workers
must be seated at their assigned places, with closed doors and empty queues at
160 seconds, before the ordinary final departure request at 220 seconds. It
passes this assertion. The former standalone Flex closure hold exceeded 93
seconds without another update; the corrected held run's maximum actionable
stationary observation is 10.033 seconds. Slow hand/leaf progress is recorded
separately from actual stationary feet.

Ignored evidence: `output/playwright/crowd-live/accepted-*-results.json`,
`accepted-held20-160.png`, geometry/held-goal diagnostics and the archived temporary
harness. The fixture reports blocked development-HMR errors and React portal-root
unmount warnings during furnishing setup; no clean-console or live-provider
certification is claimed. Movement exceptions, missing assets and all measured
safety failures are checked independently.

Validation passes all 318 Web files / 3,037 tests, 227 adjacent door regressions,
workspace typechecking, production Web/Desktop/CLI builds, version consistency
and canonical hair checks. Full `pnpm check` was attempted twice at v0.4.276. It
passes lint/boundaries/ownership/public-safety/schemas and types, then native
compilers stop making progress at filesystem directory reads (sampled
`rustc_session::filesearch → readdir → __getdirentries64`). Only the owned stalled
verification processes were stopped and their exit was verified. Rust tests and
the unified full-project gate are not claimed as passing.
