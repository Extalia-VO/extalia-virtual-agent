# Themes and surface styles

The interface has two independent settings, stored per device:

| Setting | Values |
| --- | --- |
| Theme | Match system, Light, Dark (Royal Charcoal) |
| Surface style | Standard, Liquid glass |

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

Rules:

- Only the panels blur; text is never blurred and the background never
  animates.
- `prefers-reduced-transparency: reduce` switches every glass surface to an
  opaque one; `prefers-reduced-motion: reduce` removes entrance animations.
- Backdrop blur costs GPU time. Over the eventual 3D office (final integration milestone) the renderer's
  quality presets may disable it automatically on slow devices.

Check UI changes in all four combinations and at phone width. The desktop
smoke test captures them:
`EXTALIA_SMOKE_SCREENSHOTS=<dir> pnpm test:desktop`.
