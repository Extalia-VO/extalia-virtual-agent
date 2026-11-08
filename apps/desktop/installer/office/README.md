# Installer Office photographs

These three JPEGs are raster captures of Extalia's own Office renderer, using the
synthetic `?mock=ready` workspace. They contain no user workspace or profile data.

- `office-building.jpg`: campus exterior.
- `office-workspace.jpg`: first-floor workspace overview.
- `office-collaboration.jpg`: second-floor collaboration overview.

Disable Auto camera and close character overlays before capturing the main Office
WebGL canvas. Capture the canvas pixels, rather than the surrounding app interface.
The installer applies its crop, opacity and fading edges in CSS; the static DMG
uses the same source photograph with an SVG mask. No 3D scene runs in the installer.

Scene model attribution and licensing remain in
[`apps/web/public-assets/THIRD_PARTY_NOTICES.md`](../../../web/public-assets/THIRD_PARTY_NOTICES.md)
and the corresponding asset inventories. These captures do not relicense the
underlying third-party models.

After replacing a photograph, run `pnpm --filter @extalia/desktop installer:art`
and commit the generated artwork and fingerprint manifest together. Packaging
rejects stale photographs, copy, brand paths or generated artwork.
