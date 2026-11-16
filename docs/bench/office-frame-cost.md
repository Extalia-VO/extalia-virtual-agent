# Office frame cost on macOS

The 0.4.320 renderer targets 60 FPS and leaves the foreground frame loop
uncapped. Building and All Floors still miss the target. Individual floors
exceeded it with the default fixture on the tested machine.

| View | Before, day | After, day | Before, night | After, night |
| --- | ---: | ---: | ---: | ---: |
| Building | 33.4 | 44.8 | 30.4 | 35.3 |
| F1 | 67.7 | 90.3 | 54.9 | 91.6 |
| F2 | 74.7 | 122.5 | 77.6 | 116.9 |
| F3 | 67.1 | 108.9 | 79.6 | 101.9 |
| All Floors | 33.4 | 41.1 | 32.6 | 44.5 |

The values are render submissions per second from the slower of two four-second
windows. Both builds used a 1600 × 1000 viewport, a 1502 × 864 drawing buffer,
DPR 1, the same camera controls,
seeded traffic, the default mock roster and fixed scene resources. The driver
verifies the selected floor and the day/night lighting state. The baseline is
commit `12f400cb` with matching benchmark instrumentation. The host was an Apple
M3 Max with Chrome 157 and ANGLE Metal. Chrome ran in uncapped diagnostic mode.
Physical display refresh, shared machine load, shader warm-up and live animation
can change the observed FPS. Sustained throughput on other machines and in
packaged Desktop builds still needs measurement.

Fixed transforms cover 86 model roots with 1,141 nodes in the default fixture.
The mounted roster's distinct skeletons fell from 341 to 24. The maximum tested
view in the table reached 122.5 render submissions per second. Both runs finished
with zero page errors and failed HTTP responses.

| 48 arrived avatars, night | Before FPS | After FPS | Draws/frame before → after |
| --- | ---: | ---: | ---: |
| Building | 22.7 | 25.7 | 3,313 → 3,174 |
| F1 | 31.2 | 40.9 | 2,062 → 1,895 |

The crowd fixture mounted 2,106 distinct skeletons before sharing and 150 after.
The unique backing buffers for skinned geometry totaled about 60 MB in both
runs. Other app and build activity varied during the crowd runs, so the FPS
differences are indicative. The buffer totals describe CPU-side geometry arrays.

A separate resolution sensitivity run reduced the Building buffer from
1502 × 864 to 826 × 475, about 70% fewer pixels. Daytime throughput moved
from 27.9 to 30.0 FPS and nighttime from 35.1 to 40.4 FPS during concurrent
test activity. The night result shows some pixel sensitivity. Both cases stayed
below 60 FPS. The application starts at its
1080-pixel ceiling and requires repeated evidence before retaining a drop.

Earlier trials compared GPU buffer size, broad geometry detail thresholds,
static transform forests and material multi-draw. The wider culling thresholds,
forest and multi-draw were dropped after they failed to deliver a consistent
throughput gain. The render-only hidden-branch traversal uses stable callbacks
installed when branches mount, avoiding method replacement on each frame.
Night Building remains limited by both scene submission and GPU lighting work.
At DPR 1 it submitted about 2,585 draws and 7.34 million triangles per frame
with about 26 ms inside `renderer.render` and 20 ms of GPU time. The CPU and GPU
measurements overlap.

## Reproduce

Serve a frozen development-mode Web build on loopback with its benchmark hooks
enabled. Run the baseline and candidate sequentially on the same machine and
compare the recorded camera, lighting, population and drawing-buffer dimensions.

```sh
node tooling/bench/office-frame-cost.mjs --url http://127.0.0.1:5457 \
  --output output/office/frame-cost.json --uncapped
node tooling/bench/office-frame-cost.mjs --url http://127.0.0.1:5457 \
  --output output/office/crowd.json --views campus,1 --times night \
  --office-load 48 --uncapped
```

Use `--views campus --ratios 1,0.55` to change the drawing buffer while retaining
the same scene resources. Use `--cpu 4` for a CPU-throttling sensitivity check.
Raw results include timing, scene counts and renderer details. The performance
acceptance gate stays open in the [Office PRD tracker](../product/prd-app-flow-and-live-agents.md).
