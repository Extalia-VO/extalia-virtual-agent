# Brand assets

| File | Use |
| --- | --- |
| `extalia-logo-light.svg` | Symbol and wordmark for light backgrounds |
| `extalia-logo-dark.svg` | Symbol and wordmark for dark backgrounds |
| `extalia-symbol.svg`, `extalia-symbol.png` | The `/>` symbol alone |
| `extalia-symbol-square.svg`, `extalia-symbol-square.png` | The symbol centered on a square canvas (avatars, app icons) |
| `social-preview.png` (`.svg` source) | 1280 × 640 repository social preview (GitHub → Settings → Social preview) |

The symbol uses the Virtual Office green gradient from its base to its top:
`#10b9ac` → `#83cb35` (55 %) → `#f8e719`. Wordmark text is `#1e1f22` on light
and `#ececee` on dark (Royal Charcoal) backgrounds.

The wordmark is drawn from the Righteous typeface outlines (SIL Open Font
License 1.1, see `apps/web/public/fonts/Righteous-OFL.txt`), so the files need
no web font. The same outlines and gradient drive the in-app logo
(`apps/web/src/branding/identity.ts`); regenerate these SVGs from there if the
identity changes.
