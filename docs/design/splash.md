# Splash background loop

The Splash (`apps/web/src/boot/Splash.tsx`) shows the EXTALIA wordmark and the
boot status over a short, pre-rendered loop of the real 3D Office. It never
mounts the WebGL `OfficeCanvas`. The video is decoration only, so it never
changes boot timing: the Splash still leaves as soon as boot settles, and stays
at least 700 ms only when boot is fast (`boot/bootState.ts`).

## Assets

| File (`apps/web/public/splash/`) | Content | Size |
| --- | --- | --- |
| `office-loop.webm` | Night (lit windows), VP9, 1280×720, 30 fps, 10 s | ≈ 1.8 MB |
| `office-loop.mp4` | Night, H.264 High fallback | ≈ 1.8 MB |
| `office-poster.webp` | Night, first frame of the loop | ≈ 65 KB |
| `office-loop-day.webm` / `.mp4` | Daylight versions | ≈ 1.8 MB each |
| `office-poster-day.webp` | Daylight first frame | ≈ 90 KB |

The dark theme plays the night loop and the light theme plays the day loop. The
Solar theme follows whichever of the two it resolved to at launch.

## Behavior

- The poster `<img>` paints immediately. The muted, inline `<video>` (`loop`,
  `autoplay`, `preload="auto"`, `aria-hidden`) fades in on `canplay`.
- WebM comes first and MP4 is the fallback. A decode error on one format
  remounts the video with the next format. If no format can play, only the
  poster stays.
- `prefers-reduced-motion` and Save-Data (`navigator.connection.saveData`) never
  create the video and show only the poster. Reduced motion also stops the slow
  pan of the scene.
- `prefers-reduced-transparency` replaces the gradient scrim and the glass card
  with near-opaque fills.
- A theme-aware scrim (`--canvas`) and a glass card keep the wordmark and the
  status label readable. With the Standard material the card is opaque.
- Hosts:
  - Desktop allows `media-src 'self'` in its CSP. The `extalia://` scheme is
    registered with `stream: true` and serves `.webm`/`.mp4` in byte ranges
    (`serveMedia` in `apps/desktop/src/main.ts`).
  - The Bridge serves `video/webm`, `video/mp4` and `image/webp`, answers
    `Range` with 206 responses, and also allows `media-src 'self'`.
  - The desktop smoke test (`pnpm test:desktop`) checks that the loop reaches
    `canplay` and that a range request returns 206.

## Re-rendering

`tooling/capture-splash.mjs` renders the loop from the real scene:

1. It starts a Vite dev server for `apps/web` on port 5197, or uses the server
   passed with `--url`.
2. It opens `/?mock=ready&avatars=procedural` at 1920×1080. The development-only
   `avatars=procedural` flag (`office/scene/avatars/sourceAssets.ts`) ignores
   the git-ignored local avatar models, so only the procedural characters, which
   may be redistributed, appear in shipped renders.
3. It pins the top render budget, sets the time of day with
   `__EXTALIA_SOLAR_PREVIEW__` (19:40 for night, 10:30 for day), switches the
   R3F frame loop to `never` and steps it with a fixed 1/30 s timestep. Each step
   puts the camera on a periodic sway, dolly and rise around the Campus, then
   reads the frame from the canvas.
4. The camera path has a period equal to the clip length, so the view meets
   itself at the loop point. ffmpeg cross-fades the last second into the first
   so that moving people also loop without a seam. It then downsamples to
   1280×720 (anti-aliasing), converts to limited-range BT.709 (hardware decoders
   rejected full-range VP9 now and then), and runs two-pass encodes at
   1500 kb/s. Chromium encodes the WebP poster.

```sh
# Requirements: ffmpeg with libvpx-vp9 and libx264, and Playwright with Chromium.
node tooling/capture-splash.mjs                      # both variants into apps/web/public/splash
node tooling/capture-splash.mjs --variants night --still --frames /tmp/splash   # framing check only
node tooling/capture-splash.mjs --encode-only --frames /tmp/splash               # re-encode kept frames
```

Environment variables: `PLAYWRIGHT_MODULE` (a module name or a path to
Playwright's `index.mjs`), `CHROME_PATH` (a browser executable; on macOS it runs
with ANGLE/Metal), and `FFMPEG`. Other options: `--seconds`, `--fps`, `--fade`
and `--out`. A capture of both variants takes about 3 minutes on an Apple-silicon
laptop.

After re-rendering, check that each video is ≤ 2.5 MB and each poster is
≤ 150 KB, then look at a few frames. Run `node tooling/check-public-safety.mjs`;
binary media are skipped by its text scan, and the tool writes no paths into
the files. Never capture without `avatars=procedural`: the local avatar models
have no redistribution license.
