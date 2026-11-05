#!/usr/bin/env node
/**
 * Counts blinking pixels in the Splash loops: a pixel that jumps away from both its previous and
 * next frame in the same direction (on-off-on). Camera sway and moving traffic change pixels
 * smoothly and barely count; lit windows that pop in and out every frame count a lot.
 *
 * Usage: node tooling/check-splash-flicker.mjs [video ...]   (default: every loop in apps/web/public/splash)
 * Exits 1 when a video averages more than LIMIT blinking pixels per frame at 320x180. Needs ffmpeg.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 320, H = 180, JUMP = 70, LIMIT = 25;
const splash = path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/public/splash');
const videos = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(splash).filter(name => /^office-loop.*\.(webm|mp4)$/.test(name)).map(name => path.join(splash, name));

let failed = false;
for (const video of videos) {
  const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`ffmpeg could not decode ${video}`);
  const size = W * H, frames = Math.floor(result.stdout.length / size);
  let blinks = 0;
  for (let index = 1; index < frames - 1; index++) {
    const a = (index - 1) * size, b = index * size, c = (index + 1) * size;
    for (let p = 0; p < size; p++) {
      const before = result.stdout[b + p] - result.stdout[a + p], after = result.stdout[b + p] - result.stdout[c + p];
      if (Math.abs(before) > JUMP && Math.abs(after) > JUMP && before * after > 0) blinks++;
    }
  }
  const average = blinks / Math.max(1, frames - 2);
  const ok = average <= LIMIT;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.basename(video)}: ${average.toFixed(1)} blinking pixels per frame (limit ${LIMIT})`);
}
process.exit(failed ? 1 : 0);
