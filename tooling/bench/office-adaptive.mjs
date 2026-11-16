#!/usr/bin/env node
/* global window, document, requestAnimationFrame */
/**
 * Real Office adaptive-resolution QA against an already served, frozen QA build.
 *
 * node tooling/bench/office-adaptive.mjs --url http://127.0.0.1:5399 --label before
 *   [--output output/low-spec/before.json] [--cpu 4] [--dpr 2] [--seconds 8]
 *   [--chrome <executable>] [--initial-ceiling 480] [--gpu-policy native|ignore-blocklist]
 *
 * Build with `vite build --mode development` to retain the mock and QA hooks.
 * PLAYWRIGHT_MODULE and CHROME_PATH work as in office-fps.mjs. This driver never
 * builds, starts a host, launches a persistent browser profile or contacts a provider.
 * CPU throttling simulates slower browser main-thread execution; it does not
 * emulate a low-end GPU, memory bandwidth/capacity, thermal limits or whole-device load.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { officeBrowserArgs, officeRendererInfo } from './office-browser.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const options = new Map();
const allowed = new Set(['url', 'label', 'output', 'cpu', 'dpr', 'seconds', 'chrome', 'initial-ceiling', 'gpu-policy']);
for (let index = 0; index < args.length; index++) {
  const key = args[index].replace(/^--/, '');
  if (!args[index].startsWith('--') || !allowed.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Expected --url, --label, --output, --cpu, --dpr, --seconds or --chrome/--initial-ceiling/--gpu-policy followed by a value.');
  }
  options.set(key, args[++index]);
}
const numberOption = (key, fallback, minimum) => {
  const value = Number(options.get(key) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid --${key}.`);
  return value;
};
const cpu = numberOption('cpu', 4, 1);
const dpr = numberOption('dpr', 2, 0.1);
const seconds = numberOption('seconds', 8, 1);
const initialCeiling = options.has('initial-ceiling') ? numberOption('initial-ceiling', 480, Number.MIN_VALUE) : null;
const label = options.get('label') ?? 'run';
const gpuPolicy = options.get('gpu-policy') ?? 'native';
const browserArgs = officeBrowserArgs(process.platform, gpuPolicy);
const url = new URL(options.get('url') ?? 'http://127.0.0.1:5399');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
  throw new Error('--url must be an HTTP loopback QA server without credentials.');
}
url.search = '?mock=ready&observed&carSeed=20261030';
url.hash = '';
const output = options.has('output') ? path.resolve(root, options.get('output')) : null;
if (output && (path.relative(root, output).startsWith('..') || path.isAbsolute(path.relative(root, output)))) {
  throw new Error('--output must be inside the workspace.');
}
let playwright;
try { playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright'); }
catch { throw new Error('Playwright not found: set PLAYWRIGHT_MODULE to its index.mjs.'); }
const chrome = options.get('chrome') ?? process.env.CHROME_PATH
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const startedAt = performance.now();
const phase = name => process.stderr.write(`office-adaptive: ${name} (+${Math.round((performance.now() - startedAt) / 1000)}s)\n`);
const browser = await playwright.chromium.launch({
  executablePath: chrome,
  headless: true,
  args: browserArgs,
});
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: dpr, serviceWorkers: 'block' });
  const blocked = new Set();
  await context.route('**/*', route => {
    const request = new URL(route.request().url());
    if (request.origin === url.origin || ['data:', 'blob:'].includes(request.protocol)) return route.continue();
    blocked.add(request.protocol);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);
  // Browser errors can contain private absolute paths; retain only their class/count.
  const errors = [];
  page.on('pageerror', error => errors.push(error.name || 'Error'));
  const failedRequests = [];
  page.on('response', response => { if (response.status() >= 400) failedRequests.push({ status: response.status(), type: response.request().resourceType() }); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await cdp.send('Performance.enable');
  await page.addInitScript(() => {
    const tasks = [];
    const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    const observer = supported ? new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))) : null;
    observer?.observe({ type: 'longtask', buffered: true });
    window.__EXTALIA_ADAPTIVE_QA__ = {
      begin() { tasks.length = 0; observer?.takeRecords(); return performance.now(); },
      end(started, ended) {
        if (observer) tasks.push(...observer.takeRecords().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
        const durations = tasks.filter(task => task.startTime >= started && task.startTime < ended).map(task => task.duration);
        return { supported, count: supported ? durations.length : null,
          totalMs: supported ? durations.reduce((sum, value) => sum + value, 0) : null,
          maxMs: supported ? Math.max(0, ...durations) : null };
      },
    };
  });
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null;
  };
  const snapshot = () => page.evaluate(() => {
    const renderer = window.__EXTALIA_BENCH__?.renderer;
    const canvas = renderer?.domElement ?? document.querySelector('canvas[data-engine]');
    const bounds = canvas?.getBoundingClientRect();
    const budget = window.__EXTALIA_RENDER_BUDGET__;
    return {
      navigationAgeMs: performance.now(), budget: budget ? { ...budget } : null,
      targetResolutionHeight: budget?.resolutionHeight ?? null,
      rendererDpr: renderer?.getPixelRatio() ?? null, nativeDpr: window.devicePixelRatio,
      canvasCss: bounds ? { width: bounds.width, height: bounds.height } : null,
      canvasBacking: canvas ? { width: canvas.width, height: canvas.height, pixels: canvas.width * canvas.height } : null,
      engine: canvas?.getAttribute('data-engine') ?? null,
    };
  });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  phase('navigated');
  await page.waitForFunction(() => typeof window.__EXTALIA_SET_RENDER_BUDGET__ === 'function'
    && window.__EXTALIA_BENCH__?.renderer && document.querySelector('canvas[data-engine]'), null, { timeout: 120_000 });
  phase('QA hooks');
  const initial = await snapshot();
  const initialShortEdge = initial.canvasBacking ? Math.min(initial.canvasBacking.width, initial.canvasBacking.height) : null;
  const initialCeilingCheck = initialCeiling === null ? null : {
    ceiling: initialCeiling, tolerancePixels: 1, observedShortEdge: initialShortEdge,
    passed: initialShortEdge !== null && initialShortEdge > 0 && initialShortEdge <= initialCeiling + 1,
  };
  if (initialCeilingCheck && !initialCeilingCheck.passed) {
    throw new Error(`Initial canvas short edge ${initialShortEdge ?? 'unavailable'} exceeds --initial-ceiling ${initialCeiling} (+1 pixel tolerance), or no nonzero canvas was observed.`);
  }
  await page.locator('.office-loading').waitFor({ state: 'detached', timeout: 120_000 });
  const ready = await snapshot();
  const rendererAtReady = await page.evaluate(officeRendererInfo);
  phase('ready');
  const autoCamera = page.locator('.topbar-camera button');
  if (await autoCamera.getAttribute('aria-pressed') === 'true') await autoCamera.click();
  await page.locator('[data-view="campus"]').click();
  await page.evaluate(() => {
    window.__EXTALIA_SOLAR_PREVIEW__(720);
    window.__EXTALIA_TRAFFIC_PIN__(240);
    window.__EXTALIA_BENCH__.camera([-4, 0, -12], [-33.3, 25.5, -77.4], 11);
  });
  await page.waitForTimeout(8000);
  phase('warm');
  const runs = [];
  for (let index = 0; index < 3; index++) {
    const before = await snapshot();
    const heapBefore = await heap();
    const measured = await page.evaluate(async ms => {
      const started = window.__EXTALIA_ADAPTIVE_QA__.begin();
      const intervals = [];
      let last = performance.now(), active = true;
      const tick = now => { if (!active) return; intervals.push(now - last); last = now; requestAnimationFrame(tick); };
      requestAnimationFrame(now => { last = now; requestAnimationFrame(tick); });
      const probe = await window.__EXTALIA_BENCH__.measure(ms);
      active = false;
      const ended = performance.now();
      intervals.sort((a, b) => a - b);
      return { probe, intervalMs: ended - started,
        frameP95Ms: intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] ?? null,
        longTasks: window.__EXTALIA_ADAPTIVE_QA__.end(started, ended) };
    }, seconds * 1000);
    runs.push({ index: index + 1, ...measured, before, after: await snapshot(), jsHeapUsedBytes: { before: heapBefore, after: await heap() } });
    phase(`window ${index + 1}`);
  }
  const byFps = [...runs].sort((a, b) => a.probe.fps - b.probe.fps);
  phase('capcheck');
  await page.evaluate(() => window.__EXTALIA_SET_RENDER_BUDGET__(0));
  await page.waitForFunction(() => window.__EXTALIA_RENDER_BUDGET__?.level === 0
    && window.__EXTALIA_RENDER_BUDGET__?.pinned === true, null, { timeout: 15_000 });
  await page.waitForTimeout(1000);
  const highQualityCap = await snapshot();
  const backing = highQualityCap.canvasBacking;
  highQualityCap.within4kPixelCap = backing ? backing.pixels <= 3840 * 2160 : null;
  highQualityCap.within2160ShortEdge = backing ? Math.min(backing.width, backing.height) <= 2160 : null;
  await page.evaluate(() => window.__EXTALIA_SET_RENDER_BUDGET__(null));
  const result = {
    schemaVersion: 1, label, browserVersion: browser.version(),
    environment: { platform: process.platform, headless: true, gpuPolicy, browserArgs, rendererAtReady }, route: url.pathname + url.search,
    scenario: { viewport: { width: 1366, height: 900 }, nativeDpr: dpr, cpuSlowdown: cpu, secondsPerWindow: seconds, windows: 3,
      camera: { target: [-4, 0, -12], offset: [-33.3, 25.5, -77.4], zoom: 11 }, solarMinutes: 720, trafficClock: 240 },
    limitations: [
      'Headless browser results do not certify Electron or physical-device performance.',
      'browserArgs lists harness overrides; Playwright adds its own default launch flags.',
      'A false softwareRendererHint does not prove hardware acceleration; the renderer string may be masked or unfamiliar.',
      'renderMs measures renderer.render submission, not preceding simulation, pose or React work.',
      'CPU throttling simulates browser main-thread slowdown, not a low-end GPU, memory bandwidth/capacity, thermal limits or whole-device load.',
      'Initial is the first QA-hook observation after navigation, not cold-start time or guaranteed first frame; loading/shader work can precede it.',
      'QA builds include renderer instrumentation; GPU timer availability depends on Chrome and its graphics backend.',
      'Resource counts are renderer objects, not allocated GPU bytes; heap readings exclude native/GPU memory and are not forced-GC measurements.',
      'Automatic quality can change within a measurement window; compare its recorded before/after budget and resolution.',
      'Pinned tier 0 is a cap check after timing, not a benchmark; a smaller native display may not reach 2160p.',
    ],
    initial, ...(initialCeilingCheck ? { initialCeilingCheck } : {}), ready, runs, medianWindow: byFps[1].index, worstWindow: byFps[0].index,
    highQualityCap, pageErrors: errors, failedRequests, blockedExternalRequestProtocols: [...blocked],
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, json); }
  process.stdout.write(json);
} finally {
  await browser.close();
}
