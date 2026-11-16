# Progressive Office rendering

The Office starts at the 1080-pixel render tier, then attempts sharper tiers when
foreground throughput permits. It adapts to observed frame throughput, not
network bandwidth or a device-model allowlist. This is a rendering change;
agent execution, sessions and GLB files are unchanged.

## Resolution policy

| Physical short-edge ceiling | Live fixture beams | Shadow map | Maximum traffic cars |
| --- | --- | --- | --- |
| 720 pixels, lowest trial | 6 | 1024 | 10 |
| 900 pixels | 6 | 1024 | 10 |
| 1080 pixels, initial tier | 6 | 1024 | 10 |
| 1440 pixels | 6 | 1024 | 10 |
| 2160 pixels | 6 | 1024 | 10 |

The video-style names are approximate: a resizable Office is not necessarily
16:9. The canvas keeps its aspect ratio, uses at most native DPR or 2, and
never exceeds 3840 × 2160 total pixels. A standard-density small display will
not be supersampled to claim 4K. DOM text and controls keep their native
resolution. Higher quality is a ceiling, not a promise that every device can
reach it.

The controller pursues 60 FPS; it does not cap the frame loop or higher display
refresh rates. Three stable slow foreground windows permit an adjacent resolution
trial. The lower resolution survives only when three warmed candidate windows
save both at least 10% and 2 ms per frame. Ineffective or unstable trials restore
the confirmed resolution and wait 60 foreground windows before retrying.
Lights, shadow settings, geometry detail and traffic remain fixed across these
pixel-only trials. The old 480-pixel fallback has been removed.

Six windows near 60 FPS can start a sharper-resolution trial. A periodic trial
also checks whether sharpness can be restored when a CPU-bound scene remains
below 60 FPS. An expensive restoration rolls back and waits 60 foreground
windows. Camera, composition, size, visibility and context changes invalidate
unproven comparisons. The sampler warms up for three seconds and settles briefly
after each change. Hidden time does not count; a remounted Office resumes its
settled session tier. Background CPU/GPU load can still affect comparisons;
these trials are a conservative adaptation heuristic, not causal profiling.

A small top-left FPS badge updates once per measurement window without rerendering
the scene. It reports unfiltered rendered throughput, including hitches; the
quality controller uses the lower of raw and filtered throughput. A single slow
window cannot retain lower quality, while recurring stalls cannot be hidden by
trimming their longest frame. Hidden/resumed and unmounted canvases clear the readout until fresh
frames are measured. Desktop uses this same renderer and policy; normal Desktop
launches have no separate quality cap or software-WebGL switch.

Lower resolution reduces the size of the drawing buffer and fragment workload.
It does not reduce decoded mesh/texture allocations, model download sizes,
draw-call counts by itself, or the separate avatar portrait renderers. CPU-heavy
scenes can still be slow after a large pixel reduction. Actual renderer resource counts and browser
measurements must remain separate from whole Desktop memory claims.

## Hidden character poses and graphics recovery

Characters on hidden floors continue their movement simulation and retain body,
seat, door and lift ownership. Their invisible rigs skip facial, skeletal,
clothing and hair pose work. Visibility includes every ancestor; this does not
cull an offscreen character that could still cast a visible shadow. Revealing a
rig forces a current pose on its first frame at every detail tier, drops pending
hidden pose time, and refreshes clip, hand and forearm blends from current state.
Hidden character groups also stop recursive raycasts before testing their model
meshes. The final hit-visibility filter remains in place for independently
registered hover volumes; visible hit ordering and identity are preserved.

A lost WebGL context pauses the Office frame loop and displays recovery controls
while sessions and the prompt composer remain available. Browser restoration
retains the same canvas, scene and characters, then requires healthy frames
before removing the overlay. An explicit restart creates a new scene attempt
without remounting the composer or discarding its draft and attachments. A
failed lazy engine import also gets a fresh attempt only when Retry is selected.
FPS sampling forgets the interrupted interval instead of interpreting it as a
slow foreground frame.

Source-avatar body and hair clones explicitly release their instance materials
and skeleton bone textures when replaced or removed. Fitted outfit skeletons
are owned too; linings and native footwear can share a body's instance skeleton,
so cleanup deduplicates it. Shared asset geometry, ordinary material maps and
cached garment corrections stay available to other characters. Fresh, uncached
waist-backing geometry and its final morph derivative are registered against
their particular clone and released only while attached to it. Never-rendered
intermediates are not mistaken for the final GPU allocation. Cleanup permits a second release after
StrictMode has rendered the same resources again and recreated their GPU state.

In a mixed twenty-avatar mount/removal fixture, material-only cleanup retained
584 additional bone textures per full cycle. Explicit skeleton cleanup returned
the empty renderer to the same 59-texture baseline for three cycles, including
a cleanup/render/cleanup replay. These are resource counts in that fixture,
not bytes, a universal empty-scene budget or a measured application FPS gain.
Repeated wardrobe geometry allocations are checked separately from textures.

Within each owned source-avatar clone, meshes now share a skeleton only when
their ordered live bone objects and every finite inverse-bind matrix match
exactly. Fitted pieces reuse their compatible rebound skeleton. Different
characters retain independent bones and pose state; geometry, materials, morph
controls and each mesh's bind frame remain unchanged. Redundant privately owned
bone textures are disposed without releasing textures retained by another mesh.
This reduces pose-resource duplication; it does not merge avatar draw calls or
by itself establish a useful FPS improvement.

Compatible opaque surfaces from a fitted outfit also share a draw mesh when
their material values, palette role, bind frame and morph layout agree. Each
avatar still has its own pose and appearance. Repeated sets share immutable
merged geometry buffers. Fixed furniture clones reuse world transforms when
their placement is stable, and the renderer skips its transform traversal for
hidden floor and campus roots. The surrounding district is batched per building
so offscreen geometry can leave the draw list at any camera zoom.

The Building view and F1 cutaway share one mounted front-arrival context. It
reuses the existing paving, entrance walk, forecourt lamps and benches at their
original positions; F2 and F3 hide it. This gives the front outdoor approach a
visible surface without drawing the full neighborhood or duplicating fixture
and seat registration. It does not add context for every side/rear outdoor
outing, and static avatar placement screenshots do not establish seating or
floor-support physics.

The 2026-11-12 lifetime audit recovered 228 raw camera samples spanning 119.828
minutes from a frozen v0.4.282 bundle. Canvas, renderer and scene identity were
stable at every observation, including a controlled context restoration. A
302.708-second collection gap leaves that interval unobserved; 31 unique
post-restoration WebGL warnings were retained separately from page errors.
This older bundle is not proof for subsequent movement or resource changes.

A separate frozen v0.4.284 bundle containing the clone cleanup produced 78 raw
resource samples spanning 45.007 minutes. All 339 observed retired bone textures
received disposal, with no observed missing disposal or page/console errors.
Its 251.51-second collection gap leaves transient entrants and retirements
unknown. These are bounded mocked-roster observations under shared machine
load, not a whole-memory, leak-free or application-FPS claim.

GPU cache counts can warm up again after restoration; they are not byte-level
memory measurements. The pinned Three.js version can report stale-context
deletion warnings when surviving meshes release pre-restoration listeners.
These cleanup warnings require separate observation from JavaScript errors,
missing geometry or stopped frames; successful rendering alone does not prove
the absence of a memory leak.

## Reproducible browser comparison

See the [0.4.320 frame-cost measurements](office-frame-cost.md) for matched
Building, single-floor, All Floors, crowd and drawing-buffer comparisons.

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
  --label current --cpu 4 --dpr 2 --seconds 8 --initial-ceiling 1080 \
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

## Historical 480p-start comparison

The records below precede the 1080p startup and retry policy. They are evidence
for the earlier allocation change, not a performance measurement of the current policy.
Their artifacts do not record the selected floor or automatic-camera state.
They therefore do not establish Building-view throughput: an automatic camera
can follow a character into a floor view even when fixed coordinates were set.
The current frame-cost driver explicitly selects and verifies each view.

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
