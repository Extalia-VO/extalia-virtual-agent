# Themes and surface styles

The interface has two independent settings, stored per device:

| Setting | Values |
| --- | --- |
| Theme | Solar cycle, Match system, Light, Dark (Royal Charcoal) |
| Surface style | Standard, Liquid glass, Liquid Glass Pro |

All colors are CSS custom properties on `:root` in `apps/web/src/styles.css`;
components use tokens (`--surface`, `--text`, `--muted`, `--accent`, …), never
raw colors.

## Dark: Royal Charcoal

A neutral charcoal instead of navy, so the blue Extalia accent and status
colors stay clear: canvas `#1e1f22`, panels around `#2a2c30`, borders from
`#47484c`/`#4c4e51`, text `#ececee`, secondary text `#a4a6ab`, accent `#6aa8ff`.
Body and secondary text meet WCAG AA contrast on every surface.

## Liquid glass

Translucent panels over a static color field: 28 px backdrop blur with
saturation, a bright top edge, a specular sheen, pill-shaped controls and a
glossy primary button using the logo's cyan-to-blue gradient. It works with
both themes (pastel in Light, violet and cyan glows on charcoal in Dark).

Liquid glass rules:

- Only the panels blur; text is never blurred and the background never
  animates.
- `prefers-reduced-transparency: reduce` switches every glass surface to an
  opaque one; `prefers-reduced-motion: reduce` removes entrance animations.
- Backdrop blur costs GPU time. Over the eventual 3D office (final integration milestone) the renderer's
  quality presets may disable it automatically on slow devices.

## Liquid Glass Pro

An opt-in, CSS-only interpretation of the Plasma UI workspace look
(<https://cruxgarden.github.io/plasma-ui/examples/workspace/>), next to (not
replacing) the two styles above. Stored as `material: 'liquid-glass-pro'` and
applied as `<html data-material="liquid-glass-pro">` through the same
`setRootData` path as the other styles, so a switch cross-fades with the View
Transitions API and never remounts the 3D canvas. Every rule lives in one
block at the end of `apps/web/src/styles.css` (`v0.0.21 theme: Liquid Glass
Pro v2`) scoped under that attribute. No WebGL and no dependency.

Composition (v2, v0.0.21):

- **Plasma field.** A static base (`.shell::before`, `.setup::before`) plus two
  drifting layers of large, pre-softened radial gradients (`.shell::after`,
  `.main::before`, `.setup::after`; fixed, oversized by 18 vmax). They move
  only by `transform` (translate/rotate/scale) on 56 s and 72 s alternating
  cycles, so the compositor animates them without layout, paint or blur.
  The field is paused on the 3D Office (`.office-mode`), while the document is
  hidden (`<html data-document-hidden>`, set by
  `apps/web/src/ui/documentVisibility.ts`), removed under reduced
  motion (static) and replaced by the flat canvas under reduced transparency.
  When the welcome wizard shows its 3D-office poster, the drifting layer is
  hidden so the poster stays primary.
- **Slabs.** The rail, the top bar, the content frame (`.content`, which now
  holds every page, Chat and the Office stage) and the setup card are thick
  glass slabs: a translucent gradient body, a beveled double edge (dark 1 px
  outer line + bright inner top line + soft inner glow band + shaded lower
  edge), a magenta/cyan chromatic halo outside, and an **iridescent refractive
  rim**: a `::after` ring painted with a conic spectrum under a white specular
  gradient and cut out with `mask-composite: exclude` (2 px).
- **Nested plates.** Cards, the chat list, tool/approval cards and the composer
  are darker (Light: whiter) frosted plates with a hairline, inside the slab.
  The rail, the top bar and the setup card draw their own inner plate with
  `::before` (inset 7 to 9 px), so the glass thickness shows around it.
- **Selection.** The selected rail item, segment, toggle button, highlighted
  menu option and user bubble are the solid "on" pill: light with dark text
  in Dark, dark ink with light text in Light. Primary buttons are the same
  pill inside an iridescent 1 px ring; switches fill with the spectrum.
- **Scroll containers** (Office panels and board, dialogs, menus, toasts, the
  phone-width rail strip, the rail in windows under 640 px tall) use a
  box-shadow chromatic edge (pink left, cyan right, mint top, amber bottom)
  instead of a pseudo-element, which would scroll with their content.
- **Geometry.** 12 px gutters (8 px on phones), 26 px slab radius, 18 px plate
  radius, pill buttons and inputs. The Office rail column includes its inset,
  so widening the rail on hover never resizes the scene.

Palettes:

| | Light (pearly) | Dark (tidal) |
| --- | --- | --- |
| Field | `#dde4f2` with sky, lavender, mint, pink and butter blobs | `#040b13` with teal, violet, cyan, orchid and green blobs |
| Plate | white 62 % | `rgb(6 15 23 / 56%)` |
| Text / secondary | `#0d1a22` / `#45525f` | `#eef4f6` / `#a9b7c3` |
| Accent | `#1d5fc4` | `#7cc8ff` |
| "On" pill | `rgb(13 26 34 / 88%)` + `#f2f6f8` | `rgb(238 244 246 / 92%)` + `#06121a` |

Rules:

- Blur budget: only the top bar (content scrolls under it), toasts and popover
  menus blur, at `--pro-blur` (14 px). Overlays above the 3D stage use
  `--pro-stage-blur` (8 px) at 82 to 84 % opacity. The rail, frame, cards,
  chat panels and select triggers do not blur (the field is already soft, so
  translucency reads as frost); the widened Office rail and dialog scrims do
  not blur; no `backdrop-filter` is transitioned or animated.
- Text is never filtered. Measured with a pixel sampler on the rendered page
  (10th-percentile background behind each text box, 1440 × 900, Settings,
  Chat, Office at night and setup): every body and secondary text item meets
  WCAG AA in both themes; the lowest were 4.57:1 (Light, Office hint over the
  daytime scene) and 5.98:1 (Dark, Office panel badge).
- `prefers-reduced-transparency: reduce` makes every surface opaque, removes
  the field layers and all blur, and keeps only a faint rim;
  `prefers-reduced-motion: reduce` stops the field and removes chrome
  transitions and hover lifts.
- The Mood presets of the demo (Tidal, Aurora, Ember) are not offered as a
  setting: the shared profile (`ProfilePreferences`) has no field for it.
  The palette is one token set per theme, so a mood would be a token override
  under one more root attribute.

### Plasma UI library (Track B): measured, not shipped

`@cruxgarden/plasma-ui` 0.8.0 (MIT, zero runtime dependencies, React ≥ 18 peer)
was checked as an opt-in backdrop/chrome effect and is **not** a dependency.

Compatibility: it works under the Desktop CSP (no `eval`, no workers or blob
scripts; it injects one `<style>` element, allowed by `style-src 'self'
'unsafe-inline'`), builds as plain ESM for Vite, and accepts React 19. Its
bundle is 93.6 kB minified, 31.9 kB gzip. It draws every surface itself into
one full-viewport WebGL2 canvas (about eight render targets, quality up to
1.25 × DPR) on a continuous `requestAnimationFrame` loop that stops only for
hidden documents.

Measurement (headless Chromium with ANGLE/Metal, Apple silicon, 1440 × 900 at
2 × DPR, Office at night, Agents panel and three lead cards open, render
budget pinned to level 0, `requestAnimationFrame` count over 5 s after a 5 s
settle, four interleaved rounds, medians; indicative only):

| Variant | vsync on (fps) | vsync off (fps) |
| --- | --- | --- |
| Liquid Glass Pro v2 (Track A) | 56.9 | 43.8 |
| + Plasma UI field behind the shell | 53.5 (−6 %) | 34.2 (−22 %) |
| + field and rail/top bar as Plasma surfaces | 49.8 (−12 %) | 30.6 (−30 %) |
| Liquid glass, for reference | 57.2 | not measured |

The acceptance bar was a drop under 5 % on the Office; even the field alone
misses it, and the drop grows with surfaces. The library would also have to
own the panels' rendering (its surfaces are canvas-drawn, not CSS), which
conflicts with the Office overlays. It stays out until it can render a
static or paused field (no per-frame redraw) and stay under the 5 % bar.

## Checking changes

Check UI changes in every theme × surface combination (Light/Dark ×
Standard/Liquid glass/Liquid Glass Pro, six in total), at phone width, and on
Office with a panel open at night. For Liquid Glass Pro also check
scrolled pages (the rims must not move), the setup wizard,
reduced transparency and reduced motion (Chromium DevTools → Rendering →
emulate CSS media features). The desktop smoke test captures screenshots:
`EXTALIA_SMOKE_SCREENSHOTS=<dir> pnpm test:desktop`.
