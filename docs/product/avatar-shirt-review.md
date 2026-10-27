# Detailed shirt binding review

The formal male shirt had disconnected sleeves containing vertices bound to the
hips/spine. Neighbouring sleeve vertices followed the arm. Moving the hand
therefore stretched short garment edges into fins reaching the waist. Some
vertices above the elbow also followed the forearm. The previous pure-limb
weight cleanup could enlarge this existing discontinuity.

`sourceGarmentWeights.ts` identifies unilateral, cuff-reaching sleeve components
through position-welded triangle connectivity. It replaces their lower binding
with a smooth anatomical upper-arm/forearm blend, fades into the original
shoulder cap and retains hand influence near the cuff. Sleeveless torso panels
retain torso binding instead of following the arm. This runs before the
existing lower-limb cleanup.

The correction is restricted to recognized formal garment roles. Joined
sleeve/bodice topology remains unchanged, including the formal female blouse.
Rest positions, normals, UVs, indices, morphs, hand poses, feet and source files
are unchanged. Binding copies are cached per source geometry and rest skeleton.

Synthetic tests verify both sides, UV-seam welding, cap/cuff/collar preservation,
normalized influences, source immutability, torso isolation and an animated
short-edge stretch regression. Browser review covers typing, mouse, thinking,
phone, cup and idle poses from both sides using actual local source models.
This is a binding correction, not cloth simulation or a mesh redesign.

Validation completed in v0.4.65: 25 focused tests across garment, limb, foot,
hand and source-arm helpers passed. The full `pnpm check` passed with 190 suites
and 1,890 tests, plus Rust formatting/clippy/tests, lint, boundaries, type checks,
builds, version and local-asset validation. The installed Xcode tools were
selected for that process as in the preceding foot review. Browser checks
covered both formal source variants; the joined female blouse correctly
received no new binding. Desktop was built; startup smoke was not rerun because
of the existing real-profile auto-connect path noted in the foot review.
