#!/usr/bin/env node
/* global window */
/**
 * Office 3D frame-rate benchmark (campus overview and close-ups at day, rush hour and night).
 *
 *   node tooling/bench/office-fps.mjs [--build] [--tier 0|auto] [--seconds 6] [--windows 3] [--lod on|off]
 *     [--only <regexp>] [--breakdown] [--shots <dir>] [--label name] [--url http://127.0.0.1:5399]
 *
 * Builds `apps/web` with `vite build --mode development` into a temporary directory (`--build`, or when no
 * bench build exists yet). That is a production bundle (production React, minified) that keeps the QA hooks
 * (`apps/web/src/office/scene/qaHooks.ts`) and the `?mock=ready` host. It is served with `vite preview` and
 * driven by headless Chrome (ANGLE/Metal on macOS) through Playwright, which is not a repository
 * dependency: set `PLAYWRIGHT_MODULE` to a Playwright `index.mjs` when `import('playwright')` fails, and
 * `CHROME_PATH` for a non-default Chrome.
 *
 * Fixed inputs: 1600×1000 viewport, `?carSeed=20261030`, time preview (day 12:00, rush 17:30 with traffic
 * density pinned to 1, night 21:00), traffic clock pinned, render tier pinned to 0 unless `--tier auto`.
 * Each case warms up, waits (macOS) until other GPU clients are idle, then measures `--windows`
 * back-to-back windows and reports the median and worst window: FPS over the window, per-second FPS
 * median and p5, single-frame median/p5 (vsync-quantised to 60/30/20), renderer.render main-thread ms,
 * GPU ms (`EXT_disjoint_timer_query_webgl2`), draw calls and triangles (both include the periodic
 * shadow pass, averaged per frame). `--lod off` disables the campus-overview level of detail
 * (`environment/overviewLod.ts`) in the same build, for before/after comparisons.
 * `--breakdown` re-measures the rush and night overview with one subsystem hidden at a time.
 *
 * Headless Chrome on macOS can drop into a state where every frame's GPU time is ~4x higher
 * (backgrounded GPU work); the flags below reduce it and a GPU-heavy scene is what triggers it, so the
 * windows are measured continuously and the worst window is reported next to the median.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
const web = path.join(root, 'apps/web');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = option('out', path.join(os.tmpdir(), 'extalia-office-bench-dist'));
const tier = option('tier', '0');
const seconds = Number(option('seconds', '6'));
const port = Number(option('port', '5399'));
const shots = option('shots', '');
const label = option('label', 'run');
const only = option('only', '');
const windows = Number(option('windows', '3'));
const idleWait = Number(option('idle-wait', '30'));
const lod = option('lod', 'on') !== 'off';
const reuse = option('url', '');

if (flag('build') || !existsSync(path.join(outDir, 'index.html'))) {
  const built = spawnSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: web, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

let playwright;
try { playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright'); }
catch { console.error('Playwright not found: set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs'); process.exit(2); }
const chromePath = process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);

const base = reuse || `http://127.0.0.1:${port}`;
const server = reuse ? null : spawn('npx', ['vite', 'preview', '--mode', 'development', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: web, stdio: 'ignore' });
const stop = () => { try { server?.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/`)).ok) break; } catch { /* starting */ } await sleep(250); }

/** macOS: whole-GPU utilisation (all processes) from the IOAccelerator statistics; null elsewhere. */
function gpuUtilisation() {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { encoding: 'utf8' });
  const match = /"Device Utilization %"=(\d+)/.exec(result.stdout ?? '');
  return match ? Number(match[1]) : null;
}
/**
 * Other GPU clients (another browser rendering a 3D scene, Blender) time-slice the GPU and make
 * frame times bimodal. With this page's render loop paused, wait until the GPU is idle.
 */
async function waitForIdleGpu() {
  if (gpuUtilisation() === null) return { idleAfter: 0, busy: null };
  await evaluate(() => window.__EXTALIA_BENCH__.pause(true));
  const started = Date.now();
  let calm = 0, last = 0;
  while (Date.now() - started < idleWait * 1000) {
    last = gpuUtilisation() ?? 0;
    calm = last < 12 ? calm + 1 : 0;
    if (calm >= 3) break;
    await sleep(500);
  }
  await evaluate(() => window.__EXTALIA_BENCH__.pause(false));
  return { idleAfter: Math.round((Date.now() - started) / 1000), busy: calm >= 3 ? null : last };
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--use-gl=angle', '--use-angle=metal', '--headless=new', '--ignore-gpu-blocklist', '--enable-webgl-draft-extensions', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = new Set();
page.on('pageerror', error => errors.add(String(error).slice(0, 200)));
await page.goto(`${base}/?mock=ready&carSeed=20261030`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__EXTALIA_BENCH__ === 'object' && typeof window.__EXTALIA_TRAFFIC_PIN__ === 'function'
  && typeof window.__EXTALIA_SOLAR_PREVIEW__ === 'function' && typeof window.__EXTALIA_SET_RENDER_BUDGET__ === 'function', null, { timeout: 120_000 });
await sleep(8000);
await page.evaluate(level => window.__EXTALIA_SET_RENDER_BUDGET__(level === 'auto' ? null : Number(level)), tier);
await page.evaluate(on => Object.assign(window.__EXTALIA_BENCH__.flags, { detailCull: on, interiorShadows: !on, interiorLiveLights: !on }), lod);

const VIEWS = {
  overview: [[-4, 0, -12], [-33.3, 25.5, -77.4], 11],
  'closeup-road': [[-8, 0, -60], [-14, 12, -24], 40],
  'closeup-entrance': [[0, 1, -22], [-14, 12, -24], 32],
};
const TIMES = { day: [720, undefined], rush: [1050, 1], night: [1260, undefined] };
/** Subsystems hidden one at a time for `--breakdown` (regular expressions over object names). */
const GROUPS = {
  traffic: '^campus-mobility$', skyline: '^campus-skyline$', park: '^civic-forecourt-park$',
  neighborhood: '^campus-neighborhood-backdrop$', landscape: '^extalia-expanded-pedestrian-campus$',
  roofUtilities: '^extalia-model-roof-utilities$', floors: '^furnished-floor-\\d$',
  elevators: '^office-glass-elevators$', characters: '^office-characters$',
};
const evaluate = (fn, arg) => page.evaluate(fn, arg);
const measure = ms => evaluate(ms => window.__EXTALIA_BENCH__.measure(ms), ms);
const results = { label, tier, lod, seconds, windows, cases: {}, breakdown: {} };

async function setCase(view, time) {
  const [target, offset, zoom] = VIEWS[view];
  const [minutes, density] = TIMES[time];
  await evaluate(([target, offset, zoom]) => window.__EXTALIA_BENCH__.camera(target, offset, zoom), [target, offset, zoom]);
  await evaluate(([minutes, density]) => { window.__EXTALIA_SOLAR_PREVIEW__(minutes); window.__EXTALIA_TRAFFIC_PIN__(240, density); }, [minutes, density]);
}

const cases = Object.keys(VIEWS).flatMap(view => Object.keys(TIMES).map(time => [view, time])).filter(([view, time]) => !only || new RegExp(only).test(`${view}-${time}`));
/** One idle-GPU wait, then `windows` back-to-back windows; the summary keeps the median and the worst window. */
async function measureCase() {
  const idle = await waitForIdleGpu();
  await sleep(2500);
  const runs = [];
  for (let i = 0; i < windows; i++) runs.push(await measure(seconds * 1000));
  const sorted = [...runs].sort((a, b) => a.fps - b.fps);
  return { median: sorted[Math.floor((sorted.length - 1) / 2)], worst: sorted[0], idle, windows: runs.map(pick) };
}

for (const [view, time] of cases) {
  await setCase(view, time);
  // Solar colours ease over a few seconds; the adaptive tier needs longer to settle.
  await sleep(tier === 'auto' ? 14_000 : 5000);
  const measured = await measureCase();
  const extra = await evaluate(() => ({ cars: window.__EXTALIA_TRAFFIC__?.().active, budget: window.__EXTALIA_RENDER_BUDGET__?.level }));
  results.cases[`${view}-${time}`] = { ...measured, ...extra };
  if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${label}-${view}-${time}.png`) }); }
  console.error(`${view}-${time}`, JSON.stringify({ median: pick(measured.median), worst: pick(measured.worst), ...extra }));
}

if (flag('breakdown')) {
  for (const time of ['rush', 'night']) {
    await setCase('overview', time);
    await sleep(4000);
    results.breakdown[time] = { all: pick((await measureCase()).median) };
    for (const [name, pattern] of Object.entries(GROUPS)) {
      const hidden = await evaluate(pattern => window.__EXTALIA_BENCH__.toggle(pattern, false), pattern);
      await sleep(1500);
      results.breakdown[time][name] = { hidden, ...pick((await measureCase()).median) };
      await evaluate(pattern => window.__EXTALIA_BENCH__.toggle(pattern, true), pattern);
    }
    await evaluate(() => window.__EXTALIA_BENCH__.shadows(false));
    await sleep(2500);
    results.breakdown[time].noShadows = pick((await measureCase()).median);
    await evaluate(() => window.__EXTALIA_BENCH__.shadows(true));
    await sleep(2500);
    console.error(time, JSON.stringify(results.breakdown[time]));
  }
}
function pick(window) { return { fps: window.fps, secondMedianFps: window.secondMedianFps, secondP5Fps: window.secondP5Fps, frameMedianFps: window.medianFps, frameP5Fps: window.p5Fps, renderMs: window.renderMs, gpuMs: window.gpuMedianMs, calls: window.calls, triangles: window.triangles }; }

results.errors = [...errors].slice(0, 5);
console.log(JSON.stringify(results));
await browser.close();
stop();
process.exit(0);
