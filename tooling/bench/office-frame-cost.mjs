#!/usr/bin/env node
/* global window */
/** Matched real-Office frame-cost matrix. Serve a frozen development-mode build first.
 * --url http://127.0.0.1:5448 --output output/office/frame-cost.json
 * [--views campus,1,2,3,stack] [--times day,night] [--cpu 1,4]
 * [--ratios 1,0.55] [--dpr 1] [--seconds 4] [--windows 2]
 * [--office-load 24] [--uncapped] [--shots output/office/shots]
 * Ratios change only the drawing buffer after pinning scene resources at level2.
 * Uncapped is a diagnostic browser override, never a production application flag.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { officeBrowserArgs, officeRendererInfo } from './office-browser.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2), options = new Map();
const allowed = new Set(['url', 'output', 'views', 'times', 'cpu', 'ratios', 'dpr', 'seconds', 'windows', 'office-load', 'shots', 'label']);
let uncapped = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--uncapped') { uncapped = true; continue; }
  const key = args[i].replace(/^--/, '');
  if (!allowed.has(key) || !args[++i] || args[i].startsWith('--')) throw new Error(`Invalid option ${key}.`);
  options.set(key, args[i]);
}
const list = (key, fallback) => (options.get(key) ?? fallback).split(',');
const numbers = (key, fallback, low, high) => list(key, fallback).map(value => {
  const number = Number(value); if (!Number.isFinite(number) || number < low || number > high) throw new Error(`Invalid ${key}.`); return number;
});
const views = list('views', 'campus,1,2,3,stack'), times = list('times', 'day,night');
if (views.some(value => !['campus', '1', '2', '3', 'stack'].includes(value)) || times.some(value => !['day', 'night'].includes(value))) throw new Error('Invalid view/time.');
const cpus = numbers('cpu', '1', 1, 8), ratios = numbers('ratios', '1', 0.25, 2);
const dpr = numbers('dpr', '1', 0.5, 3)[0], seconds = numbers('seconds', '4', 1, 30)[0];
const windows = numbers('windows', '2', 1, 5)[0]; if (!Number.isInteger(windows)) throw new Error('Invalid windows.');
const officeLoad = options.has('office-load') ? numbers('office-load', '24', 1, 48)[0] : null;
if (officeLoad !== null && !Number.isInteger(officeLoad)) throw new Error('Invalid office-load.');
const inside = value => { const file = path.resolve(root, value), relative = path.relative(root, file); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifacts must be inside the workspace.'); return file; };
const output = inside(options.get('output') ?? 'output/office-frame-cost.json');
const shots = options.has('shots') ? inside(options.get('shots')) : null;
const url = new URL(options.get('url') ?? 'http://127.0.0.1:5448');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Use a credential-free loopback QA build.');
url.searchParams.set('mock', 'ready'); url.searchParams.set('carSeed', '20261030');
if (officeLoad !== null) url.searchParams.set('officeLoad', String(officeLoad));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browserArgs = [...officeBrowserArgs(process.platform), ...(uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true, args: browserArgs });
const timezoneId = 'Asia/Jakarta';
const result = { label: options.get('label') ?? 'run', fixture: { views, times, cpus, ratios, dpr, seconds, windows, officeLoad, timezoneId, sceneResourceLevel: 2 }, environment: { platform: process.platform, browser: browser.version(), browserArgs, uncapped }, limitations: [
  'Fresh nonpersistent mock context; no user profile, provider or external agent is used.',
  'Uncapped results measure diagnostic throughput, not physical display presentation or a shipped browser flag.',
  'CPU throttling does not emulate a low-end GPU, RAM, memory bandwidth, thermal limits or whole Desktop performance.',
  'Drawing-buffer-only trials retain level2 lights/shadows/traffic and camera. GPU timers are used only when available.',
  'Animation continues; fixed mock identities and traffic seed do not make every character pose deterministic.',
], cases: [], errors: [], failedResponses: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr, timezoneId });
  page.on('pageerror', error => result.errors.push(String(error).slice(0, 300)));
  page.on('response', response => { if (response.status() >= 400) result.failedResponses.push({ status: response.status(), type: response.request().resourceType() }); });
  const cdp = await page.context().newCDPSession(page);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__EXTALIA_BENCH__ && window.__EXTALIA_SET_RENDER_BUDGET__, null, { timeout: 120000 });
  await sleep(8000);
  await page.evaluate(() => {
    const dismiss = () => window.document.querySelector('.approval-inbox button[data-autofocus]')?.click();
    dismiss();
    // Mock approvals may arrive after the scene has loaded.
    const observer = new window.MutationObserver(dismiss);
    observer.observe(window.document.body, { childList: true, subtree: true });
  });
  const auto = page.getByRole('button', { name: 'Auto camera', exact: true });
  if (await auto.getAttribute('aria-pressed') === 'true') await auto.click();
  await page.evaluate(() => window.__EXTALIA_SET_RENDER_BUDGET__(2));
  if (officeLoad !== null) await page.waitForFunction(count => { const state = window.__EXTALIA_BENCH__.population?.(); return state && state.admitted === count && state.roster === count && state.arrived === count; }, officeLoad, { timeout: 120000 });
  for (const view of views) {
    await page.locator(`button[data-view="${view}"]`).click();
    await sleep(3000);
    for (const time of times) {
      const minutes = time === 'day' ? 720 : 1260;
      // Re-arm the preview on every view. A control transition may remount it.
      await page.evaluate(minutes => { window.__EXTALIA_SOLAR_PREVIEW__(null); window.__EXTALIA_TRAFFIC_PIN__(240, 1); window.__EXTALIA_SOLAR_PREVIEW__(minutes); }, minutes);
      await sleep(3500);
      const lighting = await page.evaluate(() => window.__EXTALIA_ENV_STATE__?.());
      const night = lighting?.factors?.nightFactor;
      if (typeof night !== 'number' || (time === 'day' ? night > 0.01 : night < 0.99)) throw new Error(`Unexpected lighting for ${view}/${time}.`);
      for (const cpu of cpus) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        for (const ratio of ratios) {
          await page.evaluate(ratio => window.__EXTALIA_BENCH__.renderer.setPixelRatio(ratio), ratio);
          await sleep(1800);
          const selected = await page.locator(`button[data-view="${view}"]`).getAttribute('aria-pressed');
          if (selected !== 'true') throw new Error('View changed during measurement.');
          const metadata = await page.evaluate(officeRendererInfo);
          const scene = await page.evaluate(() => {
            const api = window.__EXTALIA_BENCH__;
            const skeletons = new Set(), boneTextures = new Set(), skinBuffers = new Set();
            let nodes = 0, meshes = 0, skinned = 0, fixedRoots = 0, fixedNodes = 0;
            api.scene.traverse(node => {
              nodes++;
              if (node.isMesh) meshes++;
              const fixed = node.userData.fixedModelTransformCache;
              if (fixed) { fixedRoots++; fixedNodes += fixed.nodes; }
              if (!node.isSkinnedMesh) return;
              skinned++;
              skeletons.add(node.skeleton);
              if (node.skeleton.boneTexture) boneTextures.add(node.skeleton.boneTexture);
              const { index, attributes, morphAttributes } = node.geometry;
              for (const attribute of [index, ...Object.values(attributes), ...Object.values(morphAttributes).flat()]) {
                const array = attribute?.array ?? attribute?.data?.array;
                if (array) skinBuffers.add(array.buffer);
              }
            });
            return { nodes, meshes, skinned, skeletons: skeletons.size, boneTextures: boneTextures.size,
              skinGeometryBytes: [...skinBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
              fixedTransforms: { roots: fixedRoots, nodes: fixedNodes }, population: api.population?.() ?? null,
              batches: api.scene.userData.modelInstanceBatchStats, camera: api.cameraState?.() ?? null };
          });
          const runs = []; for (let n = 0; n < windows; n++) runs.push(await page.evaluate(ms => window.__EXTALIA_BENCH__.measure(ms), seconds * 1000));
          const sorted = [...runs].sort((a, b) => a.fps - b.fps);
          const entry = { view, time, cpu, ratio, metadata, scene, lighting, median: sorted[Math.floor((sorted.length - 1) / 2)], worst: sorted[0], windows: runs };
          result.cases.push(entry); console.error(`${view}/${time} cpu=${cpu} ratio=${ratio}`, JSON.stringify(entry.median));
          if (shots && cpu === cpus[0] && ratio === ratios[0]) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${view}-${time}.png`) }); }
          await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n');
        }
      }
    }
  }
} finally { await browser.close(); }
if (result.errors.length || result.failedResponses.length) process.exitCode = 1;
