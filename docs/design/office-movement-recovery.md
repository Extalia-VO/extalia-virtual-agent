# Office movement recovery

Office movement is presentation state. Recovery keeps the same mover ID and
reported agent/session; it does not restart a runtime, submit a prompt, recreate a
session or change the assigned task.

## Entrance deadlock

Protected portal legs retain their authored line. Two opposing walkers can both
slow to zero while yielding to the body ahead. The earlier local reconnect
covered natural curve legs only. A separate clearance issue rejected a body's
radius when it straddled the ground-floor building outline at a valid doorway.

The recovery watchdog measures meaningful progress toward the active step over
simulation time. Very small frame motion and sideways oscillation cannot keep
resetting it. Walking is checked after three seconds without progress; stalled
door choreography after six. Advancing door beats/leaf motion count as progress.
Seated/idle states and chair/seat interactions are excluded, as are hinged-door
queues waiting for another operator. A completed fixed-seat departure with no
onward route is tracked separately from a legitimate seated or standing station.
Stairs and lifts use the separate progress
guards below. Hidden-tab wall-clock gaps do not immediately trigger recovery.

## Bounded recovery

There are at most three recovery attempts per destination:

- Try a swept, collision-checked local detour while retaining authored contacts.
- In narrow encounters, use stable character-ID arbitration: one walker retreats
  to a clear apron and briefly yields so the other can pass. Replanning can join
  a nearby visible waypoint with a route to the newest requested destination.
- As a last resort, walk the same avatar to a validated ordinary waypoint on
  its current floor, within six metres, then continue its original route.

The joining walk requires static clearance, nearby-body information and a reachable
route. Recovery never grants passage through a shut door or moves a character
across a threshold without normal door handling. Failed candidates leave owned
interactions intact. On a validated recovery, owned door/elevator reservations,
body registrations and stale hand/curve state are released or rebuilt. Pending
destinations are preserved. When no safe candidate exists, recovery refuses the
move; the normal mover can still
resume when an obstruction clears or a new destination arrives.

Ground-floor footprint clearance now recognizes registered doorway apertures.
The exception is limited to the aperture's width and threshold depth; mesh solids
still block movement, and upper floors still require slab/perimeter support.
Portal metadata is fetched lazily once per swept clearance check.

## Incomplete departures and inactive plans

A failed route after leaving a sofa or another fixed seat used to leave the
avatar in a terminal-looking seated state with a standing pose. The explicit
departure marker now retains its intended destination and checks progress after
three simulated seconds. Recovery first retries the authored staging route, then
may walk to a visible, supported same-floor aisle with static, body and door
clearance. It does not respawn or teleport the avatar. The three-attempt local
recovery budget remains bounded; afterward, only the original staging route is
rechecked every ten simulated seconds, so a route restored later can still
resume the same avatar and destination.

Facility NPCs retry failed voluntary break/recreation routes every two seconds.
Fifteen simulated seconds without movement abandons only that inactive trip and
returns through the normal home/duty intent. Actual movement or a destination
change resets this clock. Serving customers and owned lift, door and seat waits
are excluded; a hidden-tab wall-clock gap cannot consume the whole deadline.

Agent leisure travel budgets also pause for owned transit/contact interactions,
expected service and reciprocal chat plans. Waiting is not inferred from a
motionless pose alone. Ordinary failed travel still expires after its existing
budget, and a completed leisure visit still ends normally. These policies apply
to the shared movers for managed/observed avatars and facility NPCs without
altering runtime work or restarting sessions.

Focused inactivity/departure validation covers 142 tests across eleven suites,
including late route restoration, preserved latest intent, bounded probes,
stationary NPC trip reset and protected managed/observed lift/service/chat waits.
An isolated mock Office also supplied its live render-derived clearance for six
injected failed departures at F1 benches and F3 terrace sofas. The same movers
and goals recovered in 4.27–5.77 simulated seconds, with maximum 0.04433 m movement
per 1/30-second step and no floor changes. This was a movement simulation using
the loaded scene, not a recording of newly rendered avatars or real workloads.

## Verification

- Regression simulations use the authored F1 exterior portal and reciprocal
  entrance/exit routes, with stationary and measured body velocities.
- Watchdog, narrow-portal yielding, closed-door/ownership, pending-goal, fade,
  bounded failure, furniture, floor support and aperture tests cover safety.
- The isolated mock Office was also used to run reciprocal movers against its
  actual render-derived clearance and registered entrance. Both goals completed
  in about 9.3–9.6 simulated seconds; the previous implementation remained
  blocked after 60 seconds. This was a movement/clearance simulation in the
  browser, not a recording of two newly rendered avatar meshes or a test of real
  provider activity.

Initial walking/door validation on v0.4.206: `VITEST_MAX_WORKERS=4 pnpm check` passed
6,603 TypeScript tests (23 optional skips), 474 Rust tests, lint, typechecks,
all builds and version/asset checks.

## NPCs, stairs and elevators

Facility staff use the same mover and movement environment as agent avatars.
The receptionist and bartender receive the same recovery and fade behavior;
their identity, duty state and destination are retained.

All directed segments of an authored stair connector are protected stair legs,
including flat turns at half-floor height. Ordinary slab clearance must not
reject these halfway landings. A six-second stair watchdog measures meaningful
3D progress. Recovery can retrace consecutive authored segments at walking speed
to a validated supported landing and plan another route, avoiding the failed
edge. It does not snap a character in midair or invent a diagonal through a
switchback. Reverse travel checks nearby bodies and preserves headway.

Lift progress is sampled at most twice per simulated second from the controller:
cab height, door opening, phase, rider reservation/boarding status, doorway token,
queue advancement and confirmed boarding/exiting service. A genuine queue remains
waiting while the cab progresses or serves passengers ahead. Arrivals behind the
rider are not progress. Peer service cannot mask a rider stuck during its own
boarding, ride or alighting.

A verified freeze must persist for twenty seconds before recovery; a missing
reservation requires six seconds. Unknown, invalid or throwing diagnostic
adapters leave the rider waiting conservatively. A long frame does not advance
these clocks by its full wall-clock duration.

A waiting or not-yet-boarded rider can recover only to its origin floor. A
confirmed onboard rider may fade to a validated landing at a known trip endpoint.
The landing must have floor/static/body clearance and a viable route. Recovery
releases only that rider's reservation and avoids the failed cab; it does not
reset the whole lift or cancel other passengers. Pending destinations survive.

Additional evidence includes actual FacilityNpcDirector regressions for both
staff roles, a ninety-second untouched unknown-adapter queue, and a frozen
onboard NPC returning to duty. Browser movement simulations using the loaded
Office's clearance completed all four F1–F3 stair directions without recovery or
position jumps, preserved a healthy ninety-second lift queue, and rescued a
frozen rider to a supported landing. The browser lift observations were injected
test data; controller ownership and service behavior are covered separately by
unit tests. These are not recordings of new NPC meshes or real provider activity.

The rendered-clearance stair check also injected eight stalls: a flight and a
half-height flat turn for each up/down connector. All eight retraced the authored
path to a supported landing with one recovery attempt, with per-frame movement
bounded by walking speed. Confirmed-exited passengers use their own body progress;
a healthy cab serving others cannot hide a character stuck outside its doors.

Transit validation on v0.4.208: `VITEST_MAX_WORKERS=4 pnpm check` passed
6,632 TypeScript tests (23 optional skips), 474 Rust tests, lint, typechecks,
all builds and version/asset checks. The final focused movement/NPC/transit sweep
passed 120 tests. Implementation introduced in v0.4.207; no real profiles or
provider workloads were used.

## Measured stationary intent and cached seating routes

Every shared mover records actual feet speed, accumulated no-progress simulation
time, destination and a reason. Development inspection can read detached snapshots
through `movementDiagnostics()` on either movement director. Animation blend and
retry timer changes cannot disguise stationary feet. Settled sitting/standing
stations, physical door queues and owned elevator phases remain intentional waits.
Pose and finite choreography progress also defer a blocked classification.

A cached fixed-seat exterior approach could remain blocked forever after its
clearance changed, because only an absent route was recomputed. After ten seconds
without progress, the mover invalidates that exterior path and recomputes from
its actual feet, preserving its destination and contact choreography. An external
fixed-seat exit or ordinary level-floor walk whose bounded recovery is exhausted
can also recheck a nearby supported aisle every ten seconds. It validates the
body/static sweep, excludes door thresholds, and verifies the aisle's onward leg
before continuing at walking speed. Stair/lift/contact ownership is retained;
these periodic checks neither renew recovery attempts nor relocate the avatar.

Regression coverage includes changed cached paths, permanent contact blockage,
late alternative aisles, simulation-time clamping, slow progress versus jitter,
protected queues/stations and detached diagnostic snapshots.

Final scene-focused verification for this update passes 292 tests in fourteen
suites, plus the loaded-scene doorway probes described in the door review.
Workspace lint/type checks, Web/Desktop/CLI builds, version consistency and hair
assets pass at v0.4.262 (the movement update was introduced in v0.4.261). The full
workspace gate is not green: its wider integration run reports observed-agent
control, installer and Git subprocess failures outside the movement paths.
Those failures also include an independently reproduced observed-control suite;
this evidence does not claim full repository validation.

The broader run was stopped after those independently reproduced integration
failures; supplemental Rust validation was also stopped before all suites
completed. No full-gate or complete Rust-suite success is claimed for this update.

## Physical crowd supervision

A shared `CrowdWatch` measures displacement rather than animation speed. After
three simulation seconds without 8 cm of progress, a stable encounter can nominate
one character for a short retreat. It groups two or more overlapping bodies
(distance below 0.56 m), stopped following/opposing walkers within 1.4 m, and
blocked interactions with a free neighbour within 0.85 m. Overlap groups are
reported even when every member is protected. A one-second group settling window
avoids reacting to a passing encounter. Frame time is capped at 0.1 seconds, so
resuming a suspended tab does not instantly age every timer.

Only level walking, hands-free chair walking and ungripped door reservations can
move aside. Working seats, stairs, cab ownership and held interactions remain
protected. Legitimate queues are exempt while their head or leaf still progresses;
a stalled operator can request space from a nearby free waiter. Nomination rotates
through untried/oldest actors rather than repeatedly selecting the lowest ID.
Failed plans retry after eight seconds, with one second between nominations.

The nominee validates a 0.75–1.5 m side/back corridor against real furniture,
current and predicted bodies, floor support and door portals. It walks there,
briefly gives peers room, and resumes its original goal; the intervention lasts
at most four seconds. FIFO tickets are refreshed while yielding. A partial
retreat retains its checked origin breadcrumb when a direct rejoin is blocked;
curved routes rebase from actual feet. New goals cancel the obsolete retreat.
There is no teleport, forced seat assignment or simultaneous mass sidestep.

Every physical phase publishes a fallback body, including exhausted door routes,
waiting lifts, riding, alighting and departure fades. Fresh moving records retain
measured velocity; stale records fall back to the body instead of hiding it.
All director bodies are published before the first character queries neighbours.
Stationary bodies also protect swinging leaves without inventing crossing intent.
Timed chair roots and door-operator roots validate proposed displacement before
advancing pose, chair, timer or leaf. A velocity prediction never removes the
current physical body from the swept collision check.

Physical seat claims also cover already admitted walkers: a new character cannot
begin a seat interaction while another actor still stands, sits, handles that
chair or completes its exit. Logical reassignment cannot release a held chair.
The waiting actor retains a real staging leg and its destination, so ordinary
crowd yielding remains available while the old owner finishes.

A complete desk maneuver is checked before choosing its side. A safe preferred
side retains variation; a blocked side falls back to the other, and neither-side
clearance never grants passage through furniture. The animated root legitimately
reaches under its own tabletop/input edge at the authored seated pose. Clearance
matches the exact station through its chair anchor; only narrow, sampled contact
curves get a smaller surface/input radius. Foreign furniture, people, desk legs,
walls and floor support keep normal clearance. Full walking legs are split at the
contact apron so the exemption cannot extend along an unrelated aisle.

Furnished-scene probes also require layout fixes: F3 Multi-Engine rows move to
world Z −18.5/−15.5 with the connecting aisle at −16.3; the north Flex row moves
0.3 m north. Matching rendered/resource coordinates stay synchronized. Lateral
desk approaches use sufficient corner clearance, and the library coffee table
moves away from the pulled-chair corridor. These changes provide actual room
for the existing choreography rather than exempting foreign desks or glass.
