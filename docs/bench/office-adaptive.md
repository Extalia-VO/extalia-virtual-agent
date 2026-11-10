# Progressive Office rendering

The Office starts at the lowest render tier instead of allocating its sharpest
drawing buffer first. It adapts to observed foreground frame throughput, not
network bandwidth or a device-model allowlist. This is a rendering change;
agent execution, sessions and GLB files are unchanged.

## Resolution policy

| Physical short-edge ceiling | Live fixture beams | Shadow map | Maximum traffic cars |
| --- | --- | --- | --- |
| 480 pixels, initial tier | 0 | 512 | 6 |
| 720 pixels | 0 | 512 | 6 |
| 1080 pixels | 6 | 1024 | 10 |
| 1440 pixels | 6 | 1024 | 14 |
| 2160 pixels | 6 | 1024 | 16 |

The video-style names are approximate: a resizable Office is not necessarily
16:9. The canvas keeps its aspect ratio, uses at most native DPR or 2, and
never exceeds 3840 × 2160 total pixels. A standard-density small display will
not be supersampled to claim 4K. DOM text and controls keep their native
resolution. Higher quality is a ceiling, not a promise that every device can
reach it.

One-second windows below 40 fps reduce quality immediately; two windows below
45 fps also reduce it. Twelve windows at or above 57 fps permit one upgrade.
The sampler warms up for three seconds and settles briefly after a change.
Twice-failed tiers are not retried during that controller's lifetime. Hidden
time does not count; a remounted Office resumes its settled session tier.

Lower resolution reduces the size of the drawing buffer and fragment workload.
It does not reduce decoded mesh/texture allocations, model download sizes,
draw-call counts by itself, or the separate avatar portrait renderers. CPU-heavy
scenes can still be slow at 480p. Actual renderer resource counts and browser
measurements must remain separate from whole Desktop memory claims.

## Reproducible browser comparison

Freeze the current source into a QA-enabled, minified production-React bundle
before editing. The existing dirty source, rather than an older Git commit or
an earlier `dist`, is the comparison baseline. Serve separate before/after
bundles using Vite preview and fresh nonpersistent browser contexts with the
mock host. No real Extalia profile or provider is used.

`tooling/bench/office-adaptive.mjs` records the first observed canvas, a fixed
campus camera, frame windows, browser long tasks, JavaScript heap, drawing-buffer
dimensions and renderer resource counts. It also checks the highest pinned tier.
Use `PLAYWRIGHT_MODULE` when Playwright is installed outside this repository.
Example with a QA bundle served on loopback port 5400:

```sh
node tooling/bench/office-adaptive.mjs --url http://127.0.0.1:5400 \
  --label after --cpu 4 --dpr 2 --seconds 8 --initial-ceiling 480 \
  --output output/playwright/office-adaptive-after.json
```

CPU throttling is a browser simulation on the available machine. It does not
simulate a weaker GPU, memory bandwidth, limited physical RAM, thermal
throttling or a physical low-end computer. JavaScript heap is not total process
or GPU memory. Geometry and texture counts are counts, not allocated bytes.
First-observed canvas timing includes asynchronous initialization and is not a
certified cold-start metric. The optional `--initial-ceiling` check refuses an
initial short edge above that ceiling (with one pixel of rounding tolerance).
The sizing source is the canvas's full-size container, not its temporary
300 × 150 intrinsic box; an in-root layout reconciliation also applies the
budget before rendering. Display-density changes are followed even when the
CSS dimensions do not change.

## Observed comparison

The [before record](office-adaptive-before.json) and [after record](office-adaptive-after.json)
use Chrome 157 on macOS with a 1366 × 900 CSS viewport, native DPR 2, fourfold
CPU slowdown and three eight-second windows. The Office area is 1268 × 764.5
CSS pixels. The initial-resolution acceptance check passes after the container
measurement fix.

| Observation | Before | After |
| --- | ---: | ---: |
| First observed drawing buffer | 1585 × 955 | 796 × 479 |
| First observed pixels | 1,513,675 | 381,284 |
| Settled lowest-tier pixels | 474,545 | 381,284 |
| Median measured FPS | 7.0 | 7.3 |
| Worst-window FPS | 6.8 | 7.0 |
| Pinned highest-tier pixels | 1,513,675 | 3,877,544 |
| Page errors / failed HTTP responses | 0 / 0 | 0 / 0 |

The initial buffer contains about 75% fewer pixels and the settled buffer about
20% fewer. This does **not** establish a useful FPS or whole-app memory gain:
the deliberately CPU-throttled scene remains slow, GPU times stay near 9 ms,
and render submission stays near 100 ms. Resource counts and unforced-GC heap
readings differ between runs; these observations do not isolate mesh, texture
or CPU savings. A single pair of runs is not a statistical performance claim.
The higher pinned tier is a deliberate sharper-display ceiling, checked only
after the automatic measurements; it stays within native DPR and the pixel cap.
Additional physical-device and geometry/CPU optimization work remains necessary.

Visual QA covers light and dark themes plus a 390 × 844 viewport without
horizontal overflow or page errors. Native DPR resynchronizes to 2, 0.75 and 1
after resize events. CDP density-only overrides did not emit resize or media
change events in this browser, so this check dispatched resize explicitly;
it does not certify a physical monitor transition. The implementation also
re-arms a resolution media query to follow ordinary browser density events.

## Public GLB optimization backlog

Read-only inventory of the runtime public-model manifest found five regular
GLB files above both 5,000,000 bytes and 5 MiB. Paths below are relative to
`apps/web/public-assets/`; local-only assets and duplicated build outputs are
excluded. No GLB files were changed for progressive rendering.

| Public asset | Exact bytes | MiB | Embedded image bytes, approximate |
| --- | ---: | ---: | ---: |
| `avatars/outfits/male/outfit-black-business-suit.glb` | 20,397,732 | 19.45 | 52 KB |
| `avatars/outfits/male/outfit-sweatshirt-jacket-workwear.glb` | 10,857,156 | 10.35 | 299 KB |
| `avatars/wardrobe/female/top/source-flame-hoodie.glb` | 10,013,416 | 9.55 | 69 KB |
| `avatars/outfits/male/outfit-victorian-bartender.glb` | 7,741,352 | 7.38 | 181 KB |
| `avatars/outfits/female/reception-uniform.glb` | 5,989,688 | 5.71 | 294 KB |

These files primarily contain geometry and attributes; recompressing their
small embedded images alone cannot remove most of their bytes. Start a later
optimization pass with a dry run of `tooling/compact-garment-buffers.py`, which
can remove duplicate, unused and padded buffer data without simplifying meshes.
Evaluate geometry reduction separately where lossless compaction is insufficient.
Compare silhouettes, normals, UVs, materials, morphs, skinning, seated/walking
poses and all affected avatar combinations before accepting a smaller export.
Update manifest sizes/hashes and run public-model validation for every accepted
asset change. A smaller GLB download does not alone prove lower decoded memory
or fewer triangles; record those separately.
