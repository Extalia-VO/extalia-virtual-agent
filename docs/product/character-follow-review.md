# Character follow across floors

Delivered in 0.4.86 on 2026-10-23.

The camera reads the followed character's live floor on every rendered frame, including stair and elevator travel. Movement subscriptions report semantic changes rather than every vertical midpoint, so a page subscription alone would miss floor transitions.

Automatic floor updates change the shared toolbar/scene view without starting a floor overview or clearing tracking. The camera retains its relative position, target, zoom and pending focus animation. Orbit controls no longer receive a changing floor-preset target during Follow. Explicit view requests have a separate counter: choosing a floor, Building or All floors returns control to the user, including a request for the current floor. Dragging also cancels pending interpolation; wheel zoom retains Follow.

Elevator cabins and passengers remain drawn throughout the nearest floor's height band as well as their boarding/alighting floors. This covers F1–F3 express trips through F2. Stair geometry already spans both adjoining floor views.

## Verification

- Focused tests cover upward/downward through-trip visibility at 241 height samples, stair-floor visibility, ordinary floor isolation and automatic versus explicit view requests. Camera, movement, transit and controls suites pass 36 tests.
- Actual Office browser review activates Follow through its character card, then advances the production mover and elevator controller with controlled simulation time. Upward/downward stair routes and through-trips visit F1/F2/F3. Relative camera error stays below floating-point tolerance, with no floor-preset zoom reset or hidden in-transit cabin/character. A custom zoom is retained through stair travel; wheel zoom retains Follow.
- Explicit view ownership and drag cancellation are checked in the actual Office. The test session uses mock data and does not write a real profile.
- Full `pnpm check` passed: 229 suites, 2,414 tests passed and one skipped; Rust checks and Web, CLI and Desktop builds passed. Read-only review found no unresolved issues in the follow changes.
