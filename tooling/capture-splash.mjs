#!/usr/bin/env node
/**
 * Re-renders the Splash background loop from the real 3D Office (see docs/design/splash.md).
 *
 * It opens the web app's development build with the mock host (`?mock=ready`) and procedural
 * characters only (`?avatars=procedural`, so local-only avatar models never reach a shipped
 * render), pauses the R3F frame loop and steps it with a fixed timestep while the camera sways
 * around the Campus on a periodic path. Each frame is read from the WebGL canvas, the last
 * second is cross-faded into the first so the clip loops without a seam, and ffmpeg encodes:
 *
 *   apps/web/public/splash/office-loop[-day].webm   VP9, 1280x720
 *   apps/web/public/splash/office-loop[-day].mp4    H.264 fallback
 *   apps/web/public/splash/office-poster[-day].webp first frame, encoded by Chromium (reduced motion, Save-Data, errors)
 *
 * Usage: node tooling/capture-splash.mjs [--url http://127.0.0.1:5180] [--variants night,day]
 *          [--seconds 10] [--fps 30] [--fade 1] [--out apps/web/public/splash] [--frames <dir>] [--still] [--encode-only]
 * --encode-only re-encodes frames kept by an earlier run with --frames (for tuning the encoder settings).
 * --still writes the posters and four quarter-cycle frames (with --frames) to check the framing without encoding.
 * Environment: PLAYWRIGHT_MODULE (module name or path of a Playwright build, default `playwright`),
 *              CHROME_PATH (browser executable, default Playwright's Chromium), FFMPEG (default `ffmpeg`).
 * Without --url a Vite dev server for apps/web is started on port 5197 and stopped afterwards.
 */
/* global document, window -- page.evaluate callbacks run in the browser */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Scene time of day per variant (minutes after local midnight). Night shows the lit windows. */
const VARIANTS = {
  night: { minutes: 19 * 60 + 40, suffix: '' },
  day: { minutes: 10 * 60 + 30, suffix: '-day' },
};
/** Encoded size; frames are rendered at 1.5x and downscaled, which anti-aliases the scene. */
const OUT_W = 1280;
const OUT_H = 720;
const RENDER_W = 1920;
const RENDER_H = 1080;
/** Average video bitrate per file. */
const ENCODE_KBPS = 1500;

function parseArgs(argv) {
  const options = { url: '', variants: ['night', 'day'], seconds: 10, fps: 30, fade: 1, out: path.join(root, 'apps/web/public/splash'), frames: '', still: false, encodeOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${flag} needs a value`); return next; };
    if (flag === '--url') options.url = value();
    else if (flag === '--variants') options.variants = value().split(',').map(item => item.trim()).filter(Boolean);
    else if (flag === '--seconds') options.seconds = Number(value());
    else if (flag === '--fps') options.fps = Number(value());
    else if (flag === '--fade') options.fade = Number(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--frames') options.frames = path.resolve(value());
    else if (flag === '--still') options.still = true;
    else if (flag === '--encode-only') options.encodeOnly = true;
    else if (flag === '--help' || flag === '-h') { console.log(readUsage()); process.exit(0); }
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const name of options.variants) if (!VARIANTS[name]) throw new Error(`Unknown variant ${name} (use ${Object.keys(VARIANTS).join(', ')})`);
  if (options.encodeOnly && !options.frames) throw new Error('--encode-only needs --frames <dir> from an earlier capture');
  if (!(options.seconds > 1 && options.fps >= 12 && options.fade >= 0 && options.fade < options.seconds)) throw new Error('Invalid --seconds/--fps/--fade');
  return options;
}

function readUsage() {
  return 'node tooling/capture-splash.mjs [--url <dev server>] [--variants night,day] [--seconds 10] [--fps 30] [--fade 1] [--out <dir>] [--frames <dir>] [--still] [--encode-only]';
}

async function loadPlaywright() {
  const name = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const specifier = path.isAbsolute(name) ? pathToFileURL(name).href : name;
  try { return await import(specifier); }
  catch (error) { throw new Error(`Playwright is required (set PLAYWRIGHT_MODULE or install it, e.g. \`npx playwright install chromium\`): ${error.message}`, { cause: error }); }
}

function ffmpeg(args) {
  const bin = process.env.FFMPEG || 'ffmpeg';
  const result = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${bin} ${args.join(' ')})`);
}

async function startDevServer() {
  const port = 5197;
  const child = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], { cwd: path.join(root, 'apps/web'), stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Vite dev server exited early');
    try { if ((await fetch(url)).ok) return { url, stop: () => child.kill() }; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  child.kill();
  throw new Error('Vite dev server did not start');
}

/**
 * Camera pose at scene time `t` (seconds). Every term has period `seconds`, so the first and
 * last frames meet: a gentle sideways sway around the Campus with a slight dolly and rise.
 */
function poseAt(t, seconds) {
  const phase = (2 * Math.PI * t) / seconds;
  const target = [2, 16.5, -3];
  const yaw = Math.atan2(-79, -34) + 0.075 * Math.sin(phase);
  const radius = 86;
  const height = 12.4 + 1.2 * Math.cos(phase);
  const position = [target[0] + radius * Math.cos(yaw), target[1] + height, target[2] + radius * Math.sin(yaw)];
  const zoom = (RENDER_H / 56) * (1 + 0.03 * Math.cos(phase));
  return { position, target, zoom };
}

const fromDataUrl = url => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

async function preparePage(browser, url, minutes) {
  const page = await browser.newPage({ viewport: { width: RENDER_W, height: RENDER_H }, deviceScaleFactor: 1 });
  page.on('pageerror', error => console.warn('page error:', error.message));
  await page.goto(`${url.replace(/\/$/, '')}/?mock=ready&avatars=procedural`);
  await page.waitForSelector('canvas', { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__EXTALIA_SOLAR_PREVIEW__ === 'function' && typeof window.__EXTALIA_SET_RENDER_BUDGET__ === 'function', null, { timeout: 90_000 });
  await page.waitForFunction(() => !document.querySelector('.office-loading:not(.done)'), null, { timeout: 120_000 });
  // Full-viewport canvas without the app chrome; HTML overlays are not part of the canvas pixels.
  await page.addStyleTag({ content: 'canvas { display: block; } .capture-stage { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; }' });
  await page.evaluate(minutesOfDay => {
    const canvas = document.querySelector('canvas');
    canvas.parentElement.parentElement.classList.add('capture-stage');
    window.__EXTALIA_SET_RENDER_BUDGET__(0);
    window.__EXTALIA_SOLAR_PREVIEW__(minutesOfDay);
  }, minutes);
  // Let React apply the new size, budget and sky before the clock is taken over.
  await page.waitForTimeout(3000);
  await page.evaluate(async () => {
    const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js');
    const canvas = document.querySelector('canvas');
    const store = _roots.get(canvas).store;
    store.getState().setFrameloop('never');
    window.__splashCapture = { store, canvas };
  });
  return page;
}

/**
 * Steps the scene to time `t` with the camera on its path. Returns the frame as a JPEG data URL
 * and, with `poster`, a 1280x720 WebP of the same frame (Chromium encodes WebP; ffmpeg builds often do not).
 */
async function renderFrame(page, t, pose, read, poster = false) {
  return page.evaluate(async ({ t, pose, read, poster, size }) => {
    const { store, canvas } = window.__splashCapture;
    const state = store.getState();
    const { camera, controls } = state;
    camera.position.set(...pose.position);
    camera.zoom = pose.zoom;
    if (controls) { controls.target.set(...pose.target); }
    camera.lookAt(...pose.target);
    camera.updateProjectionMatrix();
    state.advance(t);
    // Same task as the render, so the drawing buffer still holds this frame.
    if (!read) return null;
    const frame = canvas.toDataURL('image/jpeg', 0.95);
    if (!poster) return { frame };
    const small = document.createElement('canvas');
    small.width = size[0]; small.height = size[1];
    const context = small.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, size[0], size[1]);
    return { frame, poster: small.toDataURL('image/webp', 0.7) };
  }, { t, pose, read, poster, size: [OUT_W, OUT_H] });
}

async function captureVariant(browser, url, name, options, workDir) {
  const variant = VARIANTS[name];
  const page = await preparePage(browser, url, variant.minutes);
  try {
    const step = 1 / options.fps;
    const warmup = 4;
    // Warm-up: daylight and shadow maps settle with the same fixed step the capture uses.
    for (let t = step; t < warmup; t += step) await renderFrame(page, t, poseAt(0, options.seconds), false);
    // --still: only the poster plus quarter-cycle frames (f0000..f0003) to check the framing quickly.
    const total = options.still ? 4 : Math.round((options.seconds + options.fade) * options.fps) + 1;
    const dir = path.join(workDir, name);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < total; i += 1) {
      const time = options.still ? (i * options.seconds) / 4 : i * step;
      const data = await renderFrame(page, warmup + time, poseAt(time, options.seconds), true, i === 0);
      writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), fromDataUrl(data.frame));
      if (data.poster) writeFileSync(path.join(options.out, `office-poster${variant.suffix}.webp`), fromDataUrl(data.poster));
      if (i % options.fps === 0) process.stdout.write(`\r${name}: ${i}/${total} frames`);
    }
    process.stdout.write(`\r${name}: ${total}/${total} frames\n`);
    return dir;
  } finally {
    await page.close().catch(() => {});
  }
}

function encodeVariant(dir, name, options) {
  const { suffix } = VARIANTS[name];
  const loopFrames = Math.round(options.seconds * options.fps);
  const fadeFrames = Math.round(options.fade * options.fps);
  // JPEG frames are full-range BT.601; hardware decoders expect limited-range BT.709 (full-range VP9 failed
  // intermittently in Chromium's hardware decoder).
  const scale = `scale=${OUT_W}:${OUT_H}:flags=lanczos:in_range=pc:out_range=tv:out_color_matrix=bt709`;
  const color = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  const poster = path.join(options.out, `office-poster${suffix}.webp`);
  if (options.still) return [poster];
  const pattern = path.join(dir, 'f%04d.jpg');
  const input = ['-framerate', String(options.fps), '-i', pattern];
  // Output frame k < fade blends frame loop+k (continuing from the last frame) into frame k; the
  // camera path has period `seconds`, so only moving people and props fade, never the view.
  const graph = fadeFrames > 0
    ? `[0:v]split=3[a][b][c];`
      + `[a]trim=start_frame=${loopFrames}:end_frame=${loopFrames + fadeFrames},setpts=PTS-STARTPTS[tail];`
      + `[b]trim=start_frame=0:end_frame=${fadeFrames},setpts=PTS-STARTPTS[head];`
      + `[tail][head]blend=all_expr='A*(1-N/${fadeFrames})+B*(N/${fadeFrames})'[mix];`
      + `[c]trim=start_frame=${fadeFrames}:end_frame=${loopFrames},setpts=PTS-STARTPTS[body];`
      + `[mix][body]concat=n=2:v=1,${scale},format=yuv420p[out]`
    : `[0:v]trim=end_frame=${loopFrames},${scale},format=yuv420p[out]`;
  const webm = path.join(options.out, `office-loop${suffix}.webm`);
  const mp4 = path.join(options.out, `office-loop${suffix}.mp4`);
  // Two-pass average bitrate keeps each file near ENCODE_KBPS * seconds (about 2 MB for 10 s).
  const passlog = path.join(dir, `pass-${name}`);
  const common = [...input, '-filter_complex', graph, '-map', '[out]', '-an', '-g', String(options.fps * 5), ...color];
  const vp9 = ['-c:v', 'libvpx-vp9', '-b:v', `${ENCODE_KBPS}k`, '-deadline', 'good', '-cpu-used', '1', '-row-mt', '1', '-tile-columns', '2', '-passlogfile', passlog];
  ffmpeg([...common, ...vp9, '-pass', '1', '-f', 'null', '-']);
  ffmpeg([...common, ...vp9, '-pass', '2', webm]);
  const h264 = ['-c:v', 'libx264', '-preset', 'slow', '-b:v', `${ENCODE_KBPS}k`, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-passlogfile', passlog];
  ffmpeg([...common, ...h264, '-pass', '1', '-f', 'null', '-']);
  ffmpeg([...common, ...h264, '-pass', '2', mp4]);
  return [webm, mp4, poster];
}

/** A dev-server reload (someone saved a file) destroys the page mid-capture; start that variant over. */
async function withRetry(task, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await task(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      console.warn(`\ncapture interrupted (${error.message.split('\n')[0]}); retrying`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { chromium } = options.encodeOnly ? {} : await loadPlaywright();
  const server = options.url || options.encodeOnly ? { url: options.url, stop() {} } : await startDevServer();
  const gpuArgs = process.platform === 'darwin' ? ['--use-gl=angle', '--use-angle=metal'] : ['--use-gl=angle'];
  const browser = options.encodeOnly ? { close: async () => {} } : await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: [...gpuArgs, '--headless=new'] });
  const workDir = options.frames || mkdtempSync(path.join(tmpdir(), 'extalia-splash-'));
  mkdirSync(options.out, { recursive: true });
  try {
    for (const name of options.variants) {
      const dir = options.encodeOnly ? path.join(workDir, name) : await withRetry(() => captureVariant(browser, server.url, name, options, workDir));
      for (const file of encodeVariant(dir, name, options).filter(existsSync)) console.log(`${path.relative(root, file)}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
    }
  } finally {
    await browser.close();
    server.stop();
    if (!options.frames) rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message ?? error); process.exit(1); });
