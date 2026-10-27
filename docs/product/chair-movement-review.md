# Workstation chair passage

The chair renderer previously chose a signed swivel per resource, eased its
slide and damped it again. The actor used an unrotated linear slide and always
walked one fixed side. Hand contacts and the entry/exit path therefore disagreed
with the moving chair.

The mover now chooses a reproducible pseudo-random side for each sit or stand
maneuver and retains it throughout that maneuver. It publishes that side with
the scripted pull to the chair renderer. Body and contact points use the same
slide, swivel, mesh pivot and resource seat anchor. Task and executive chairs
have distinct root offsets; both retain their mesh contacts. Active movement
has no second damping lag, and movement updates precede furniture and avatar
frame updates. Abandoned chairs retain their existing cleanup behavior.

The chair pulls back 0.56 m to provide space between the open front and the
desk. From behind it, the actor follows the chosen side around the backrest,
arm pads and base, approaches the front, turns toward the desk, and lowers
backward onto the seat. The sitter follows the swivel while scooting in.
Standing reverses the front passage: the chair rolls out while held, the hands
release before the front step exceeds their reach, and the actor walks around
the same side before pushing the chair back. Hand choice mirrors the opening.
Reduced-motion placement clears incomplete chair motion and contacts.

Verification in v0.4.67:

- 96 focused tests across chair motion, passage, office movement/life, facility
  staff, walking pace and door regressions. New tests compare contact points
  with independent Three.js matrix composition, sample both mirrored paths at four world
  orientations against back/arm/base clearances, and exercise complete sit/stand
  cycles, per-maneuver side variation, armrest release and reduced motion.
- Browser review uses the actual workstation, instanced chair renderer, mover
  and local source avatars. Male left/right passages and a female source-body
  passage, each with seven sit/stand beats, were sampled. Actual instance
  matrices match the expected pose within 5e-8.
  Review images are local ignored artifacts under `output/playwright/chair-*`.
- Full `pnpm check` passed: 193 suites / 1,918 tests, Rust formatting, clippy
  and tests, lint, boundaries, public safety, type checks, Web/CLI/Desktop
  builds, version consistency and local character-asset validation. Installed
  Xcode tools were selected for that process only. The walking-pace regression
  now waits for real walking instead of ending its outing during chair exit.

This addresses chair interaction geometry and timing. It does not replace the
avatar rig or add a general crowd/furniture collision solver. Desktop startup
smoke remains excluded for the real-profile auto-connect reason recorded in
the avatar foot review; Web and Desktop share the checked renderer.


## Steps during chair handling (v0.4.80)

Pull/push beats previously eased walking toward zero immediately before easing it
back toward 0.55 in the same frame. At 60 Hz the competing ramps left only about
0.06 walk strength: the actor followed the chair while the legs were nearly still.
Only stationary chair beats now fade walking out; pull/push retain their intended
0.55 short-step strength. `advanceWalkDistance` advances the gait from measured
root travel, with direction projected onto the character facing and stride bounds
matching the shared pose writer. An eased swivel/slide therefore varies cadence
with distance and produces backward pull steps or forward push steps. Stationary
travel contributes no phase. Ordinary walking, seated scooting and stand-up body
and armrest choreography remain unchanged.

Six focused suites pass (55 tests). New chair handling cases cover task/executive
seat anchors, both sides, rotated chairs, masculine/feminine gait profiles and
60/30/10 Hz frame steps. Shared gait tests check zero-distance stability, direction
and split-distance invariance. Full sit/stand and chair contact/path checks pass.

Browser review samples both source-avatar bodies and both chair sides through
pull, sit, stand and push. All four cycles complete with the chair tucked in.
Actual upper/lower leg bone rotation ranges are 0.14–0.34 radians during the
sampled beats, with the chair hand contact retained. Captures are ignored under
`output/playwright/chair-steps-*`. Independent Codex Sol review found no concrete
regressions. Hermes discovery failed before a worker could start, so no external
model/session/usage was created. Full `pnpm check` passes on the combined v0.4.81 workspace: 218 suites / 2,344
tests, one skipped; lint, boundaries, public-safety, typecheck, Rust gate,
Web/CLI/Desktop builds, synchronized versions and local-avatar checks.
The repository-wide gate also required an explicit `SkillConsentWorkspace[]`
annotation on an existing host consent fixture and standard Rust formatting in
concurrent knowledge-store work; neither adjustment changes runtime behavior.
