# Blender interiors and character recreation

Storage cabinets, display cabinets, single/double-sided bookcases, print/copy
stations and decorative tables now use the local Blender interior library.
The same library supplies the pantry counter/back bar, glassware rack, espresso
machine and swivel stools; server racks; television/console, arcade shells,
foosball and lounge furniture; exercise equipment; plants, artwork and lamps.
The coordinated materials use oak, ivory, graphite, muted teal and restrained brass.

## Authoring and loading

Run Blender in background mode with `--factory-startup` and
`--python tooling/blender/create-interior-library.py`. Arguments after `--` accept
`--output <directory>` and `--preview <png-path>`. Dimensions come from
`apps/web/src/office/scene/interior/interiorAssetProfile.json`. The editable
`.blend`, GLB and bounds manifest are generated in ignored
`apps/web/local-assets/furniture/`; preview images are ignored under
`output/playwright/`. Generated binaries remain local under repository policy.
A clean checkout retains procedural furniture until the library is generated.

The library contains 46 named roots, 159,184 triangles and 266 meshes grouped by
shared material, approximately 4.5 MB. `InteriorPart` loads it once and shares
immutable geometry/materials. Only upholstery tints, glass and live emissions
are cloned per instance and disposed by their owner. Loading failures and
missing roots preserve complete procedural counterparts. `?interiors=procedural`
forces those counterparts. Temporary geometry is excluded from static batching.

Runtime keeps live display pictures, illumination sources and articulated
parents. Stools split stationary pedestal from the upper swivel; bike crank and
horizontal pedals are independent; cable handle and weight stack are independent.
The pendant asset contains only shade, socket and diffuser at unit scale: runtime
mounts the canopy and extends its cord without stretching the shade. Decorative
emission follows interior lighting and manual overrides; server LEDs remain
subtle, with static output under reduced motion.

## Hospitality and recreation

Idle visitors can wait for the bartender's preparation and food/drink service,
then eat or sip. The rear service lane and individual handoff anchors align with
each stool. Unreachable service contacts leave the bartender waiting. The service
clock pauses during staff travel. Canceled visits
release their service request. The upper stool and avatar turn about the same
stationary shaft. These animations are scene-local and do not report agent work.

Two idle characters can reserve the existing sofa seats for one shared local
console rally. The TV replaces its media picture after both arrive; both read the
same ball and score, hold controllers, and release the session when either
returns to work. Resting controllers disappear as players pick them up.
This is ambient play between characters, not a playable commercial console game
or network multiplayer. Regular TV watching remains available.

Fitness users can run, pedal, lift, stretch, use the bench and pull the cable row.
Equipment only advances when its assigned occupant has reached the station.
A scene-owned presence registry retains settled fitness users after the separate
door/crowd walking registry releases them; departure and unmount clear usage.
Source and procedural rigs share the bike phase and reachable hand targets;
pedal platforms remain level, and cable geometry follows its moving handle.
Bench/cable stations participate in idle visits with seated strength clips.

Server rack equipment faces the inspection aisle, with status LEDs, ventilated
fronts, access-floor grilles, cable routing, cooling and the live room health
board. The inspection point leaves body clearance in front of the rack.

## Verification

- Fresh Blender GLB reimport compares all root origins, triangle counts and bounds
  against the manifest within 0.1 mm. Imported geometry tests also check seated
  contacts, moving-part pivots, live screen clearance, front-panel LEDs and the
  shade-only pendant contract.
- Loader tests cover material isolation, source immutability, disposal ownership,
  glass depth handling, solar/manual emission and reduced-motion LEDs.
- Movement tests cover physical preparation/service arrival, queued food/drinks,
  cancellation, two-player arrival/reservation cleanup, stool/character rotation,
  fitness availability and arm/leg contact geometry.
- Browser review loads the actual library in storage, pantry, server,
  entertainment and fitness configurations. The complete Office mounts every
  requested category with no missing authored parts. Review artifacts include
  `interior-library-preview.png`, `interior-*-app.png` and character-contact previews.
  Failed binary requests preserved storage, pantry and fitness counterparts;
  restoring the request reloaded all sampled authored parts. TV shared-game display
  and controller pickup visibility, 0.23-radian stool swivel, and pendant emissions
  of 1.55 by day, 4 at night and 0 with the manual override off were checked.
- Full `pnpm check` passes at v0.4.82: 223 suites / 2,371 passed tests (one skipped),
  lint, boundaries, public-safety, typecheck, Rust checks, Web/Desktop builds,
  synchronized versions and local avatar-asset checks.

Web and Desktop share this renderer. Native Desktop startup is not exercised
against a real user profile. Hermes was unavailable before worker execution;
Codex and local subagents completed the implementation and review.
