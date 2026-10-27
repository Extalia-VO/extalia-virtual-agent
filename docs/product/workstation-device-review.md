# Workstation device placement

Avatars face +Z with +Y up. In that right-handed frame, anatomical right is
forward cross up, or −X. Some bundled bones carry mirrored side names, so those
names cannot establish handedness. The initial v0.4.68 review checked matching
prop and wrist targets but incorrectly called +X the avatar’s right.

The correction puts the mouse at −X in the avatar frame and uses geometric
hand-goal index 0. The keyboard model’s +X is sitter-right: full keyboards keep
the number pad beside the mouse, while their letter block stays centered on the
avatar. The cup moves to the opposite side. Tests derive right from the facing
vector independently of the placement helper, including rotated pod seats.

The mouse’s distance and angle relative to the keyboard vary per seat. Its
position within the pad also varies independently, with the complete mouse
footprint supported and the pad clear of the keyboard. Variations remain stable
across renders. Single and touchdown desktops are deeper so every seeded
keyboard leaves over 10.5 cm at the front for palm support without pushing the
existing arm targets beyond reach. Pod, executive and reception inputs retain
their supported positions. The screen/laptop spacing and executive blotter
height corrections from v0.4.68 remain in place.

Verification:

- 62 focused tests across layouts, typing reach, arm IK, hand contact, device
  support and facility staff. Tests cover every registered office workstation,
  500 seeded keyboard/pad footprints, independent anatomical side checks,
  random mouse-on-pad offsets and mouse-state selection of the negative-X arm.
- Actual source avatars and furniture were rendered in ten browser configurations:
  single PC, single dual monitor, single laptop, touchdown, four pod variants,
  executive and reception. Rear views verify the mouse on the sitter’s visible
  right. Rendered keyboard and mouse positions match avatar-frame targets within
  numerical precision. Local ignored images are under
  `output/playwright/desk-right-*`.
- Full `pnpm check` passed in v0.4.73: 210 suites, 2,265 tests passed
  and one skipped; Rust formatting/clippy/tests, lint, boundaries, public safety,
  type checks, Web/CLI/Desktop builds, version and character-asset checks passed.

This adjusts furniture placement and shared hand targets, not the source rig.
Desktop startup smoke retains the real-profile auto-connect exclusion documented
in the avatar foot review; Web and Desktop share the renderer.
