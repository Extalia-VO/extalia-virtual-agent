# Static seating entry and shared-sofa access

Fixed sofas, armchairs, patio chairs and benches use a front-entry sequence rather than the workstation-chair maneuver. A character walks around the exterior furniture bounds, stops in front of its own cushion, turns in place, then lowers with a short backward hip translation and no walking gait. Standing reverses the controlled contact before walking forward into the clear apron. Work chairs, standing stations and fitness equipment keep their established behavior.

Adjacent sofa slots share an exterior footprint, preventing diagonal shortcuts across other cushions. Each slot has an independent front lane, including the middle of a three-seat sofa. Swept separation checks include seated and moving neighbors. A blocked approach or exit yields and retries; a still-standing visitor can be recalled along the route already traversed. Latest destination changes are preserved during lowering.

The controlled contact excludes only the target seat's rendered collision group and only within its narrow forward lane. Tables, neighboring furniture, other characters and upper-floor support remain checked. Stationary characters have a separate physical-presence registry so they do not create door-opening intent. Removal, reduced-motion placement and scene disposal update this registry. Dining armchairs are set back 40 cm in the shared layout to leave an actual standing/turning gap beside the table.

## Verification

- Regression tests cover mirrored/rotated exterior routes, narrow coffee-table gaps, rotated render bounds, middle-slot access with both neighbors occupied, block/release/retry, entry/exit cancellation, latest-goal reversal, no gait during lowering/rising and preserved work-chair/standing-station behavior.
- Target-seat collision tests preserve unrelated tables/chairs and upper-floor support. Presence tests cover persistent seated bodies, exclusion from door intent, duplicate suppression, removal and disposal with reduced motion.
- Browser probes use the actual rendered furniture bounds: all 22 navigation seats have valid exterior and controlled-contact routes. All 28 complete sit/stand cases, including six executive three-seat sofa slots with their neighbors occupied, finish with aligned lowering and no walking gait. Minimum neighbor separation is 0.80 m.
- A live source-avatar library-sofa cycle was visually inspected during lowering, seated rest and forward rise. The actual Office director completes entry and exit; the fully seated pose reports no walking blend.
- Version 0.4.90: full `pnpm check` passes on 2026-10-24, including lint, boundaries, public safety, schemas, workspace types, 238 suites / 2,595 passed tests (one skipped), Rust checks, Web/Desktop/CLI builds, version consistency and canonical hair assets.

Local browser screenshots and diagnostic scripts are not committed.
