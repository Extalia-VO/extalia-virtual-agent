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
queues waiting for another operator. Stairs and lifts use the separate progress
guards below. Hidden-tab wall-clock gaps do not immediately trigger recovery.

## Bounded recovery

There are at most three recovery attempts per destination:

- Try a swept, collision-checked local detour while retaining authored contacts.
- In narrow encounters, use stable character-ID arbitration: one walker retreats
  to a clear apron and briefly yields so the other can pass. Replanning can join
  a nearby visible waypoint with a route to the newest requested destination.
- As a last resort, relocate the same avatar to a validated ordinary waypoint on
  its current floor, within six metres, then continue its route with a fade-in.

Relocation requires static clearance, nearby-body information and a reachable
route. Recovery never grants passage through a shut door or moves a character
across a threshold without normal door handling. Failed candidates leave owned
interactions intact. On a validated recovery, owned door/elevator reservations,
body registrations and stale hand/curve state are released or rebuilt. Pending
destinations are preserved. When no safe candidate exists, recovery refuses the
move rather than placing a character inside geometry; the normal mover can still
resume when an obstruction clears or a new destination arrives.

Ground-floor footprint clearance now recognizes registered doorway apertures.
The exception is limited to the aperture's width and threshold depth; mesh solids
still block movement, and upper floors still require slab/perimeter support.
Portal metadata is fetched lazily once per swept clearance check.

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
